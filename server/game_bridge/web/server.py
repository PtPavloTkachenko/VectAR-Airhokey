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


_STARTED_AT = time.time()


def _build_id() -> str:
    """Identifies this server process + this console file."""
    try:
        mtime = (STATIC_DIR / "index.html").stat().st_mtime
    except OSError:
        mtime = 0.0
    return f"{int(_STARTED_AT)}-{int(mtime)}"


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
        self._known = {}          # last identity read over BLE (survives drops)
        # Live authorize progress. Authorizing takes up to a minute (the robot
        # has to handshake with wire-pod before his cert exists), and a single
        # spinner for that long reads as a hang — so publish each stage.
        self._auth = {"active": False, "step": "", "detail": "", "error": ""}

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
            # Give the robot back to himself (he can't free-roam while an SDK
            # client holds behavior control).
            web.post("/api/release", self.api_release),
            # BLE onboarding (Mac-native, Python) — a stock robot from scratch
            web.post("/api/ble/scan", self.api_ble_scan),
            web.post("/api/ble/pair", self.api_ble_pair),
            web.post("/api/ble/pin", self.api_ble_pin),
            web.post("/api/ble/wifi_scan", self.api_ble_wifi_scan),
            web.post("/api/ble/wifi_connect", self.api_ble_wifi_connect),
            web.post("/api/ble/authorize", self.api_ble_authorize),
            web.post("/api/ble/disconnect", self.api_ble_disconnect),
            web.post("/api/ble/state", self.api_ble_state),
            web.post("/api/ble/mark_build_type", self.api_ble_mark_build_type),
            web.post("/api/ble/flash_ep", self.api_ble_flash_ep),
            web.get("/api/ble/flash_status", self.api_ble_flash_status),
            web.post("/api/ble/provision_oskr", self.api_ble_provision_oskr),
            # OSKR the reliable way: accept the OFFICIAL log archive (Save Logs
            # from vector-web-setup.anki.bot), auto-detect the key inside, find
            # the robot on the LAN, provision over SSH. No BLE — Chrome's Web
            # Bluetooth sustains the full log download where our Python one stalls.
            web.post("/api/provision_oskr_archive",
                     self.api_provision_oskr_archive),
            # The robot downloads the escape-pod firmware from here during the
            # stock-provisioning flash (local cache, else proxy archive.org).
            web.get("/api/get_ota/{name}", self.api_get_ota),
            # Is the pairing engine in escape-pod mode? A stock robot cannot
            # be onboarded without it, so the wizard checks before flashing.
            web.get("/api/wirepod_status", self.api_wirepod_status),
            # Whole-chain diagnosis in one call (same as `python -m
            # game_bridge.doctor`), so nobody has to grep the log to find out
            # which link of the chain is down.
            web.get("/api/doctor", self.api_doctor),
            # Live stage of an in-flight authorize, so a 60 s wait for the
            # robot's check-in reads as progress instead of a hang.
            web.get("/api/ble/authorize_status", self.api_authorize_status),
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
        # Never cache the console. The whole app is inline in this one file, so
        # a cached copy means old JavaScript talking to a new server — which
        # looks like the server is broken and survives even a hard reload
        # (no Cache-Control at all lets the browser cache heuristically).
        return web.FileResponse(STATIC_DIR / "index.html", headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        })

    async def api_status(self, req):
        b = self.bridge
        serial, ips, name = config.read_robot_identity()
        # A live link means we're actually receiving telemetry — not just that
        # a (possibly half-open) gRPC object exists. Otherwise the dashboard
        # would keep saying CONNECTED after the robot drops off Wi-Fi / resets.
        # Same definition the connect path uses — they drifted apart once and
        # produced "already connected" on a dead link (see Bridge.robot_alive).
        alive = b.robot_alive
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
            # Changes whenever the console file or the process does; the page
            # watches it and reloads itself, so an edit no longer needs a
            # human to remember to refresh (and can't leave old JavaScript
            # talking to a new server).
            "build": _build_id(),
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

        # Candidates carry WHO they are, not just an address. With more than
        # one robot around, "found a Vector at 192.168.0.194" is a guess the
        # rest of the wizard then acts on -- it minted for one robot and
        # connected to another, and every screen after that blamed the robot.
        cands: list[dict] = []

        def add(ip: str, name: str = "", serial: str = ""):
            ip = (ip or "").strip()
            if ip and not any(c["ip"] == ip for c in cands):
                cands.append({"ip": ip, "name": name, "serial": serial})

        try:
            for r in await discovery.discover(4.0):
                add(r.get("ip", ""), r.get("name", ""), r.get("serial", ""))
        except Exception:
            pass
        _s, ips, _n = config.read_robot_identity()
        for ip in (ips or "").split(","):
            add(ip, _n, _s)

        # Fill in the serial for a robot a LIVE source has named. Never name a
        # robot from his address alone: an address is reused, and a stale entry
        # then christens a stranger. It did exactly that -- a freshly wiped
        # robot (new name, no token) answered a ping on the address the old one
        # used, so the wizard greeted him by the old name and skipped the whole
        # setup as though he were already done.
        for c in cands:
            if c["name"] and not c["serial"]:
                c["serial"] = config.identity_for(name=c["name"]).get("serial", "")

        for c in cands:
            if await port_open(c["ip"]):
                return web.json_response(
                    {"on_wifi": True, "ip": c["ip"], "gateway": True,
                     "name": c["name"], "serial": c["serial"],
                     "identified": bool(c["name"])})
        # reachable but gateway down?
        for c in cands:
            try:
                proc = await _a.create_subprocess_exec(
                    "ping", "-c1", "-W1500", c["ip"],
                    stdout=_a.subprocess.DEVNULL, stderr=_a.subprocess.DEVNULL)
                if await proc.wait() == 0:
                    return web.json_response(
                        {"on_wifi": True, "ip": c["ip"], "gateway": False,
                         "name": c["name"], "serial": c["serial"],
                         "identified": bool(c["name"])})
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
        # Personal cache first, then what ships with the repo (Git LFS), then
        # the Internet Archive. A fresh clone therefore flashes without
        # downloading anything by hand, and without archive.org having to be
        # up -- and the dev-robot repair image isn't on archive.org at all
        # (that URL 404s), so shipping it is the only way it exists for anyone
        # but us.
        for local in (config.OTA_CACHE_DIR / name, config.OTA_REPO_DIR / name):
            if local.is_file() and local.stat().st_size > 1_000_000:
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

    async def api_doctor(self, _req):
        from .. import doctor
        # Probes block (TCP waits, TLS) — keep them off the game loop.
        res = await asyncio.to_thread(doctor.run, self.bridge)
        return web.json_response({"ok": True, **res})

    async def api_wirepod_status(self, req):
        """Escape-pod readiness — probed live, not read from config."""
        pod = req.query.get("pod") or config.WIREPOD_URL
        st = await asyncio.to_thread(pairing.wirepod_status, pod)
        return web.json_response({"ok": True, **st})

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

    async def api_ble_mark_build_type(self, req):
        """The owner tells us what this robot is, when he cannot tell us.

        In recovery he reports no build marker and no ESN, so a dev robot and a
        stock one are genuinely indistinguishable. Guessing costs a rejected
        firmware install; asking costs one click, and we only ever ask once —
        his Bluetooth address survives factory resets.
        """
        if not self._ble:
            return web.json_response(
                {"ok": False, "error": "no BLE session — pair over BLE first"},
                status=409)
        try:
            body = await req.json()
        except Exception:
            body = {}
        kind = body.get("build_type", "")
        if kind not in ("dev", "stock"):
            return web.json_response(
                {"ok": False, "error": "build_type must be 'dev' or 'stock'"},
                status=400)
        esn = getattr(self._ble, "esn", "") or ""
        addr = getattr(getattr(self._ble, "ble", None), "address", "") or ""
        nm = getattr(self._ble, "name", "") or ""
        config.remember_build_type(kind, esn, nm)
        logger.info(f"owner says this robot is {kind} ({addr or esn or '?'})")
        return web.json_response({"ok": True, "build_type": kind,
                                  "remembered_as": addr or esn})

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
        # Flashing `ep` bakes `escapepod.local` into the robot permanently. If
        # wire-pod isn't actually answering to that name with the escape-pod
        # certificate, the robot comes back from a 180 MB flash pointed at
        # nobody — so verify first rather than discover it two steps later.
        pod = body.get("pod") or config.WIREPOD_URL
        ready = await asyncio.to_thread(pairing.wirepod_status, pod)
        if not ready["ready"] and not body.get("force"):
            return web.json_response(
                {"ok": False, "step": "wirepod", "wirepod": ready,
                 "error": "The pairing engine isn't in escape-pod mode, so "
                          f"flashing now would strand the robot. {ready['detail']}"},
                status=409)

        name = body.get("ota") or config.EP_OTA_NAME
        host = _lan_ip() or req.host.split(":")[0]
        url = f"http://{host}:{config.WEB_PORT}/api/get_ota/{name}"

        self._flash = {"active": True, "percent": 0.0, "current": 0,
                       "expected": 0, "done": False, "error": "",
                       "state": "starting"}

        def on_progress(p):
            # Bytes as well as percent: a 180 MB install is a long stare at a
            # number, and "104 of 171 MB, ~2 min left" is the difference
            # between "it's working" and "is it stuck?".
            self._flash.update(percent=round(p["percent"], 1),
                               current=p.get("current", 0),
                               expected=p.get("expected", 0),
                               done=p["done"], state="flashing")

        async def run():
            try:
                await self._ble.ota_flash(url, progress_cb=on_progress)
                self._flash.update(active=False, done=True, percent=100.0,
                                   state="rebooting")
                logger.info("escape-pod firmware flashed — robot rebooting")
            except Exception as e:
                # A 214 rejection is not a failure to work around: it is the
                # robot telling us what he is. His build-type gate only refuses
                # this image because he runs a dev (ankidev/OSKR) build, which
                # his RECOVERY version string cannot say. Record it so he is
                # never offered firmware again, and point at the path he
                # actually needs.
                msg = f"{type(e).__name__}: {e}"
                if "214" in str(e):
                    esn = getattr(self._ble, "esn", "") or ""
                    addr = getattr(getattr(self._ble, "ble", None),
                                   "address", "") or ""
                    nm = getattr(self._ble, "name", "") or ""
                    config.remember_build_type("dev", esn, nm)
                    logger.info(f"recorded as a dev robot (214 gate) {addr}")
                    msg = (
                        "He is a dev (OSKR) robot, so he does not need this "
                        "firmware at all — his own build-type gate refused it "
                        "(214). Restart him out of recovery (hold the backpack "
                        "button ~5 s, then put him on the charger), pair again, "
                        "and this wizard will set him up over SSH instead. He "
                        "is remembered now, so the firmware step won't be "
                        "offered again.")
                self._flash.update(active=False, error=msg, state="failed",
                                   needs_dev_path="214" in str(e))
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

        # Nothing to go on: take his key off him over Bluetooth. A dev robot
        # ships his own private key inside his log bundle, and that bundle is
        # small -- measured on a live unit, 55 KB in 26 s. We used to ask the
        # user to fetch an archive by hand instead, because a progress counter
        # was reading BYTES as packets and made this look like a day's work.
        if not await asyncio.to_thread(prov.ssh_reachable, ip, str(key)):
            self._flash = {"active": True, "percent": 0.0, "done": False,
                           "error": "", "state": "downloading logs"}

            def _logs_progress(p):
                # download_logs emits byte counters (current/total), not frames
                kb = p.get("current", 0) // 1024
                self._flash.update(percent=round(p.get("percent", 0.0), 1),
                                   state=f"downloading logs ({kb} KB)")

            bundle, found = b"", ""
            try:
                bundle = await self._ble.download_logs(
                    progress_cb=_logs_progress,
                    mode=int(body.get("log_mode", 0)),
                    filters=body.get("log_filters") or None)
                found = await asyncio.to_thread(prov.extract_ssh_key, bundle)
            except Exception as e:
                self._flash.update(active=False, state="failed", error=str(e))
                logger.warning(f"BLE log download failed: {e}")
            if not found:
                # Only now is it worth making this the user's problem.
                self._flash.update(active=False, state="")
                why = ("his logs came down but carry no SSH key"
                       if bundle else
                       "his logs wouldn't come down over Bluetooth")
                return web.json_response(
                    {"ok": False, "step": "ssh_key", "needs_key": True,
                     "error": f"Vector is a dev (OSKR) robot and {why}. Drop "
                              "his log archive below (the official app's Save "
                              "Logs), or paste his key if you have it."})
            key = await asyncio.to_thread(
                prov.save_ssh_key, found, config.ROBOT_SSH_KEY)
            logger.info(f"recovered Vector's SSH key from his logs -> {key}")
            if not await asyncio.to_thread(prov.ssh_reachable, ip, str(key)):
                return web.json_response(
                    {"ok": False, "step": "ssh_key",
                     "error": "Recovered a key from Vector's logs but he still "
                              "refuses it. Is sshd running and is this the same "
                              "robot?"})

        # 2) point his cloud at wire-pod and carry him through to SDK control.
        # BLE is dropped first: the reboot would kill the link anyway, and the
        # mint needs the gRPC path, not this one.
        await self._drop_ble()
        return web.json_response(
            await self._finish_oskr(ip, str(key), body.get("pod", "")))

    async def _finish_oskr(self, ip: str, key: str, pod: str = "") -> dict:
        """Repoint a dev robot and carry him all the way to SDK control.

        Both dev routes (a live BLE session, or his log archive) end here, and
        they end on the same code the terminal runs. Stopping at "provisioned,
        rebooting" was its own trap: the robot came back pointed at the right
        place with no token, which every later screen reported as some other
        problem.
        """
        from onboarding import oskr_setup

        # Both dev screens poll flash_status, so progress has to land there.
        # This step can run for two minutes across his reboot; a spinner with
        # nothing behind it is indistinguishable from a hang.
        self._flash = {"active": True, "percent": 0.0, "done": False,
                       "error": "", "state": "setting him up"}

        def log(msg: str):
            self._set_auth("provision", msg)
            self._flash.update(state=msg.strip() or "setting him up")

        try:
            res = await asyncio.to_thread(
                oskr_setup.setup, ip, key, pod or config.WIREPOD_URL,
                "auto", False, log)
        except SystemExit as e:
            self._flash.update(active=False, state="failed", error=str(e))
            return {"ok": False, "step": "provision", "error": str(e)}
        except Exception as e:
            self._flash.update(active=False, state="failed", error=str(e))
            return {"ok": False, "step": "provision",
                    "error": f"{type(e).__name__}: {e}"}
        finally:
            self._flash["active"] = False

        if res.get("verified"):
            msg = (f"{res['name']} is set up and answering — open the "
                   "Dashboard and play.")
        else:
            msg = (f"{res['name']} is set up and has his key, but hasn't "
                   "answered yet. He is often a few seconds behind; open the "
                   "Dashboard and press CONNECT ROBOT.")
        return {"ok": True, "ip": res.get("ip", ip), "name": res.get("name", ""),
                "serial": res.get("serial", ""),
                "verified": bool(res.get("verified")), "message": msg}

    async def api_provision_oskr_archive(self, req):
        """Set up an OSKR robot from his OFFICIAL log archive — the public path.

        The user downloads his logs with the official Vector setup web app
        (vector-web-setup.anki.bot -> Save Logs, a .tar.bz2), then drops that
        file here. We detect the SSH key inside it, find the robot on the LAN by
        the name in the archive, and point his cloud at wire-pod over SSH.

        This is the FALLBACK. The BLE route takes his key off him in about half
        a minute with nothing to download by hand, and is what the wizard tries
        first; this path is for a robot who won't hand his logs over, or an
        owner who already has the key.
        """
        from onboarding import oskr_provision as prov
        try:
            reader = await req.multipart()
        except Exception:
            return web.json_response(
                {"ok": False, "error": "expected a file upload"}, status=400)
        archive = b""
        pasted_key = ""
        ip = ""
        async for part in reader:
            if part.name == "archive":
                archive = await part.read(decode=False)
            elif part.name == "ssh_key":
                pasted_key = (await part.text()).strip()
            elif part.name == "ip":
                ip = (await part.text()).strip()

        # A pasted key is used verbatim; otherwise detect it inside the archive.
        robot_code = None
        if pasted_key and "PRIVATE KEY" in pasted_key:
            key_text = pasted_key
        elif archive:
            logger.info(f"OSKR archive upload: {len(archive)} bytes")
            key_text, robot_code = await asyncio.to_thread(
                prov.extract_key_and_name, archive)
            if not key_text:
                return web.json_response(
                    {"ok": False, "step": "archive",
                     "error": "No SSH key found inside that archive. In the "
                              "official Vector setup app, pair THIS robot and use "
                              "'Save Logs' — the download is a .tar.bz2 that holds "
                              "data/ssh/id_rsa_Vector-XXXX."})
        else:
            return web.json_response(
                {"ok": False, "error": "no archive file or key received"},
                status=400)
        key = await asyncio.to_thread(
            prov.save_ssh_key, key_text, config.ROBOT_SSH_KEY)
        logger.info(f"detected SSH key in archive (robot={robot_code})")

        # find his IP: explicit field > live BLE session > mDNS by archive name
        if not ip and self._ble:
            try:
                ip = (await self._ble.wifi_ip() or "").strip()
            except Exception:
                pass
        if not ip:
            try:
                robots = await discovery.discover(timeout=5.0)
            except Exception:
                robots = []
            if robot_code:
                code = robot_code.lower()
                for r in robots:
                    norm = r["name"].lower().replace(" ", "").replace("-", "")
                    if code in norm:
                        ip = r["ip"]
                        break
            if not ip and len(robots) == 1:
                ip = robots[0]["ip"]
        if not ip:
            # mDNS came up empty (repeater/mesh eats multicast). We hold his key,
            # so just scan the LAN for the host that accepts it — that IS him.
            logger.info("mDNS empty — scanning LAN for the host that takes the key")
            ip = await asyncio.to_thread(prov.find_robot_ip, str(key))
        if not ip:
            return web.json_response(
                {"ok": False, "step": "ip", "needs_ip": True,
                 "error": "Got the key from the archive, but couldn't find Vector "
                          "on the network — not over mDNS, and no host on this "
                          "Wi-Fi accepted his key. Make sure he's powered on and "
                          "on the same network, or enter his IP (in the "
                          "Spectacles/Vector phone app, or your router)."})

        if not await asyncio.to_thread(prov.ssh_reachable, ip, str(key)):
            return web.json_response(
                {"ok": False, "step": "ssh",
                 "error": f"Found the key and Vector at {ip}, but he refused it. "
                          "Is this the same robot the archive came from? (his "
                          "name and key both change after a factory reset.)"})
        return web.json_response(await self._finish_oskr(ip, str(key)))

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
        b.link_paused = False   # an explicit connect cancels a manual release
        ok = await b.connect_robot()

        # Two failed presses in a row is the signature of a robot whose
        # gateway needs a power cycle (it answers the network but stalls every
        # authenticated call). Rather than let someone press a button that
        # can't work, say so on the second try. Your idea, 2026-07-25.
        if ok:
            self._connect_fails = 0
        else:
            self._connect_fails = getattr(self, "_connect_fails", 0) + 1
            if self._connect_fails >= 2 and \
                    getattr(b, "last_link_hint_kind", "") != "cert_rotated":
                b.last_link_hint_kind = "needs_reboot"
                b.last_link_hint = (
                    "Two tries in a row didn't get through. Restart Vector "
                    "once — hold his backpack button ~5 s until he switches "
                    "off, then put him back on the charger. A robot that has "
                    "just been set up often needs one power cycle before his "
                    "control channel answers.")

        # Always say WHY on failure. This used to return a bare {"ok": false},
        # and the dashboard only rendered an error when `error` was present —
        # so CONNECT ROBOT looked like a dead button for the whole 40 s the
        # attempt actually took. The link already classifies the cause
        # (unreachable / cert_rotated / needs_reboot); pass it through.
        return web.json_response({
            "ok": ok,
            "kind": "" if ok else (getattr(b, "last_link_hint_kind", "") or ""),
            "error": None if ok else (
                getattr(b, "last_link_hint", "")
                or "Couldn't reach Vector. Is he awake and on the same Wi-Fi?"),
        })

    async def api_release(self, _req):
        """Hand the robot back to himself, without stopping the server.

        Vector grants behavior control to one client, so while we hold it he
        can't do his own thing — no roaming, no reacting, and he won't return
        to the charger on his own. Releasing is also how you free him for
        another SDK client. `link_paused` keeps the link watchdog from
        immediately grabbing him again; CONNECT ROBOT clears it.
        """
        b = self.bridge
        b.link_paused = True
        # The pose pump has no stop(): it lives on robot-state events, so
        # tearing the link down is what ends it. Dropping the reference after
        # is enough.
        try:
            if b.link:
                await b.link.disconnect()
        except Exception as e:
            logger.warning(f"release: {e}")
        b.link = None
        b.pump = None
        b.commander = None
        b.last_link_hint = ("Control released — Vector is on his own. Press "
                            "CONNECT ROBOT to take him back.")
        b.last_link_hint_kind = "released"
        logger.info("control released — robot handed back to himself")
        return web.json_response({"ok": True})

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
            # Judge him by whether he actually got an address, not by the code
            # he answers with. Asking once, immediately, called it a failure
            # while his face was still showing the Wi-Fi screen and he was
            # mid-connect -- so the wizard told people to restart a robot who
            # was about to succeed. Association plus DHCP takes a while,
            # especially on the first join after a wipe.
            ip = ""
            deadline = time.monotonic() + float(body.get("wait", 45.0))
            while True:
                try:
                    ip = (await self._ble.wifi_ip() or "").strip()
                except Exception as e:
                    logger.debug(f"wifi_ip poll: {e}")
                if ip and ip != "0.0.0.0":
                    break
                if time.monotonic() >= deadline:
                    break
                self._flash.update(state="waiting for Wi-Fi")
                await asyncio.sleep(2.0)

            if ip and ip != "0.0.0.0":
                return web.json_response({"ok": True, "result": res, "ip": ip})
            code = res.get("result")
            return web.json_response(
                {"ok": False, "result": res, "ip": "",
                 "error": "Vector took the password but never got an address "
                          f"(status {code}). Usually the password is wrong, or "
                          "it's a 5 GHz-only network — he is 2.4 GHz. His face "
                          "shows the Wi-Fi screen while he tries, so give him "
                          "a moment and press CONNECT again before restarting "
                          "him."})
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

    def _set_auth(self, step: str, detail: str, error: str = "") -> None:
        """Publish what authorize is doing right now (polled by the wizard)."""
        self._auth = {"active": not error, "step": step, "detail": detail,
                      "error": error}
        if detail:
            logger.debug(f"authorize[{step}] {detail}")

    async def api_authorize_status(self, _req):
        return web.json_response({"ok": True, **self._auth})

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
        self._set_auth("start", "Starting…")

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
            # Remember who this is: BLE drops (robot reboot, retry, a failed
            # authorize) and without this a second press lands on "we don't
            # know which Vector this is" even though we read his serial a
            # minute ago. Seen live, 2026-07-25.
            if esn:
                self._known = {"esn": esn, "ip": ip, "name": name}

            # THE step that makes wire-pod hold a certificate for this robot.
            # A Vector never contacts its token server on its own — vic-cloud
            # does primary auth only when asked, and the ask is this BLE
            # message (wire-pod's own `do_auth`, ble.go:450). Without it the
            # robot sits on Wi-Fi talking to nobody and `/session-certs/<esn>`
            # stays 404 forever, which reads as "wire-pod is broken" when in
            # fact nothing ever triggered the handshake.
            # Verified missing on the live stock robot, 2026-07-25.
            cloud_err = ""
            for attempt in range(1, 4):
                self._set_auth("cloud", "Asking Vector to sign in to the "
                               f"pairing engine (try {attempt}/3)…")
                try:
                    await self._ble.cloud_auth()
                    logger.info("robot cloud-authed against wire-pod "
                                f"(attempt {attempt})")
                    cloud_err = ""
                    break
                except Exception as e:
                    cloud_err = f"{type(e).__name__}: {e}"
                    logger.warning(f"cloud auth attempt {attempt}/3 failed: {e}")
                    await asyncio.sleep(2.0)
            if cloud_err:
                # Not fatal on its own: an already-provisioned robot has a cert
                # from an earlier run, so let the cert poll below decide.
                logger.warning(f"cloud auth did not succeed: {cloud_err}")

            # Leave the robot's own setup flow. A freshly flashed Vector sits
            # on the "download the Vector app" screen until something sends
            # this — the app normally does. Needs the guid that cloud_auth
            # just returned, so it has to happen here, before we drop BLE.
            self._set_auth("onboarding", "Getting Vector out of his own setup "
                           "screen…")
            try:
                await self._ble.onboard_complete()
                logger.info("robot onboarding marked complete")
            except Exception as e:
                logger.warning(f"could not finish the robot's onboarding: {e}")

            await self._drop_ble()      # release BLE so the mint's gRPC can run
        else:
            known = getattr(self, "_known", {})
            esn = (body.get("serial") or os.getenv("VECTOR_SERIAL", "")
                   or cfg_serial or known.get("esn", ""))
            ip = (body.get("ip", "") or (cfg_ips.split(",")[0] if cfg_ips else "")
                  or known.get("ip", ""))
            name = body.get("name", "") or known.get("name", "")

        # The robot's session cert only exists once HE has handshaked with
        # wire-pod, which trails the Wi-Fi step. Poll for it (default 60 s)
        # instead of failing on the first miss — that race was the usual
        # "cert does not exist" dead end on a freshly onboarded robot.
        cert_wait = float(body.get("cert_wait", 60.0))

        minted = False
        if esn and ip:
            def on_wait(waited: float):
                left = max(0, int(cert_wait - waited))
                self._set_auth(
                    "cert", "Waiting for Vector to check in with the pairing "
                    f"engine — this is normal, up to {left}s left…")

            self._set_auth("cert", "Waiting for Vector to check in with the "
                           "pairing engine…")
            try:
                await asyncio.to_thread(pairing.pair, pod, esn, name, ip,
                                        cert_wait, on_wait)
                self._set_auth("mint", "Minting this Mac's key…")
                minted = True
            except pairing.PairingError as e:
                if not self._is_provisioned():
                    # An unprovisioned robot fails the mint because wire-pod has
                    # no cert for it — that's a setup problem, not a user error.
                    ready = await asyncio.to_thread(pairing.wirepod_status, pod)
                    return web.json_response(
                        {"ok": False, "step": e.step, "needs_setup": True,
                         "wirepod": ready, "error": e.message})
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
