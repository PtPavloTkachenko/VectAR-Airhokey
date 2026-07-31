"""Vector SDK connection for the game bridge.

Trimmed copy of vector-server/vector-bot/utils/vector_connection.py:
same connect-with-None + separate control acquisition (robot may be busy),
but control is requested at OVERRIDE_BEHAVIORS_PRIORITY so idle behaviors
can't wrestle the wheels mid-rally. anki_vector import is lazy so the rest
of the package works without the SDK installed (tests, --no-robot).
"""
from __future__ import annotations

import asyncio
import logging
import socket
import subprocess
import time

from ... import config

logger = logging.getLogger("game-bridge.connection")

_CONTROL_RETRIES = 3
_CONTROL_RETRY_DELAY = 2

# Substrings that mean "we reached the robot but the saved TLS cert no longer
# matches it" — i.e. the robot was factory-reset / re-onboarded and rotated its
# self-signed certificate. No amount of IP rediscovery fixes this; the user must
# re-pair to refresh ~/.anki_vector/<name>.cert.
_CERT_ROTATED_MARKERS = (
    "certificate_verify_failed", "self signed certificate", "self-signed",
    "certificate verify failed", "ssl_error_ssl", "sslv3",
    "certificate has expired", "wrong_version_number",
)


def _tcp_open(ip: str, port: int = 443, timeout: float = 2.0,
              tries: int = 3) -> bool:
    """True if <ip>:443 accepts a TCP connection (robot is on this LAN and its
    gateway is up) — lets us tell 'wrong IP' apart from 'cert/auth problem'.

    Retries, because Vector's Wi-Fi radio power-saves: the FIRST packet after
    an idle spell wakes it and is usually lost, so a single-shot probe reports
    a wide-awake robot as missing. Measured on hardware: first probe times out
    and the ping that woke him takes ~180 ms, the next probes connect in 0.0 s.
    That false "not found" is what made the dashboard insist he was asleep
    while he was sitting there blinking at us.
    """
    for i in range(max(1, tries)):
        try:
            with socket.create_connection((ip, port), timeout=timeout):
                return True
        except Exception:
            if i + 1 < tries:
                time.sleep(0.4)
    return False


def _discover_robot_ip(candidates: list[str], timeout: float = 1.5) -> str | None:
    for ip in candidates:
        try:
            result = subprocess.run(
                ["ping", "-c", "1", "-W", str(int(timeout * 1000)), ip],
                capture_output=True, timeout=timeout + 1,
            )
            if result.returncode == 0:
                logger.info(f"Robot discovered at {ip}")
                return ip
        except Exception:
            continue
    return None


async def _mdns_find_ip(name: str, serial: str) -> str | None:
    """Ask the LAN for the robot's CURRENT ip via mDNS (_ankivector._tcp.local.).
    Matches on serial or Vector-name so we don't grab a different robot. Returns
    the ip or None. Survives a stale sdk_config.ini when the robot's DHCP lease
    changed or it hopped to a phone hotspot."""
    try:
        from ...web import discovery  # lazy: zeroconf is optional
    except Exception:
        return None
    try:
        found = await discovery.discover(5.0)
    except Exception as e:
        logger.debug(f"mDNS discovery failed: {e}")
        return None
    ser = (serial or "").lower()
    nm = (name or "").lower()
    # Identity match ONLY. There used to be a "if there's just one robot on the
    # LAN, assume it's him" fallback, which was fine while one robot existed
    # and is destructive now: with his robot switched off and a DIFFERENT one
    # awake, it handed back the other robot's address AND persisted it into
    # sdk_config.ini. The result was one robot's certificate pointed at another
    # robot's IP, a storm of failed TLS handshakes, and a console too starved
    # to answer. Not finding him is the honest answer.
    for r in found:
        rid = f"{r.get('serial','')}{r.get('name','')}".lower()
        if (ser and ser in rid) or (nm and nm in rid):
            if r.get("ip"):
                return r["ip"]
    return None


