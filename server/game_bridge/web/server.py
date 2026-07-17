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


class WebUI:
    def __init__(self, bridge):
        self.bridge = bridge
        self._runner: web.AppRunner | None = None
        self._pair_lock = asyncio.Lock()

        app = web.Application()
        app.add_routes([
            web.get("/", self.index),
            web.get("/api/status", self.api_status),
            web.post("/api/discover", self.api_discover),
            web.post("/api/pair", self.api_pair),
            web.post("/api/test", self.api_test),
            web.post("/api/connect", self.api_connect),
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

    async def api_status(self, _req):
        b = self.bridge
        serial, ips, name = config.read_robot_identity()
        robot = {
            "paired": bool(serial),
            "serial": serial,
            "name": name,
            "ip": ips.split(",")[0] if ips else "",
            "connected": bool(b.link and b.link.robot),
            "has_control": bool(b.link and b.link.has_control),
            "battery_pct": None,
            "batt_v": None,
            "pose": None,
            "busy": b.commander.busy if b.commander else "idle",
        }
        if b.pump:
            snap = dict(b.pump.snapshot)
            if snap.get("batt_v"):
                v = snap["batt_v"]
                robot["batt_v"] = round(v, 2)
                robot["battery_pct"] = int(
                    max(0.0, min(1.0, (v - 3.6) / 0.5)) * 100)
            if b.transform.bound:
                fx, fy, fdeg = b.transform.robot_to_field(
                    snap.get("x", 0.0), snap.get("y", 0.0), snap.get("deg", 0.0))
                robot["pose"] = {"x": round(fx), "y": round(fy),
                                 "deg": round(fdeg)}
            robot["pose_fresh"] = bool(getattr(b.pump, "fresh", False))
        return web.json_response({
            "server": {
                "ws_port": config.WS_PORT,
                "web_port": config.WEB_PORT,
                "mock_pose": b.mock_pose,
                "use_robot": b.use_robot,
                "chat": config.VECTAR_CHAT,
                "time": time.time(),
            },
            "robot": robot,
            "lens": {"connected": b.ws.client is not None},
            "game": {
                "rally_active": b.rally_active,
                "transform_bound": b.transform.bound,
            },
            "wirepod_default": config.WIREPOD_URL,
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
