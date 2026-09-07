"""Turning a certificate into SDK credentials on this Mac.

What the SDK needs is a certificate that identifies the robot and a guid it
will accept. The certificate comes from his cloud — see `official.py` — and
the guid comes from the robot himself:

  1. the certificate's CN must be his name (Vector-XXXX)
  2. gRPC UserAuthentication to the ROBOT at <ip>:443, on a channel pinned to
     that certificate, carrying the account session. He answers with a fresh
     guid, and its hash is APPENDED to his token store — so pairing again
     never invalidates a client that already works.
  3. write ~/.anki_vector/<name>-<serial>.cert + sdk_config.ini [serial]

Step 2 talks to the robot over Wi-Fi, not to the internet. Nothing here has to
keep running afterwards: the robot validates the guid himself.

All functions are synchronous (call via asyncio.to_thread). Failures raise
PairingError(step=...) so the UI can point at the exact stage.
"""
from __future__ import annotations

import configparser
import logging
import os
import socket
import time
from pathlib import Path

logger = logging.getLogger("game-bridge.pairing")

ANKI_DIR = Path.home() / ".anki_vector"

# Step ids the wizard UI shows progress for
STEP_CERT = "cert"
STEP_TLS = "tls"
STEP_AUTH = "auth"
STEP_WRITE = "write"


class PairingError(Exception):
    def __init__(self, step: str, message: str):
        super().__init__(message)
        self.step = step
        self.message = message


def standardize_name(robot_name: str) -> str:
    """'vector-a1b2' / 'A1B2' -> 'Vector-A1B2' (same rules as the SDK)."""
    robot_name = robot_name.strip()
    if robot_name.lower().startswith("vector-"):
        robot_name = "Vector-" + robot_name[len("vector-"):]
    elif len(robot_name) == 4:
        robot_name = "Vector-" + robot_name
    if len(robot_name) != 11 or not robot_name.startswith("Vector-"):
        raise PairingError(
            STEP_CERT,
            f"'{robot_name}' doesn't look like a robot name — expected "
            "'Vector-XXXX' (shown when you double-press Vector's backpack "
            "button on the charger).")
    return robot_name[:7] + robot_name[7:].upper()



def validate_cert_name(cert: bytes, robot_name: str) -> None:
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend

    parsed = x509.load_pem_x509_certificate(cert, default_backend())
    for field in parsed.subject:
        if "commonName" in str(field.oid):
            if field.value != robot_name:
                # Not a mismatched name/serial pair -- almost always the SAME
                # robot after a factory reset. His serial is fused and never
                # changes, so the engine's per-serial store keeps handing back
                # the certificate minted under his OLD name. He has to be asked
                # to sign in again, which replaces it.
                raise PairingError(
                    STEP_CERT,
                    f"The certificate is {field.value}'s, but this robot is "
                    f"now {robot_name} — it predates his factory reset. Set "
                    "him up once more so his cloud issues a current one.")
            return


def mint_guid(cert: bytes, ip: str, name: str,
              session_id: bytes = b"2vMhFgktH3Jrbemm2WHkfGN") -> bytes:
    """gRPC UserAuthentication against the robot -> fresh SDK guid (bytes).

    `session_id` is the account session the robot checks the request against.
    wire-pod ignores its contents, so the default is the dummy the SDK's own
    tool sends. The official path passes a real one — and that is the only
    difference between minting against our engine and against DDL's cloud.
    The call, the robot and the resulting guid are identical.
    """
    import grpc
    from anki_vector import messaging

    creds = grpc.ssl_channel_credentials(root_certificates=cert)
    channel = grpc.secure_channel(
        f"{ip}:443", creds, options=(("grpc.ssl_target_name_override", name),))
    try:
        grpc.channel_ready_future(channel).result(timeout=15)
    except grpc.FutureTimeoutError:
        channel.close()
        raise PairingError(
            STEP_TLS,
            f"Can't reach {name} at {ip}:443 (15 s timeout). Is the robot ON "
            "and on the same Wi-Fi? Wrong IP? If the robot was re-onboarded, "
            "the certificate may have rotated — retry pairing from scratch.")

    try:
        interface = messaging.client.ExternalInterfaceStub(channel)
        request = messaging.protocol.UserAuthenticationRequest(
            user_session_id=session_id,
            client_name=socket.gethostname().encode("utf-8"))
        # The deadline is not optional. The gateway hands this call to
        # vic-cloud, and vic-cloud dies of its own accord on these robots (it
        # panics when its token server can't be resolved). The TCP channel
        # stays up, so without a deadline this waits forever and the wizard
        # hangs with no error at all — seen live, 2026-07-25.
        response = interface.UserAuthentication(request, timeout=30)
    except grpc.RpcError as e:
        code = e.code().name if hasattr(e, "code") else str(e)
        if code == "DEADLINE_EXCEEDED":
            raise PairingError(
                STEP_AUTH,
                "The robot accepted the connection but never answered the "
                "authentication call. That is his cloud process being dead "
                "(fault 923) rather than anything about this Mac — restart "
                "him, and if it keeps happening let setup clear his queued "
                "fault reports.")
        raise PairingError(
            STEP_AUTH,
            f"The robot refused the authentication call ({code}). That is "
            "usually an account he was not set up with — the certificate and "
            "the session have to belong to the same one.")
    finally:
        # Hand the robot's one client slot back. vic-gateway serves a single
        # client, so a channel left open here means the very next connection --
        # the one that proves the pairing worked -- is refused, and the error
        # it gives ("unable to establish a connection") points at the network
        # instead of at us still holding the socket. Seen live: retries inside
        # this process all failed while a fresh process connected first try.
        try:
            channel.close()
        except Exception:
            pass
    if response.code != messaging.protocol.UserAuthenticationResponse.AUTHORIZED:
        raise PairingError(
            STEP_AUTH,
            "The robot did not authorize the request. He was set up under a "
            "different account than the one signed in here — use the account "
            "his web setup was done with.")
    return response.client_token_guid