class RobotLink:
    def __init__(self):
        self.robot = None
        # Fresh read every construction: a pairing done via the web wizard
        # while the server is up must be visible on the next connect attempt.
        serial, ips, name = config.read_robot_identity()
        self.serial = serial
        self._candidate_ips = [ip.strip() for ip in ips.split(",") if ip.strip()]
        self.ip = self._candidate_ips[0] if self._candidate_ips else ""
        self.name = name
        self.has_control = False
        # Diagnostics surfaced to the dashboard so a failed connect explains
        # ITSELF instead of a bare OFFLINE. Kinds: "", "cert_rotated",
        # "unreachable", "ip_moved", "no_control".
        self.last_error_kind = ""
        self.last_error_msg = ""

    @property
    def paired(self) -> bool:
        return bool(self.serial and self.ip)

    async def connect(self) -> bool:
        if not self.paired:
            logger.warning(
                "No robot paired yet — open the web UI "
                f"(http://localhost:{config.WEB_PORT}) and run the pairing wizard")
            return False

        import anki_vector  # lazy

        self._force_cleanup()
        self.last_error_kind = ""
        self.last_error_msg = ""

        # A robot paired on another network cannot be reached from here, and
        # trying costs 40 seconds of gRPC timeouts that end in a guess about a
        # second SDK client. The addresses answer this before we spend any of
        # it. Only a definite False blocks: "cannot tell" must still attempt,
        # or a machine whose netmask we failed to read stops working entirely.
        try:
            from ... import netinfo
            here = netinfo.lan_ip()
            if self.ip and netinfo.same_subnet(here, self.ip) is False:
                self.last_error_kind = "wrong_network"
                self.last_error_msg = (
                    f"{self.name or 'The robot'} was paired at {self.ip}, which "
                    f"is on a different network than this Mac ({here}). Re-run "
                    f"PAIR ROBOT and use JOIN A DIFFERENT NETWORK to bring him "
                    f"onto this one.")
                logger.warning(self.last_error_msg)
                return False
        except Exception as e:
            logger.debug(f"network precheck: {e}")

        if len(self._candidate_ips) > 1:
            discovered = await asyncio.to_thread(
                _discover_robot_ip, self._candidate_ips)
            if discovered:
                self.ip = discovered
            else:
                logger.warning(
                    f"No robot found at {self._candidate_ips}, trying {self.ip}")

        ok = await self._try_connect()
        if ok:
            return True

        # First attempt failed. Decide WHY and, when it's fixable, fix + retry:
        #   * cert rotated (robot re-onboarded) -> can't self-heal, tell the user
        #   * IP moved (saved ip dead)          -> mDNS-rediscover, persist, retry
        if self.last_error_kind == "cert_rotated":
            return False
        if await asyncio.to_thread(_tcp_open, self.ip):
            # Reachable at the saved ip but the SDK still refused. Two very
            # different causes share this signature, and blaming the
            # certificate for both sends people to re-pair forever:
            #
            #   * TLS actually failed  -> _try_connect already saw the SSL
            #     error and set cert_rotated. Certificate problems fail FAST.
            #   * Connect TIMED OUT    -> TLS was fine and the gateway answers
            #     unauthenticated calls, but every AUTHENTICATED call hangs.
            #     That's a robot whose control token was just minted and whose
            #     gateway hasn't been through a full reboot yet — restarting
            #     its services is not enough (docs/PAIRING_86_DEEPDIVE.md).
            #     Verified live 2026-07-25: identical symptom, and one reboot
            #     brought the link straight up.
            if self.last_error_kind != "cert_rotated":
                self.last_error_kind = "needs_reboot"
                self.last_error_msg = (
                    f"{self.name} answers at {self.ip} and his certificate is "
                    "fine, but his control channel isn't responding. This is "
                    "normal right after a first-time setup: restart Vector "
                    "once — hold his backpack button ~5 s until he switches "
                    "off, then put him back on the charger.")
            return False
        # Not reachable at the saved ip -> the robot probably moved (DHCP / it
        # hopped to a phone hotspot). Ask the LAN where it is now.
        new_ip = await _mdns_find_ip(self.name, self.serial)
        if new_ip and new_ip != self.ip:
            logger.info(f"Robot moved {self.ip} -> {new_ip} (mDNS); "
                        "updating sdk_config.ini and retrying")
            self.ip = new_ip
            await asyncio.to_thread(config.persist_robot_ip, self.serial, new_ip)
            return await self._try_connect()
        self.last_error_kind = "unreachable"
        self.last_error_msg = (
            f"{self.name} isn't answering at {self.ip}, and mDNS doesn't see "
            "him either. Usually he is simply asleep — pat him, lift him, or "
            "press his backpack button and he reconnects on his own. If that "
            "doesn't bring him back, restart him: hold the backpack button "
            "~5 s until he switches off, then put him on the charger. (Worth "
            "checking he's on the same Wi-Fi as this Mac, too.)")
        return False

    async def _try_connect(self) -> bool:
        """One connect+control acquisition attempt. Classifies failures into
        self.last_error_kind so connect() can decide whether to rediscover."""
        import anki_vector  # lazy
        logger.info(f"Connecting to {self.name} ({self.ip})...")
        try:
            # NOTE: do NOT pass name= — it makes the SDK resolve <name>.local over
            # mDNS and OVERRIDE ip; mDNS is unreliable on many home networks ->
            # VectorNotFoundException. serial gives the cert/guid from
            # sdk_config.ini; ip is explicit. (Proven by sdk_smoke.py.)
            self.robot = anki_vector.AsyncRobot(
                serial=self.serial,
                ip=self.ip,
                default_logging=False,
                cache_animation_lists=False,
                behavior_control_level=None,
                enable_face_detection=False,
                enable_custom_object_detection=False,
                enable_nav_map_feed=False,
            )
            # connect() is SYNC even on AsyncRobot — run in thread
            await asyncio.wait_for(
                asyncio.to_thread(self.robot.connect, timeout=30), timeout=40)
            logger.info("Connected (without behavior control)")
            await self._acquire_control()
            await self._prewarm_animation_list()
            return True
        except asyncio.TimeoutError:
            logger.error("Connection timeout (40s)")
            self.last_error_kind = "unreachable"
            self.last_error_msg = (
                f"Timed out connecting to {self.name} at {self.ip}. Robot on "
                "and on the same Wi-Fi as the Mac?")
            self._force_cleanup()
            return False
        except Exception as e:
            msg = str(e).lower()
            if any(m in msg for m in _CERT_ROTATED_MARKERS):
                self.last_error_kind = "cert_rotated"
                self.last_error_msg = (
                    f"{self.name}'s TLS certificate no longer matches the saved "
                    "one — the robot was factory-reset / re-onboarded. Open PAIR "
                    "ROBOT and run the wizard again to refresh the certificate.")
                logger.error(
                    "Cert rotated (robot re-onboarded) — re-pair from the web UI. "
                    f"[{type(e).__name__}]")
            else:
                self.last_error_kind = "unreachable"
                self.last_error_msg = (
                    f"Connect to {self.name} failed: {type(e).__name__}: {e}")
                logger.error(f"Connection failed: {type(e).__name__}: {e}")
            self._force_cleanup()
            return False

    async def _acquire_control(self):
        """Acquire behavior control at OVERRIDE priority, with retries."""
        for attempt in range(1, _CONTROL_RETRIES + 1):
            try:
                fut = self._request_control()
                if hasattr(fut, "result"):
                    await asyncio.wait_for(
                        asyncio.to_thread(fut.result, 15), timeout=20)
                self.has_control = True
                logger.info(f"Behavior control acquired (attempt {attempt})")
                # ALWAYS zero motors on acquire: a previous bridge may have
                # died mid-drive and set_wheel_motors persists robot-side
                try:
                    self.robot.motors.set_wheel_motors(0, 0)
                    logger.info("Motors zeroed on control acquire")
                except Exception as e:
                    logger.debug(f"motor zero: {e}")
                return
            except Exception as e:
                logger.warning(
                    f"Behavior control attempt {attempt}/{_CONTROL_RETRIES}: {e}")
                self.has_control = False
                if attempt < _CONTROL_RETRIES:
                    await asyncio.sleep(_CONTROL_RETRY_DELAY)
        # Which failure this is depends on whether he is reachable at all, and
        # only one of the two answers is about another client holding him. The
        # single guessed message sent people hunting for a second SDK session
        # while the robot was simply on a network this Mac cannot see — a whole
        # morning of it, once.
        logger.error(self._control_failure_reason())

    def _control_failure_reason(self) -> str:
        ip = getattr(self, "ip", "") or ""
        try:
            from ... import netinfo
            here = netinfo.lan_ip()
            if ip and netinfo.same_subnet(here, ip) is False:
                return (f"Behavior control FAILED — {ip} is on a different "
                        f"network than this Mac ({here}), so nothing here can "
                        f"reach him. Re-run PAIR ROBOT and use JOIN A "
                        f"DIFFERENT NETWORK to bring him onto this one.")
        except Exception:
            pass
        if ip and not _tcp_open(ip, tries=2):
            return (f"Behavior control FAILED — {ip}:443 is not answering. He "
                    f"is asleep, switched off, or his address changed since "
                    f"pairing. Wake him with his backpack button, or re-pair "
                    f"if he moved networks.")
        return ("Behavior control FAILED while he WAS reachable — most likely "
                "another SDK client holds him. Vector allows only one; stop it "
                "and press CONNECT ROBOT again.")

    async def _prewarm_animation_list(self):
        """Prewarm the animation TRIGGER list (loads in <1 s; the full
        ListAnimations reliably times out over the repeater, so the game
        uses play_animation_trigger exclusively)."""
        try:
            fut = self.robot.anim.load_animation_trigger_list()
            if hasattr(fut, "result"):
                await asyncio.wait_for(
                    asyncio.to_thread(fut.result, 30), timeout=35)
            n = len(self.robot.anim.anim_trigger_list)
            try:
                from anki_vector import audio as _audio
                vf = self.robot.audio.set_master_volume(
                    _audio.RobotVolumeLevel.MEDIUM_HIGH)
                await asyncio.to_thread(vf.result, timeout=5)
                logger.info("Robot volume -> MEDIUM_HIGH")
            except Exception as e:
                logger.debug(f"set volume: {e}")
            logger.info(f"Animation trigger list prewarmed ({n} triggers)")
        except Exception as e:
            logger.warning(f"Trigger list prewarm failed (non-fatal): {e}")

    def _request_control(self):
        """request_control at OVERRIDE priority; fall back if the installed
        SDK's signature doesn't take the priority kwarg."""
        from anki_vector.connection import ControlPriorityLevel
        try:
            return self.robot.conn.request_control(
                behavior_control_level=ControlPriorityLevel.OVERRIDE_BEHAVIORS_PRIORITY,
                timeout=10,
            )
        except TypeError:
            self.robot.conn._behavior_control_level = (
                ControlPriorityLevel.OVERRIDE_BEHAVIORS_PRIORITY)
            return self.robot.conn.request_control(timeout=10)

    async def ensure_control(self) -> bool:
        if not self.robot:
            return False
        try:
            if self.has_control and not self.robot.conn.has_control:
                logger.warning("SDK lost behavior control — re-acquiring...")
                self.has_control = False
        except Exception:
            pass
        if self.has_control:
            return True
        await self._acquire_control()
        return self.has_control

    def _force_cleanup(self):
        if self.robot:
            try:
                self.robot.disconnect()
            except Exception:
                pass
            try:
                if getattr(self.robot, "conn", None):
                    self.robot.conn.close()
            except Exception:
                pass
        self.robot = None
        self.has_control = False

    async def disconnect(self):
        self._force_cleanup()
        logger.info("Disconnected from Vector")
