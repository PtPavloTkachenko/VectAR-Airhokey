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
            web.post("/api/find_robot", self.api_find_robot),
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
            web.post("/api/ble/state", self.api_ble_state),
            web.post("/api/ble/flash_ep", self.api_ble_flash_ep),
            web.get("/api/ble/flash_status", self.api_ble_flash_status),
            web.post("/api/ble/provision_oskr", self.api_ble_provision_oskr),
            # The robot downloads the escape-pod firmware from here during the
            # stock-provisioning flash (local cache, else proxy archive.org).
            web.get("/api/get_ota/{name}", self.api_get_ota),
            # static assets (onboarding illustrations, icons)
            web.static("/static", STATIC_DIR),
        ])
        self._flash = {"active": False, "percent": 0.0, "done": False,
                       "error": "", "state": ""}
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
            # Why the link is down, if it is — so the dashboard can show an
            # actionable reason ("cert rotated -> re-pair") instead of OFFLINE.
            # Held on the bridge because a failed connect tears self.link down.
            "link_hint": (getattr(b, "last_link_hint", "") or "")
            if not alive else "",
            "link_hint_kind": (getattr(b, "last_link_hint_kind", "") or "")
            if not alive else "",
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
            "lens": {"connected": b.ws.alive, "role": b.ws.client_role,
                     "on_screen": b.ws.client_role == "screen"},
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
            "lens": b.ws.alive,
            "lens_role": b.ws.client_role,
        })

    async def api_find_robot(self, _req):
        """Is a Vector already on Wi-Fi? Progressive onboarding uses this to
        SKIP the Bluetooth/Wi-Fi steps when the robot is already online.

        Returns {on_wifi, ip, gateway} — gateway=True means its SDK port :443
        is up (ready to authorize + drive); False means it's on Wi-Fi but the
        gateway hasn't started yet (freshly reset, still checking in)."""
        import asyncio as _a

        async def port_open(ip: str, port: int = 443, t: float = 2.0) -> bool:
            try:
                fut = _a.open_connection(ip, port)
                r, w = await _a.wait_for(fut, timeout=t)
                w.close()
                return True
            except Exception:
                return False

        # candidate IPs: mDNS + env override + last-known from sdk_config
        cands: list[str] = []
        try:
            for r in await discovery.discover(4.0):
                if r.get("ip"):
                    cands.append(r["ip"])
        except Exception:
            pass
        _s, ips, _n = config.read_robot_identity()
        for ip in (ips or "").split(","):
            if ip.strip() and ip.strip() not in cands:
                cands.append(ip.strip())
        for ip in cands:
            if await port_open(ip):
                return web.json_response(
                    {"on_wifi": True, "ip": ip, "gateway": True})
        # reachable but gateway down?
        for ip in cands:
            try:
                proc = await _a.create_subprocess_exec(
                    "ping", "-c1", "-W1500", ip,
                    stdout=_a.subprocess.DEVNULL, stderr=_a.subprocess.DEVNULL)
                if await proc.wait() == 0:
                    return web.json_response(
                        {"on_wifi": True, "ip": ip, "gateway": False})
            except Exception:
                pass
        return web.json_response({"on_wifi": False})

    async def api_discover(self, req):
        try:
            body = await req.json()
        except Exception:
            body = {}
        timeout = float(body.get("timeout", 5.0))
        robots = await discovery.discover(min(timeout, 15.0))
        return web.json_response({"robots": robots})

    # ---- stock-robot provisioning: escape-pod firmware over BLE -------------
    # A plain stock Vector points its cloud at ddl.io and can never reach
    # wire-pod. Flashing the escape-pod ("ep") firmware bakes
    # server_config -> escapepod.local into the robot, after which it finds
    # wire-pod over mDNS on ANY Wi-Fi. This is the step wire-pod does and our
    # onboarding used to skip. OSKR/dev robots don't need it (SSH path).

    async def api_get_ota(self, req):
        """Serve the OTA the robot downloads during the flash.

        Prefers a local cache (works offline / fast on LAN); otherwise streams
        it from the Internet Archive, the same source upstream wire-pod uses.
        """
        name = req.match_info["name"]
        if "/" in name or ".." in name or not name.endswith(".ota"):
            return web.Response(status=400, text="bad ota name")
        local = config.OTA_CACHE_DIR / name
        if local.is_file():
            return web.FileResponse(local)
        import aiohttp
        url = f"https://archive.org/download/vector-pod-firmware/{name}"
        resp = web.StreamResponse()
        resp.content_type = "application/octet-stream"
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.get(url) as up:
                    if up.status != 200:
                        return web.Response(status=502,
                                            text=f"upstream {up.status}")
                    if up.content_length:
                        resp.content_length = up.content_length
                    await resp.prepare(req)
                    async for chunk in up.content.iter_chunked(64 * 1024):
                        await resp.write(chunk)
            await resp.write_eof()
            return resp
        except Exception as e:
            logger.warning(f"get_ota proxy failed: {e}")
            return web.Response(status=502, text=f"proxy failed: {e}")

    async def api_ble_state(self, req):
        """Which provisioning path this robot needs (stock / OSKR / already-ep)."""
        if not self._ble:
            return web.json_response(
                {"ok": False, "error": "no BLE session — pair over BLE first"},
                status=409)
        try:
            st = await self._ble.robot_state()
            return web.json_response({"ok": True, **st})
        except Exception as e:
            return web.json_response(
                {"ok": False, "error": f"{type(e).__name__}: {e}"}, status=500)

    async def api_ble_flash_ep(self, req):
        """Flash the escape-pod firmware over the live BLE session."""
        if not self._ble:
            return web.json_response(
                {"ok": False, "error": "no BLE session — pair over BLE first"},
                status=409)
        if self._flash["active"]:
            return web.json_response(
                {"ok": False, "error": "a flash is already running"}, status=409)
        try:
            body = await req.json()
        except Exception:
            body = {}
        name = body.get("ota") or config.EP_OTA_NAME
        host = _lan_ip() or req.host.split(":")[0]
        url = f"http://{host}:{config.WEB_PORT}/api/get_ota/{name}"

        self._flash = {"active": True, "percent": 0.0, "done": False,
                       "error": "", "state": "starting"}

        def on_progress(p):
            self._flash.update(percent=round(p["percent"], 1),
                               done=p["done"], state="flashing")

        async def run():
            try:
                await self._ble.ota_flash(url, progress_cb=on_progress)
                self._flash.update(active=False, done=True, percent=100.0,
                                   state="rebooting")
                logger.info("escape-pod firmware flashed — robot rebooting")
            except Exception as e:
                self._flash.update(active=False, error=f"{type(e).__name__}: {e}",
                                   state="failed")
                logger.warning(f"ep flash failed: {e}")

        asyncio.create_task(run())
        return web.json_response({"ok": True, "url": url, "started": True})

    async def api_ble_flash_status(self, req):
        return web.json_response({"ok": True, **self._flash})

    async def api_ble_provision_oskr(self, req):
        """One-button OSKR provisioning — no terminal, no second BLE connect.

        Reuses the wizard's LIVE BLE session (opening a second one races
        CoreBluetooth and the robot's short advertising window) to install our
        SSH key, then writes the cloud config over SSH and reboots. After this
        the robot talks to wire-pod on any Wi-Fi, exactly like a stock robot
        that got the escape-pod firmware.
        """
        if not self._ble:
            return web.json_response(
                {"ok": False, "error": "no BLE session — pair over BLE first"},
                status=409)
        try:
            body = await req.json()
        except Exception:
            body = {}
        ip = (body.get("ip") or getattr(self._ble, "ip", "") or "").strip()
        if not ip:
            # We land here straight after the PIN, before the Wi-Fi step, so the
            # IP isn't cached yet — but the BLE channel can just ask the robot.
            try:
                ip = (await self._ble.wifi_ip() or "").strip()
            except Exception as e:
                logger.debug(f"wifi_ip over BLE failed: {e}")
        if not ip:
            return web.json_response(
                {"ok": False, "error": "Vector isn't on Wi-Fi yet — finish the "
                                       "Wi-Fi step, then set him up."},
                status=400)

        from onboarding import oskr_provision as prov
        key = config.ensure_ssh_key()
        pub = config.ssh_public_key()

        # 1) We need SSH. Adding a key over BLE is not possible (RtsSshRequest
        # is in the CLAD schema but nothing implements it), and an ankidev robot
        # can't take the production escape-pod image either. The supported route
        # is the one OSKR owners have always used: the robot generates its own
        # keypair in /data/ssh and ships the private half inside its log bundle,
        # which we CAN pull over BLE. A Clear User Data wipe just means it made
        # a fresh one.
        # An OSKR owner already HAS a key — that's what makes the unit OSKR — so
        # accepting theirs is by far the fastest route, and it's what upstream
        # wire-pod asks for too. Try that before the slow log scrape.
        supplied = (body.get("ssh_key") or "").strip()
        if supplied and not await asyncio.to_thread(
                prov.ssh_reachable, ip, str(key)):
            if "PRIVATE KEY" not in supplied:
                return web.json_response(
                    {"ok": False, "step": "ssh_key", "needs_key": True,
                     "error": "That doesn't look like an SSH private key — it "
                              "should start with '-----BEGIN ... PRIVATE KEY'."})
            key = await asyncio.to_thread(
                prov.save_ssh_key, supplied, config.ROBOT_SSH_KEY)
            if not await asyncio.to_thread(prov.ssh_reachable, ip, str(key)):
                return web.json_response(
                    {"ok": False, "step": "ssh_key", "needs_key": True,
                     "error": "Vector refused that key. Is it this robot's key? "
                              "(his name changes after a factory reset, so an "
                              "older key won't match)"})

        # Nothing to go on: offer the key box first, and only scrape the logs
        # when explicitly asked — the full bundle is ~149k BLE packets.
        if not await asyncio.to_thread(prov.ssh_reachable, ip, str(key)):
            if not body.get("try_logs"):
                return web.json_response(
                    {"ok": False, "step": "ssh_key", "needs_key": True,
                     "error": "This Mac has no SSH access to Vector yet. Paste "
                              "his SSH private key (OSKR owners have one), or "
                              "let us pull it from his logs over Bluetooth — "
                              "that works but is slow."})
            self._flash = {"active": True, "percent": 0.0, "done": False,
                           "error": "", "state": "downloading logs"}

            def _logs_progress(p):
                # download_logs emits byte counters (current/total), not frames
                kb = p.get("current", 0) // 1024
                self._flash.update(percent=round(p.get("percent", 0.0), 1),
                                   state=f"downloading logs ({kb} KB)")

            try:
                bundle = await self._ble.download_logs(
                    progress_cb=_logs_progress,
                    mode=int(body.get("log_mode", 0)),
                    filters=body.get("log_filters") or None)
            except Exception as e:
                self._flash.update(active=False, state="failed", error=str(e))
                return web.json_response(
                    {"ok": False, "step": "logs",
                     "error": f"could not download Vector's logs over "
                              f"Bluetooth ({e}). They carry his SSH key, which "
                              "is how a dev robot grants access."})
            found = await asyncio.to_thread(prov.extract_ssh_key, bundle)
            if not found:
                return web.json_response(
                    {"ok": False, "step": "logs",
                     "error": "Vector's logs downloaded, but they contain no "
                              "SSH private key — this build may not ship one in "
                              "/data/ssh."})
            key = await asyncio.to_thread(
                prov.save_ssh_key, found, config.ROBOT_SSH_KEY)
            logger.info(f"recovered Vector's SSH key from his logs -> {key}")
            if not await asyncio.to_thread(prov.ssh_reachable, ip, str(key)):
                return web.json_response(
                    {"ok": False, "step": "ssh_key",
                     "error": "Recovered a key from Vector's logs but he still "
                              "refuses it. Is sshd running and is this the same "
                              "robot?"})

        # 2) point the robot's cloud at wire-pod, then reboot
        try:
            await asyncio.to_thread(prov.provision, ip, str(key),
                                    body.get("host_mode", "escapepod"), True)
        except SystemExit as e:
            return web.json_response({"ok": False, "step": "provision",
                                      "error": str(e)})
        except Exception as e:
            return web.json_response(
                {"ok": False, "step": "provision",
                 "error": f"{type(e).__name__}: {e}"})
        return web.json_response(
            {"ok": True, "ip": ip,
             "message": "Cloud pointed at wire-pod. Vector is rebooting "
                        "(~40 s), then pairing will complete."})

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
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})
        # PIN is confirmed once the encrypted channel is up. Reading status is
        # best-effort — a hiccup here must not fail the whole pairing.
        st = None
        try:
            st = await self._ble.status()
        except Exception:
            pass
        return web.json_response({"ok": True, "status": st})

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

    def _is_provisioned(self) -> bool:
        """sdk_config.ini has a section with a real guid (not just an env serial)."""
        import configparser
        try:
            c = configparser.ConfigParser(strict=False)
            c.read(config.SDK_CONFIG_PATH)
            return any(c[s].get("guid") for s in c.sections())
        except Exception:
            return False

    async def api_ble_authorize(self, req):
        """One authorize used by the whole progressive flow.

        Gathers the robot's identity from whichever source we have — a live
        BLE session (fresh onboarding), or the on-Wi-Fi shortcut (found IP), or
        env/sdk_config — mints a fresh SDK token via the token engine, then
        connects the game loop. Falls back to just connecting if the robot is
        already provisioned and the mint can't run."""
        import os
        b = self.bridge
        try:
            body = await req.json()
        except Exception:
            body = {}
        pod = body.get("pod") or config.WIREPOD_URL

        cfg_serial, cfg_ips, _n = config.read_robot_identity()
        if self._ble is not None:
            esn = self._ble.esn or body.get("serial") or os.getenv("VECTOR_SERIAL", "") or cfg_serial
            ip = self._ble.ip
            if not ip:
                try:
                    ip = await self._ble.wifi_ip()
                except Exception:
                    ip = ""
            name = (self._ble.name or "").replace(" ", "-")
            await self._drop_ble()      # release BLE so the mint's gRPC can run
        else:
            esn = body.get("serial") or os.getenv("VECTOR_SERIAL", "") or cfg_serial
            ip = body.get("ip", "") or (cfg_ips.split(",")[0] if cfg_ips else "")
            name = body.get("name", "")

        minted = False
        if esn and ip:
            try:
                await asyncio.to_thread(pairing.pair, pod, esn, name, ip)
                minted = True
            except pairing.PairingError as e:
                if not self._is_provisioned():
                    # An unprovisioned robot fails the mint because wire-pod has
                    # no cert for it — that's a setup problem, not a user error.
                    return web.json_response(
                        {"ok": False, "step": e.step, "needs_setup": True,
                         "error": e.message})
                # already provisioned -> mint optional, fall through to connect
            except Exception as e:
                if not self._is_provisioned():
                    return web.json_response({"ok": False, "error": str(e)})

        if not self._is_provisioned() and not minted:
            # Two different causes, and blaming Wi-Fi (the old message) was
            # wrong in both. `needs_setup` lets the UI offer the fix without
            # pattern-matching English.
            if not esn:
                return web.json_response(
                    {"ok": False, "needs_setup": True, "step": "identify",
                     "error": "We don't know which Vector this is yet — connect "
                              "over Bluetooth once so we can read his serial."})
            return web.json_response(
                {"ok": False, "needs_setup": True, "step": "provision",
                 "error": "This Vector isn't set up for wire-pod yet, so he "
                          "can't be authorized. Set him up once over Bluetooth."})

        if not b.use_robot:
            return web.json_response(
                {"ok": True, "minted": minted, "connected": False,
                 "note": "Credentials ready; restart the server without "
                         "--no-robot to drive the robot."})
        ok = await b.connect_robot()
        return web.json_response(
            {"ok": True, "minted": minted, "connected": ok,
             "error": None if ok else "Minted, but couldn't reach the robot's "
                      "control port yet — it may still be finishing activation."})

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