def save_cert(cert: bytes, name: str, serial: str) -> str:
    ANKI_DIR.mkdir(parents=True, exist_ok=True)
    cert_file = str(ANKI_DIR / f"{name}-{serial}.cert")
    with os.fdopen(os.open(cert_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                           0o600), "wb") as f:
        f.write(cert)
    return cert_file


def write_config(serial: str, cert_file: str, ip: str, name: str,
                 guid: bytes) -> None:
    """Atomic update of ~/.anki_vector/sdk_config.ini (SDK-compatible)."""
    config_file = str(ANKI_DIR / "sdk_config.ini")
    config = configparser.ConfigParser(strict=False)
    try:
        config.read(config_file)
    except configparser.ParsingError:
        if os.path.exists(config_file):
            os.rename(config_file, config_file + "-error")
    entry = {
        "cert": cert_file,
        "ip": ip,
        "name": name,
        "guid": guid.decode("utf-8"),
    }
    # The robot you just set up goes FIRST. Anything that asks "which robot?"
    # without naming one takes the first section, so appending left the bridge
    # driving whichever robot was paired longest ago -- switched off, most
    # likely, since you were busy setting up a different one.
    rest = {s: dict(config[s]) for s in config.sections() if s != serial}
    ordered = configparser.ConfigParser(strict=False)
    ordered[serial] = entry
    for s, values in rest.items():
        ordered[s] = values
    config = ordered
    temp_file = config_file + "-temp"
    if os.path.exists(config_file):
        os.rename(config_file, temp_file)
    try:
        with os.fdopen(os.open(config_file, os.O_WRONLY | os.O_CREAT, 0o600),
                       "w") as f:
            config.write(f)
    except Exception:
        if os.path.exists(temp_file):
            os.rename(temp_file, config_file)
        raise
    else:
        if os.path.exists(temp_file):
            os.remove(temp_file)


def _cert_common_name(cert: bytes) -> str:
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend
    parsed = x509.load_pem_x509_certificate(cert, default_backend())
    for field in parsed.subject:
        if "commonName" in str(field.oid):
            return field.value
    return ""



def test_connection(serial: str = "") -> dict:
    """Short-lived SDK connect to prove the pairing works (no behavior control
    so we don't hijack the robot). Returns battery/version info."""
    os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")
    from .. import config as gconfig

    ser, ips, name = gconfig.read_robot_identity(serial)
    serial = (serial or ser).lower()
    if not serial:
        raise PairingError(STEP_WRITE, "No robot in sdk_config.ini — pair first.")
    import anki_vector

    ip = ips.split(",")[0].strip() if ips else None
    robot = anki_vector.Robot(serial=serial, ip=ip or None,
                              default_logging=False,
                              cache_animation_lists=False,
                              behavior_control_level=None)
    try:
        robot.connect(timeout=20)
        battery = None
        try:
            b = robot.get_battery_state()
            battery = {
                "volts": round(getattr(b, "battery_volts", 0.0), 2),
                "level": int(getattr(b, "battery_level", 0)),
                "charging": bool(getattr(b, "is_charging", False)),
            }
        except Exception:
            pass
        version = None
        try:
            v = robot.get_version_state()
            version = getattr(v, "os_version", None)
        except Exception:
            pass
        return {"ok": True, "serial": serial, "battery": battery,
                "firmware": version}
    except Exception as e:
        raise PairingError(
            STEP_TLS,
            f"SDK connect failed: {type(e).__name__}: {e}. Robot on? Same "
            "network? IP changed (DHCP)? Re-run pairing to refresh the IP.")
    finally:
        try:
            robot.disconnect()
        except Exception:
            pass
