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
            web.post("/api/official/pair", self.api_official_pair),
            web.post("/api/test", self.api_test),
            web.post("/api/connect", self.api_connect),
            # Give the robot back to himself (he can't free-roam while an SDK
            # client holds behavior control).
            web.post("/api/release", self.api_release),
            # Whole-chain diagnosis in one call (same as `python -m
            # game_bridge.doctor`), so nobody has to grep the log to find out
            # which link of the chain is down.
            web.get("/api/doctor", self.api_doctor),
            web.static("/static", STATIC_DIR),
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

    async def api_doctor(self, _req):
        from .. import doctor
        # Probes block (TCP waits, TLS) — keep them off the game loop.
        res = await asyncio.to_thread(doctor.run, self.bridge)
        return web.json_response({"ok": True, **res})

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

