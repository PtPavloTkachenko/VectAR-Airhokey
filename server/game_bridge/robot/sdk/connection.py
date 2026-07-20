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


def _tcp_open(ip: str, port: int = 443, timeout: float = 2.0) -> bool:
    """True if <ip>:443 accepts a TCP connection (robot is on this LAN and its
    gateway is up) — lets us tell 'wrong IP' apart from 'cert/auth problem'."""
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except Exception:
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
    # prefer an exact serial/name match; fall back to the sole robot on the LAN
    for r in found:
        rid = f"{r.get('serial','')}{r.get('name','')}".lower()
        if (ser and ser in rid) or (nm and nm in rid):
            if r.get("ip"):
                return r["ip"]
    if len(found) == 1 and found[0].get("ip"):
        return found[0]["ip"]
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
            # Reachable at the saved ip but the SDK still refused — the gateway
            # is up, so this is a credential problem, not a wrong address.
            if self.last_error_kind != "cert_rotated":
                self.last_error_kind = "cert_rotated"
                self.last_error_msg = (
                    f"{self.name} answers at {self.ip} but rejected the saved "
                    "credential — the robot was re-onboarded. Re-run PAIR ROBOT "
                    "to refresh the certificate + token.")
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
            f"{self.name} not found at {self.ip} and not on the LAN via mDNS. "
            "Same Wi-Fi as the Mac? Robot on the charger and awake?")
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
        logger.error(
            "Behavior control FAILED — is another SDK client connected to this "
            "robot? Vector allows only one; stop it and restart the server.")

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
