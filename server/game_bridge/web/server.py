"""Embedded web UI (aiohttp on the Bridge's own event loop).

Serves the single-page pairing wizard + status dashboard and a small JSON
API. Heavy/blocking work (pairing gRPC, SDK test connect) runs in
asyncio.to_thread so the game loop never stalls.
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from aiohttp import web

from .. import config
from . import discovery, pairing

logger = logging.getLogger("game-bridge.web")

STATIC_DIR = Path(__file__).parent / "static"


def _lan_ip() -> str:
    """This machine's LAN address (no traffic is sent — UDP connect only
    selects the outbound interface)."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return ""
    finally:
        s.close()


class WebUI:
    def __init__(self, bridge):
        self.bridge = bridge
        self._runner: web.AppRunner | None = None
        self._pair_lock = asyncio.Lock()
        self._ble_lock = asyncio.Lock()
        self._ble = None          # live RtsSession during onboarding

        app = web.Application()
        app.add_routes([
            web.get("/", self.index),
            web.get("/api/status", self.api_status),
            web.get("/api/game", self.api_game),
            web.post("/api/discover", self.api_discover),
            web.post("/api/pair", self.api_pair),
            web.post("/api/test", self.api_test),
            web.post("/api/connect", self.api_connect),
            # BLE onboarding (Mac-native, Python) — a stock robot from scratch
            web.post("/api/ble/scan", self.api_ble_scan),
            web.post("/api/ble/pair", self.api_ble_pair),
            web.post("/api/ble/pin", self.api_ble_pin),
            web.post("/api/ble/wifi_scan", self.api_ble_wifi_scan),
            web.post("/api/ble/wifi_connect", self.api_ble_wifi_connect),
            web.post("/api/ble/authorize", self.api_ble_authorize),
            web.post("/api/ble/disconnect", self.api_ble_disconnect),
        ])
        self.app = app

    async def start(self):
        self._runner = web.AppRunner(self.app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, config.WEB_HOST, config.WEB_PORT)
        await site.start()
        logger.info(f"Web UI on http://localhost:{config.WEB_PORT} "
                    "(pairing wizard + dashboard)")

    async def stop(self):
        if self._runner:
            await self._runner.cleanup()
            self._runner = None

    # --- handlers ---

    async def index(self, _req):
        return web.FileResponse(STATIC_DIR / "index.html")

    async def api_status(self, req):
        b = self.bridge
        serial, ips, name = config.read_robot_identity()
        # A live link means we're actually receiving telemetry — not just that
        # a (possibly half-open) gRPC object exists. Otherwise the dashboard
        # would keep saying CONNECTED after the robot drops off Wi-Fi / resets.
        alive = bool(b.link and b.link.robot and b.pump
                     and getattr(b.pump, "fresh", False))
        robot = {
            "paired": bool(serial),
            "serial": serial,
            "name": name,
            "ip": ips.split(",")[0] if ips else "",
            "connected": alive,
            "has_control": alive and bool(b.link and b.link.has_control),
            "battery_pct": None,
            "batt_v": None,
            "pose": None,
            "busy": b.commander.busy if b.commander else "idle",
        }
        v = getattr(b, "batt_v", None) if alive else None
        if b.pump and alive:
            snap = dict(b.pump.snapshot)
            v = snap.get("batt_v") or v
            if b.transform.bound:
                fx, fy, fdeg = b.transform.robot_to_field(
                    snap.get("x", 0.0), snap.get("y", 0.0), snap.get("deg", 0.0))
                robot["pose"] = {"x": round(fx), "y": round(fy),
                                 "deg": round(fdeg)}
            robot["pose_fresh"] = bool(getattr(b.pump, "fresh", False))
        if v:
            robot["batt_v"] = round(v, 2)
            robot["battery_pct"] = int(
                max(0.0, min(1.0, (v - 3.6) / 0.5)) * 100)
            robot["charging"] = getattr(b, "batt_charging", False)
        # the exact string the player pastes into the lens' GameConfig.WS_URL
        lan_ip = _lan_ip() or req.host.split(":")[0]
        return web.json_response({
            "server": {
                "ws_port": config.WS_PORT,
                "web_port": config.WEB_PORT,
                "mock_pose": b.mock_pose,
                "use_robot": b.use_robot,
                "chat": config.VECTAR_CHAT,
                "ws_url": f"ws://{lan_ip}:{config.WS_PORT}",
                "time": time.time(),
            },
            "robot": robot,
            "lens": {"connected": b.ws.client is not None},
            "game": {
                "rally_active": b.rally_active,
                "transform_bound": b.transform.bound,
                "score": getattr(b, "last_score", [0, 0]),
                "puck": ({"x": round(b.latest_puck.x), "y": round(b.latest_puck.y)}
                         if getattr(b, "latest_puck", None) else None),
                "robot": robot.get("pose"),
                "field": {
                    "l": config.FIELD_L, "w": config.FIELD_W,
                    "goalie_x": config.GOALIE_X, "puck_r": config.PUCK_R,
                    "body_r": config.VECTOR_BODY_R,
                },
            },
            "wirepod_default": config.WIREPOD_URL,
        })

    async def api_game(self, _req):
        """Lightweight top-down game state for the dashboard mini-field —
        polled fast so the puck + robot move smoothly."""
        b = self.bridge
        pose = None
        if b.pump and getattr(b.pump, "fresh", False) and b.transform.bound:
            snap = dict(b.pump.snapshot)
            fx, fy, fdeg = b.transform.robot_to_field(
                snap.get("x", 0.0), snap.get("y", 0.0), snap.get("deg", 0.0))
            pose = {"x": round(fx), "y": round(fy), "deg": round(fdeg),
                    "drv": 1 if b.driving else 0}
        return web.json_response({
            "field": {"l": config.FIELD_L, "w": config.FIELD_W,
                      "goalie_x": config.GOALIE_X, "puck_r": config.PUCK_R,
                      "body_r": config.VECTOR_BODY_R,
                      "y_range": config.GOALIE_Y_RANGE},
            "robot": pose,
            "puck": ({"x": round(b.latest_puck.x), "y": round(b.latest_puck.y)}
                     if getattr(b, "latest_puck", None) else None),
            "score": getattr(b, "last_score", [0, 0]),
            "rally": b.rally_active,
            "lens": b.ws.client is not None,
        })

    async def api_discover(self, req):
        try:
            body = await req.json()
        except Exception:
            body = {}
        timeout = float(body.get("timeout", 5.0))
        robots = await discovery.discover(min(timeout, 15.0))
        return web.json_response({"robots": robots})

    async def api_pair(self, req):
        body = await req.json()
        if self._pair_lock.locked():
            return web.json_response(
                {"ok": False, "step": "cert",
                 "error": "A pairing attempt is already running."}, status=409)
        async with self._pair_lock:
            try:
                result = await asyncio.to_thread(
                    pairing.pair,
                    body.get("pod") or config.WIREPOD_URL,
                    body.get("serial", ""),
                    body.get("name", ""),
                    body.get("ip", ""))
                return web.json_response({"ok": True, **result})
            except pairing.PairingError as e:
                return web.json_response(
                    {"ok": False, "step": e.step, "error": e.message})
            except Exception as e:
                logger.exception("pairing failed unexpectedly")
                return web.json_response(
                    {"ok": False, "step": "cert",
                     "error": f"Unexpected error: {type(e).__name__}: {e}"})

    async def api_test(self, req):
        b = self.bridge
        # ONE gRPC control client at a time: if the Bridge already holds the
        # robot, report from the live link instead of opening a second one.
        if b.link and b.link.robot:
            snap = dict(b.pump.snapshot) if b.pump else {}
            return web.json_response({
                "ok": True, "via": "live",
                "battery": {"volts": round(snap.get("batt_v") or 0.0, 2)},
                "has_control": b.link.has_control,
            })
        try:
            body = await req.json()
        except Exception:
            body = {}
        try:
            result = await asyncio.to_thread(
                pairing.test_connection, body.get("serial", ""))
            result["via"] = "probe"
            return web.json_response(result)
        except pairing.PairingError as e:
            return web.json_response(
                {"ok": False, "step": e.step, "error": e.message})

    async def api_connect(self, _req):
        b = self.bridge
        if not b.use_robot:
            return web.json_response(
                {"ok": False,
                 "error": "Server started with --no-robot / --mock-pose."})
        ok = await b.connect_robot()
        return web.json_response({"ok": ok})

    # --- BLE onboarding (a stock robot, from scratch) ---

    async def api_ble_scan(self, req):
        from onboarding.ble.session import RtsSession
        try:
            body = await req.json()
        except Exception:
            body = {}
        timeout = float(body.get("timeout", 5.0))
        try:
            robots = await RtsSession.scan(min(timeout, 12.0))
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})
        return web.json_response({"ok": True, "robots": robots})

    async def api_ble_pair(self, req):
        """Connect + handshake up to the PIN. Robot then shows a 6-digit PIN."""
        from onboarding.ble import session as bse
        body = await req.json()
        addr = body.get("address")
        name = body.get("name")
        if not addr:
            return web.json_response({"ok": False, "error": "address required"})
        if self._ble_lock.locked():
            return web.json_response(
                {"ok": False, "error": "onboarding already in progress"}, status=409)
        async with self._ble_lock:
            await self._drop_ble()
            try:
                self._ble = await bse.pair_begin(addr, name)
                return web.json_response({"ok": True, "needs_pin": True})
            except Exception as e:
                await self._drop_ble()
                return web.json_response({"ok": False, "error": str(e)})

    async def api_ble_pin(self, req):
        body = await req.json()
        pin = (body.get("pin") or "").strip()
        if self._ble is None:
            return web.json_response({"ok": False, "error": "not paired yet"})
        try:
            await self._ble.finish_handshake(pin)
            st = await self._ble.status()
            return web.json_response({"ok": True, "status": st})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    async def api_ble_wifi_scan(self, _req):
        if self._ble is None:
            return web.json_response({"ok": False, "error": "not paired"})
        try:
            nets = await self._ble.wifi_scan()
            return web.json_response({"ok": True, "networks": nets})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    async def api_ble_wifi_connect(self, req):
        body = await req.json()
        if self._ble is None:
            return web.json_response({"ok": False, "error": "not paired"})
        try:
            res = await self._ble.wifi_connect(
                body["ssid"], body.get("password", ""),
                int(body.get("auth", 6)), bool(body.get("hidden", False)))
            ip = ""
            if res.get("result") == 0:
                try:
                    ip = await self._ble.wifi_ip()
                except Exception:
                    pass
            return web.json_response({"ok": res.get("result") == 0,
                                      "result": res, "ip": ip})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    async def api_ble_authorize(self, req):
        """After BLE onboarding, authorize the game server for this robot.

        If a BLE session is live we MINT a fresh SDK token using the ESN + IP
        we read over Bluetooth (no typing) — this covers a from-scratch or
        just-reset robot whose old token is gone. If there's no BLE session
        but sdk_config already has this robot, we just connect."""
        b = self.bridge
        try:
            body = await req.json()
        except Exception:
            body = {}
        pod = body.get("pod") or config.WIREPOD_URL

        # Path A: fresh from BLE onboarding -> mint with the BLE-read identity
        if self._ble is not None and getattr(self._ble, "esn", ""):
            esn = self._ble.esn
            ip = self._ble.ip
            try:
                if not ip:
                    ip = await self._ble.wifi_ip()
            except Exception:
                pass
            name = (self._ble.name or "").replace(" ", "-")
            await self._drop_ble()      # release BLE so the mint's gRPC can run
            if not ip:
                return web.json_response(
                    {"ok": False, "error": "Could not read Vector's IP over "
                     "Bluetooth — make sure Wi-Fi connected, then retry."})
            try:
                await asyncio.to_thread(pairing.pair, pod, esn, name, ip)
            except pairing.PairingError as e:
                return web.json_response(
                    {"ok": False, "step": e.step, "error": e.message})
            except Exception as e:
                return web.json_response({"ok": False, "error": str(e)})
            ok = await b.connect_robot() if b.use_robot else False
            return web.json_response({"ok": True, "minted": True,
                                      "connected": ok})

        # Path B: no BLE session, but the robot is already provisioned
        serial, _ips, _name = config.read_robot_identity()
        if serial:
            if b.use_robot:
                ok = await b.connect_robot()
                return web.json_response(
                    {"ok": ok, "connected": ok,
                     "error": None if ok else "Robot reachable? Same Wi-Fi?"})
            return web.json_response(
                {"ok": True, "connected": False,
                 "note": "Credentials ready. Restart the server without "
                         "--no-robot to drive the robot."})
        return web.json_response(
            {"ok": False,
             "error": "No robot to authorize — run the Bluetooth setup first."})

    async def api_ble_disconnect(self, _req):
        await self._drop_ble()
        return web.json_response({"ok": True})

    async def _drop_ble(self):
        if self._ble is not None:
            try:
                await self._ble.disconnect()
            except Exception:
                pass
            self._ble = None
