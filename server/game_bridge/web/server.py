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


def prefer_active(cands: list[dict], active: str) -> list[dict]:
    """Put the robot this Mac is set to play with at the front of the search.

    In place, and stable — everyone else keeps their discovery order.

    With two robots awake, "found a Vector" is otherwise whoever answered
    quickest, and the whole wizard then acts on a robot the owner never chose.
    """
    active = (active or "").strip().lower()
    if active:
        cands.sort(key=lambda c: (c.get("serial") or "").strip().lower() != active)
    return cands


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
            web.get("/api/health", self.api_health),
            web.get("/api/game", self.api_game),
            web.post("/api/find_robot", self.api_find_robot),
            web.post("/api/discover", self.api_discover),
            # The fleet. More than one robot can be set up on this Mac; the
            # console is where you say which of them the game — and therefore
            # the Lens — is playing against. The Lens itself never chooses.
            web.get("/api/robots", self.api_robots),
            web.post("/api/robots/select", self.api_robots_select),
            web.post("/api/robots/forget", self.api_robots_forget),
            web.post("/api/pair", self.api_pair),
            web.post("/api/official/pair", self.api_official_pair),
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
            # Can this Mac reach the robot at the address he just got? Asked
            # BEFORE authorize, because the alternative is waiting a minute
            # for a handshake that was never going to arrive.
            web.post("/api/ble/reachable", self.api_ble_reachable),
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
                       "error": "", "state": "", "mode": "", "ota": ""}
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

    # --- the fleet ---

    def _held_serial(self) -> str:
        """Serial of the robot the bridge is actually holding right now."""
        link = getattr(self.bridge, "link", None)
        return (getattr(link, "serial", "") or "").strip().lower()

    async def api_robots(self, _req):
        """Every robot this Mac holds credentials for.

        Exactly one carries `lens: true` — that is the robot the game drives
        and the one the Lens sees. The Lens never picks: it takes whoever the
        server hands it, which is what keeps it a display-and-input bridge
        with no decisions of its own. Choosing lives here.
        """
        b = self.bridge
        held, alive = self._held_serial(), b.robot_alive
        robots = config.list_robots()
        for r in robots:
            # Today "the robot the game uses" and "the robot the Lens gets"
            # are the same robot, because the game is air-hockey and it has
            # one goalie. When a two-robot experience arrives this is the
            # field that stops being a mirror of `active`.
            r["lens"] = r["active"]
            r["connected"] = bool(alive and held == r["serial"].lower())
            r["has_control"] = bool(
                r["connected"] and b.link and b.link.has_control)
        return web.json_response({"ok": True, "robots": robots,
                                  "use_robot": b.use_robot})

    async def api_robots_select(self, req):
        """Hand a different robot to the game.

        A robot that is already set up must NEVER be sent back through
        onboarding just to be used again — switching is bookkeeping plus a
        connect. That is the whole handler.
        """
        try:
            body = await req.json()
        except Exception:
            body = {}
        serial = (body.get("serial") or "").strip().lower()
        b = self.bridge
        if not config.set_active_robot(serial):
            return web.json_response(
                {"ok": False,
                 "error": "This Mac holds no credentials for that robot."},
                status=404)
        # Let go of whoever we were holding first. Vector grants behavior
        # control to one client, so a robot we keep is a robot that stands
        # still — he can't roam and he won't take himself back to the charger.
        if b.link and self._held_serial() != serial:
            await b.drop_link()
        b.link_paused = False   # choosing a robot is asking for him
        if not b.use_robot:
            return web.json_response({"ok": True, "serial": serial,
                                      "connected": False, "error": ""})
        ok = await b.connect_robot()
        # Selection succeeded either way: the choice is recorded and survives.
        # Whether he answered is a separate fact, and the console says so
        # rather than presenting a silent robot as a failed switch.
        return web.json_response({
            "ok": True,
            "serial": serial,
            "connected": ok,
            "kind": "" if ok else (getattr(b, "last_link_hint_kind", "") or ""),
            "error": "" if ok else (
                getattr(b, "last_link_hint", "")
                or "Switched, but he isn't answering. Is he awake and on this Wi-Fi?"),
        })

    async def api_robots_forget(self, req):
        """Drop a robot's credentials from this Mac.

        This throws away his certificate and control token — the robot himself
        is untouched and still points at the pairing engine, so adding him back
        is the wizard's short path (authorize), not the whole setup again.
        """
        try:
            body = await req.json()
        except Exception:
            body = {}
        serial = (body.get("serial") or "").strip().lower()
        b = self.bridge
        if self._held_serial() == serial and b.link:
            # Hand him back before erasing the credential we're holding him
            # with, or he stays under our control with nothing left to
            # release him.
            await b.drop_link()
        if not config.forget_robot(serial):
            return web.json_response(
                {"ok": False,
                 "error": "This Mac holds no credentials for that robot."},
                status=404)
        logger.info(f"forgot robot {serial} (credentials dropped on this Mac)")
        # Whoever is left inherits the game. The link watchdog would find him
        # within 15 s anyway; reaching now just means the console doesn't sit
        # on OFFLINE for a quarter minute after a deletion.
        if b.use_robot and config.list_robots():
            b.link_paused = False
            asyncio.create_task(b.connect_robot())
        return web.json_response({"ok": True, "robots": config.list_robots()})

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
        # one robot around, "found a Vector at 10.0.0.7" is a guess the
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

        fleet = config.list_robots()
        prefer_active(cands, fleet[0]["serial"] if fleet else "")

        async def cert_here(serial: str) -> bool:
            """Does THIS pairing engine already hold his session certificate?

            It is the whole question behind "can he be authorized without the
            Bluetooth setup" — that short path only exists for a robot this
            engine has onboarded before. Asking costs one request and no wait,
            and not asking is what let the wizard offer a button that could
            not work: press it and you spend 60 s polling for a certificate
            nobody will ever write, ending at an error about the engine.
            """
            if not serial:
                return False
            try:
                return bool(await asyncio.to_thread(
                    pairing.fetch_cert, config.WIREPOD_URL, serial))
            except Exception:
                return False

        for c in cands:
            if await port_open(c["ip"]):
                return web.json_response(
                    {"on_wifi": True, "ip": c["ip"], "gateway": True,
                     "name": c["name"], "serial": c["serial"],
                     "identified": bool(c["name"]),
                     "cert_here": await cert_here(c["serial"])})
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
                         "identified": bool(c["name"]),
                         "cert_here": await cert_here(c["serial"])})
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
        it from the public mirrors, the first one that has it.
        """
        name = req.match_info["name"]
        if "/" in name or ".." in name or not name.endswith(".ota"):
            return web.Response(status=400, text="bad ota name")
        # Personal cache first, then what ships with the repo (Git LFS), then
        # the network. A fresh clone therefore flashes without downloading
        # anything by hand, and without any mirror having to be up -- and the
        # dev-robot repair image is on no mirror at all, so shipping it is the
        # only way it exists for anyone but us.
        for local in (config.OTA_CACHE_DIR / name, config.OTA_REPO_DIR / name):
            if local.is_file() and local.stat().st_size > 1_000_000:
                return web.FileResponse(local)
        import aiohttp
        # No mirror carries every image: archive.org has the escape-pod one and
        # 404s on plain production builds, the DDL mirror is the other way
        # round. Ask each in turn and stream the first that answers, so
        # flashing and un-flashing both work without the caller knowing which
        # host to name.
        resp = web.StreamResponse()
        resp.content_type = "application/octet-stream"
        tried = []
        try:
            async with aiohttp.ClientSession() as sess:
                for tmpl in config.OTA_MIRRORS:
                    url = tmpl.format(name=name)
                    try:
                        up = await sess.get(url)
                    except Exception as e:
                        tried.append(f"{url} -> {type(e).__name__}")
                        continue
                    async with up:
                        if up.status != 200:
                            tried.append(f"{url} -> {up.status}")
                            continue
                        logger.info(f"streaming {name} from {url}")
                        if up.content_length:
                            resp.content_length = up.content_length
                        await resp.prepare(req)
                        async for chunk in up.content.iter_chunked(64 * 1024):
                            await resp.write(chunk)
                        await resp.write_eof()
                        return resp
            # Once prepare() has been called the response is already on the
            # wire, so this only reports mirrors that never got that far.
            logger.warning(f"get_ota: no mirror has {name}: {'; '.join(tried)}")
            return web.Response(
                status=502,
                text=f"no mirror has {name} — tried: {'; '.join(tried)}")
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
        """Install firmware over the live BLE session.

        Two directions, one mechanism. `mode: "ep"` (the default) installs the
        escape-pod image and is the setup step. `mode: "revert"` installs plain
        production firmware, undoing it — see docs/SETUP_ROBOT.md, "Going back
        to stock". They differ in which image, which guard, and how a refusal
        is read, so the mode is explicit rather than inferred from the name.
        """
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
        mode = "revert" if body.get("mode") == "revert" else "ep"

        if mode == "ep":
            # Flashing `ep` bakes `escapepod.local` into the robot permanently.
            # If wire-pod isn't actually answering to that name with the
            # escape-pod certificate, the robot comes back from a 180 MB flash
            # pointed at nobody — so verify first rather than discover it two
            # steps later.
            pod = body.get("pod") or config.WIREPOD_URL
            ready = await asyncio.to_thread(pairing.wirepod_status, pod)
            if not ready["ready"] and not body.get("force"):
                return web.json_response(
                    {"ok": False, "step": "wirepod", "wirepod": ready,
                     "error": "The pairing engine isn't in escape-pod mode, so "
                              f"flashing now would strand the robot. {ready['detail']}"},
                    status=409)
        # Reverting deliberately does NOT check that guard. It exists to stop a
        # robot being pointed at a name nobody answers to, and the whole point
        # here is that he stops needing that name at all — requiring the engine
        # to be healthy before you can walk away from it is backwards.

        # He downloads the image HIMSELF, over Wi-Fi, from this Mac — Bluetooth
        # only carries the URL. So a robot with no network cannot install
        # anything, and the refusal comes back as a bare status code with
        # nothing about the network in it. Recovery is where this bites: it is
        # a separate minimal system that does not inherit his Wi-Fi, and a
        # factory reset has cleared it besides, so "he was online yesterday"
        # tells you nothing about the session you are in.
        # Only a robot who ANSWERS that he has no address is blocked. Failing
        # to ask is not evidence of anything, and turning "we could not tell"
        # into a refusal would stop installs that would have worked.
        asked = False
        robot_ip = ""
        try:
            robot_ip = await self._ble.wifi_ip()
            asked = True
        except Exception as e:
            logger.debug(f"could not read the robot's address: {e}")
            robot_ip = getattr(self._ble, "ip", "") or ""
        if asked and not robot_ip and not body.get("force"):
            return web.json_response(
                {"ok": False, "step": "wifi", "needs_wifi": True,
                 "error": "He has no Wi-Fi in this session, and he downloads "
                          "the firmware himself — there is nothing for him to "
                          "download from. Join him to a network first (the "
                          "Wi-Fi step), then install. In recovery this is "
                          "always needed: it does not inherit the network he "
                          "had before."},
                status=409)

        default_name = config.STOCK_OTA_NAME if mode == "revert" \
            else config.EP_OTA_NAME
        name = body.get("ota") or default_name
        host = _lan_ip() or req.host.split(":")[0]
        url = f"http://{host}:{config.WEB_PORT}/api/get_ota/{name}"

        self._flash = {"active": True, "percent": 0.0, "current": 0,
                       "expected": 0, "done": False, "error": "",
                       "state": "starting", "mode": mode, "ota": name}

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
                logger.info(f"{mode} firmware flashed — robot rebooting")
            except Exception as e:
                msg = f"{type(e).__name__}: {e}"
                gate_214 = "214" in str(e)
                # The same rejection means opposite things in the two
                # directions, so only the setup direction may act on it.
                if gate_214 and mode == "ep":
                    # Not a failure to work around: it is the robot telling us
                    # what he is. His build-type gate only refuses this image
                    # because he runs a dev (ankidev/OSKR) build, which his
                    # RECOVERY version string cannot say. Record it so he is
                    # never offered firmware again, and point at the path he
                    # actually needs.
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
                elif gate_214:
                    # Reverting: he is already known to be a stock robot, so
                    # this says nothing about his build type and must not be
                    # recorded as if it did. It means this particular image is
                    # one he won't take.
                    msg = (
                        f"He refused this image on his own build-type gate "
                        f"(214). That is about the image, not about him — he "
                        f"is still the stock robot you set up. Try a different "
                        f"production build (any plain vicos-2.0.1.*.ota from "
                        f"vectorfirmware.ddlbot.ai/vicos/, dropped in "
                        f"{config.OTA_CACHE_DIR}). He is unchanged and still "
                        f"on the escape-pod firmware.")
                self._flash.update(active=False, error=msg, state="failed",
                                   needs_dev_path=gate_214 and mode == "ep")
                logger.warning(f"{mode} flash failed: {e}")

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
            # "He still has to sign in" is not an error the owner can act on by
            # reading it -- it is one physical step. Flag it so the wizard can
            # just ask for that step instead of explaining certificates.
            msg = str(e)
            if "sign in" in msg or "certificate" in msg:
                return {"ok": False, "step": "signin", "needs_signin": True,
                        "error": "Almost there — he needs to say hello to the "
                                 "pairing engine once. Double-press his "
                                 "backpack button and enter the PIN from his "
                                 "face; that finishes it."}
            return {"ok": False, "step": "provision", "error": msg}
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

    async def api_official_pair(self, req):
        """Credentials from DDL's cloud instead of from our pairing engine.

        For a robot set up their way: no firmware, no engine, nothing on this
        network to keep running. What lands on disk afterwards is the same
        `sdk_config.ini` the wire-pod path writes, so everything downstream —
        connecting, the game, the dashboard — cannot tell the two apart.
        """
        from . import official
        body = await req.json()
        if self._pair_lock.locked():
            return web.json_response(
                {"ok": False, "step": "account",
                 "error": "A pairing attempt is already running."}, status=409)
        cfg_serial, cfg_ips, cfg_name = config.read_robot_identity()
        serial = (body.get("serial") or cfg_serial or "").strip()
        name = (body.get("name") or cfg_name or "").strip()
        ip = (body.get("ip") or (cfg_ips.split(",")[0] if cfg_ips else "")).strip()
        if not (serial and name and ip):
            # Their web tool knows all three and this does not, so say which
            # is missing rather than failing three steps later on an empty
            # string. FIND ROBOT fills in the name and address.
            missing = [n for n, v in (("serial", serial), ("name", name),
                                      ("address", ip)) if not v]
            return web.json_response(
                {"ok": False, "step": "account",
                 "error": "Still need his " + ", ".join(missing) +
                          ". Press FIND ROBOT, or read the serial off his "
                          "underside (ESN)."})
        async with self._pair_lock:
            try:
                result = await asyncio.to_thread(
                    official.pair, body.get("email", ""),
                    body.get("password", ""), serial, name, ip)
                return web.json_response({"ok": True, **result})
            except pairing.PairingError as e:
                return web.json_response(
                    {"ok": False, "step": e.step, "error": e.message})
            except Exception as e:
                logger.exception("official pairing failed unexpectedly")
                return web.json_response(
                    {"ok": False, "step": "account",
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
        # tearing the link down is what ends it.
        await b.drop_link()
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

    async def api_ble_reachable(self, req):
        """Preflight for the authorize step: can we reach him at all?

        The token handshake travels over the network, not over Bluetooth, so a
        robot who is online and pairing happily can still be unreachable —
        which is exactly what a guest Wi-Fi produces. Asking here turns a
        60-second wait ending in "he never knocked" into a warning before the
        button is pressed, with the fix attached.
        """
        body = await req.json() if req.can_read_body else {}
        ip = (body.get("ip") or "").strip()
        if not ip and self._ble is not None:
            ip = getattr(self._ble, "ip", "") or ""
        if not ip:
            return web.json_response({"ok": True, "known": False})
        why = await asyncio.to_thread(self._why_he_never_knocked, ip)
        # A reachable robot produces the "worth retrying" line, which is advice
        # for a failure that has not happened — not a warning.
        blocking = bool(why) and "retrying" not in why
        return web.json_response({"ok": True, "known": True, "ip": ip,
                                  "blocking": blocking, "detail": why})

    def _why_he_never_knocked(self, robot_ip: str) -> str:
        """Measure the network after the robot failed to reach the engine.

        "He has not completed his handshake" is true and useless on its own —
        it names the symptom and leaves the reader to guess between a sleeping
        robot, a wrong network, and an access point that quietly refuses to
        let its clients talk to each other. The third one is invisible: both
        devices are online, both have addresses on the same subnet, and
        everything looks correct right up until nothing arrives.

        So probe once, here, where it matters, and say what came back.
        """
        from .. import netinfo
        if not robot_ip:
            return ""
        here = netinfo.lan_ip()
        if netinfo.same_subnet(here, robot_ip) is False:
            return (f"He is on {robot_ip} and this Mac is on {here} — "
                    f"different networks, so he cannot reach it at all. Put "
                    f"both on the same one (JOIN A DIFFERENT NETWORK).")
        rtt = netinfo.rtt_ms(robot_ip, count=2)
        from ..robot.sdk.connection import _tcp_open
        open443 = _tcp_open(robot_ip, tries=2)
        if rtt is None and not open443:
            # Same subnet, addresses agree, and still nothing gets through:
            # the signature of client isolation, which guest and corporate
            # Wi-Fi enable by default and which pairing cannot work around.
            return (f"He is on {robot_ip}, the same network as this Mac, yet "
                    f"nothing reaches him — no ping, no port 443. That is a "
                    f"Wi-Fi that blocks devices from talking to each other "
                    f"(usual on guest and corporate networks). Pairing cannot "
                    f"work there: use a phone hotspot for both.")
        if rtt is not None and rtt > netinfo.LAN_RTT_CEILING_MS:
            return (f"He answers in {rtt:.0f} ms on a local network, which "
                    f"means the traffic is being relayed — typical of guest "
                    f"Wi-Fi, which usually also blocks the device-to-device "
                    f"traffic pairing needs. Try a phone hotspot for both.")
        if open443:
            return (f"He is reachable at {robot_ip}, so the network is fine — "
                    f"this one is worth retrying before changing anything.")
        return ""

    async def api_health(self, _req):
        """The five facts that answer "what is going on", on every screen.

        The console had a System status card, but only on the dashboard — so
        during the wizard, which is exactly when things go wrong, none of it
        was visible. Someone setting a robot up then has to guess whether the
        silence in front of them is the pairing engine, the network, or the
        robot, and guessing wrong costs a full pairing cycle.

        Deliberately cheap: it is polled every few seconds, so nothing here
        pings, dials TLS or touches the robot. It reports what the server
        already knows.
        """
        from .. import netinfo
        b = self.bridge
        items = []

        ip = netinfo.lan_ip()
        names = set(netinfo.resolves_to("vectar.local"))
        if not ip:
            items.append({"key": "network", "state": "bad", "text": "no network",
                          "fix": "Connect this Mac to Wi-Fi."})
        elif names and ip not in names:
            # The stale-announcement case, which is invisible from the outside:
            # the name resolves, so nothing errors, it just leads nowhere.
            items.append({"key": "network", "state": "warn",
                          "text": f"{ip} · name still points elsewhere",
                          "fix": "Re-announcing shortly — refresh in a moment."})
        else:
            items.append({"key": "network", "state": "ok", "text": ip, "fix": ""})

        st = await asyncio.to_thread(self._wirepod_cached)
        items.append({
            "key": "pairing engine",
            "state": "ok" if st.get("ready") else ("warn" if st.get("up") else "bad"),
            "text": ("escape-pod mode" if st.get("ready")
                     else "running, not escape-pod" if st.get("up") else "down"),
            "fix": "" if st.get("ready") else st.get("detail", "")})

        serial, ips, name = config.read_robot_identity("")
        robot_ip = (ips or "").split(",")[0].strip()
        if not serial:
            items.append({"key": "robot", "state": "warn", "text": "none paired",
                          "fix": "Run PAIR ROBOT."})
        elif getattr(b, "robot_alive", False):
            items.append({"key": "robot", "state": "ok",
                          "text": f"{name or serial} · control held", "fix": ""})
        elif netinfo.same_subnet(ip, robot_ip) is False:
            items.append({"key": "robot", "state": "bad",
                          "text": f"{name or serial} on another network",
                          "fix": f"He was paired at {robot_ip}; this Mac is on "
                                 f"{ip}. Re-pair him onto this network."})
        else:
            items.append({"key": "robot", "state": "warn",
                          "text": f"{name or serial} · not connected",
                          "fix": getattr(b, "last_link_hint", "")
                                 or "Press CONNECT ROBOT."})

        lens = bool(getattr(getattr(b, "ws", None), "alive", False))
        items.append({"key": "lens", "state": "ok" if lens else "idle",
                      "text": "connected" if lens else "waiting", "fix": ""})
        return web.json_response({"ok": True, "items": items})

    _WIREPOD_CACHE: tuple[float, dict] = (0.0, {})

    def _wirepod_cached(self, ttl: float = 5.0) -> dict:
        """wirepod_status resolves a name and opens a TLS connection, which is
        far too much to repeat on every poll of a status bar."""
        now = time.monotonic()
        ts, val = WebUI._WIREPOD_CACHE
        if val and now - ts < ttl:
            return val
        from . import pairing as _p
        try:
            val = _p.wirepod_status(config.WIREPOD_URL)
        except Exception as e:
            val = {"up": False, "ready": False, "detail": str(e)}
        WebUI._WIREPOD_CACHE = (now, val)
        return val

    def _stale_credentials(self, serial: str, live_name: str) -> str:
        """Why the stored credentials cannot work for the robot in front of us.

        Empty string means they look usable. Existence is not usability: a
        robot keeps his serial through Clear User Data but gets a new name and
        a new certificate, so a July entry for the same ESN survives a wipe
        looking perfectly valid and reports "credentials ready" for a pairing
        that has been dead for a week. That is exactly how an onboarding which
        never obtained a token still ended on a success screen.

        Only decidable while a BLE session is open, since `live_name` is read
        from the robot himself.
        """
        if not serial or not live_name:
            return ""
        import configparser
        try:
            c = configparser.ConfigParser(strict=False)
            c.read(config.SDK_CONFIG_PATH)
            if not c.has_section(serial):
                return ""    # nothing stored — a normal first pairing
            stored_name = (c[serial].get("name") or "").strip()
            cert = (c[serial].get("cert") or "").strip()
            if stored_name and stored_name != live_name:
                return (f"the stored pairing is for {stored_name}, but this "
                        f"robot now calls himself {live_name} — his name and "
                        f"certificate rotate on a factory reset, the serial "
                        f"does not")
            if cert and not Path(cert).is_file():
                return f"his certificate is missing from disk ({cert})"
        except Exception:
            return ""
        return ""

    def _is_provisioned(self, serial: str = "") -> bool:
        """Does sdk_config.ini hold a real guid for THIS robot?

        Asking "is any robot provisioned" was the same global-instead-of-
        per-robot mistake as reading the identity without a serial: with a
        second robot already set up, a failed mint reported success and the
        wizard printed "credentials written" for a robot it had written
        nothing for.
        """
        import configparser
        try:
            c = configparser.ConfigParser(strict=False)
            c.read(config.SDK_CONFIG_PATH)
            if serial:
                return bool(c.has_section(serial) and c[serial].get("guid"))
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

        # Escape-pod mode is the ONLY mode a stock robot can reach — his
        # firmware hard-codes `escapepod.local` — and whether it is on is
        # knowable right now, for free. Without it his sign-in has nowhere to
        # land, so the certificate can never appear and the 60 s poll further
        # down spends a minute to arrive at "no certificate for serial", which
        # blames the engine for a mode nobody turned on. Settle it before we
        # ask him to sign in, and fix it in place when we can: the config is
        # gitignored, so on a fresh clone this is off by default and everyone
        # meets it once.
        pod_ready = await asyncio.to_thread(pairing.wirepod_status, pod)
        if not pod_ready.get("ready"):
            from .. import pairing_engine as _pe
            self._set_auth("start", "Turning on escape-pod mode…")
            changed = await asyncio.to_thread(_pe.ensure_escape_pod_config)
            engine = getattr(b, "_pairing_engine", None)
            # restart() is a no-op for an engine we did not start — someone
            # running their own copy has to restart it themselves.
            restarted = bool(await engine.restart()) if (changed and engine) else False
            if changed:
                logger.info("escape-pod mode was off — enabled it"
                            + (" and restarted the pairing engine" if restarted
                               else " (the running engine still needs a restart)"))
            pod_ready = await asyncio.to_thread(pairing.wirepod_status, pod)
            if not pod_ready.get("ready"):
                if changed and not restarted:
                    why = ("It is set now, but the pairing engine already "
                           "running still serves the old mode — stop it "
                           "(pkill -f vectar-onboard) and start the server "
                           "again, then press this once more.")
                else:
                    why = pod_ready.get("detail", "")
                return web.json_response(
                    {"ok": False, "step": "wirepod", "needs_setup": True,
                     "wirepod": pod_ready,
                     "error": ("The pairing engine is not in escape-pod mode, "
                               "so Vector has nowhere to sign in and no "
                               "certificate can ever appear. " + why).strip()})

        cfg_serial, cfg_ips, _n = config.read_robot_identity()
        # Set only on the BLE path, read on both — an authorize without a
        # session never asks him anything, so there is no token to judge.
        empty_guid = False
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
            # If the engine is still holding a certificate issued to a DIFFERENT
            # name for this serial, it predates a factory reset: his serial is
            # fused, his name and certificate are not. The engine only writes a
            # new one when there is nothing there, so clear it before asking him
            # to sign in -- otherwise pairing keeps rejecting a certificate that
            # nothing will ever replace. (Cost an hour on the dev robot.)
            if esn and name:
                try:
                    stale = await asyncio.to_thread(pairing.fetch_cert, pod, esn)
                    if pairing._cert_common_name(stale) != name:
                        await asyncio.to_thread(pairing.forget_cert, esn)
                except Exception:
                    pass   # no certificate at all is the normal fresh case

            cloud_err = ""
            empty_guid = False
            for attempt in range(1, 4):
                self._set_auth("cloud", "Asking Vector to sign in to the "
                               f"pairing engine (try {attempt}/3)…")
                try:
                    guid = await self._ble.cloud_auth()
                    # A success status with an EMPTY token is not a success:
                    # it means vic-cloud answered us without completing the
                    # sign-in, so wire-pod was never called, nothing was
                    # associated, and the certificate the poll below waits for
                    # can never be written. Saying "cloud-authed" for that is
                    # how this turns into an hour of blaming the engine — the
                    # log said the step worked. Say what actually came back.
                    empty_guid = not guid
                    logger.info(
                        "robot cloud-authed against wire-pod "
                        f"(attempt {attempt})" if guid else
                        f"robot answered the cloud session (attempt {attempt}) "
                        "but handed back an EMPTY token — he did not complete "
                        "the sign-in, so no certificate will be written")
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
                if not self._is_provisioned(esn):
                    # An unprovisioned robot fails the mint because wire-pod has
                    # no cert for it — that's a setup problem, not a user error.
                    ready = await asyncio.to_thread(pairing.wirepod_status, pod)
                    extra = await asyncio.to_thread(
                        self._why_he_never_knocked,
                        getattr(self._ble, "ip", "") if self._ble else "")
                    if empty_guid:
                        # We know something the network probe cannot: he
                        # answered the sign-in without finishing it. Blaming
                        # the engine here sends people to check a wire-pod
                        # that is working perfectly.
                        extra = ("He answered the sign-in with an empty token, "
                                 "so he never registered with the pairing "
                                 "engine — nothing is wrong with the engine, "
                                 "he did not complete his half. Restart him "
                                 "(hold the backpack button ~5 s, then back on "
                                 "the charger), let him wake fully, and run "
                                 "the setup once more.")
                    return web.json_response(
                        {"ok": False, "step": e.step, "needs_setup": True,
                         "wirepod": ready, "empty_guid": empty_guid,
                         "error": e.message + (f" {extra}" if extra else "")})
                # already provisioned -> mint optional, fall through to connect
            except Exception as e:
                if not self._is_provisioned(esn):
                    return web.json_response({"ok": False, "error": str(e)})

        # The sign-in that creates his certificate only travels over Bluetooth.
        # Without a session there is nothing to wait for, so say what to do
        # instead of spending a minute polling and then blaming the setup.
        #
        # Only for a robot who has never been minted, though: one who already
        # holds credentials and just lost his link needs RETRY, not a lecture
        # about pairing. (That distinction is why this asks about THIS robot's
        # serial rather than whether any robot is set up.)
        if not minted and self._ble is None and not self._is_provisioned(esn):
            return web.json_response(
                {"ok": False, "step": "signin", "needs_signin": True,
                 "error": "He hasn't said hello to the pairing engine yet, and "
                          "that only goes over Bluetooth. Double-press his "
                          "backpack button, enter the PIN from his face, and "
                          "this finishes on its own."})

        # Stored-but-unusable is its own case, and it used to pass for success:
        # the entry exists, so every check said provisioned, and the wizard
        # finished on "credentials ready" for a robot it never obtained a token
        # for. Only worth asking while BLE is open — the robot's current name
        # is what gives it away.
        if not minted:
            live_name = getattr(self._ble, "name", "") if self._ble else ""
            why = self._stale_credentials(esn, live_name)
            if why:
                return web.json_response(
                    {"ok": False, "step": "signin", "needs_signin": True,
                     "error": f"Found an old pairing that cannot work — {why}. "
                              f"Double-press his backpack button and run "
                              f"AUTHORIZE again to issue him a fresh one."})

        if not self._is_provisioned(esn) and not minted:
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
        # force: we just minted his certificate and token, so any link open
        # right now was built on the previous pair and is dead the moment they
        # are replaced. Without this the link watchdog's reconnect — which can
        # land a second or two BEFORE authorize finishes — made the link look
        # healthy, so this returned "connected" on credentials the robot had
        # already stopped accepting, and every command 401'd from then on.
        ok = await b.connect_robot(force=True)
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
