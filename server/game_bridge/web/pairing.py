"""Pairing core: obtain the robot's TLS cert + mint an SDK auth guid.

The flow (same one `anki_vector.configure` runs interactively, re-implemented
exception-based for the web wizard):

  1. GET  http://<wire-pod>/session-certs/<serial>   -> robot TLS cert (PEM)
  2. cert CN must equal the robot name (Vector-XXXX)
  3. gRPC UserAuthentication to the ROBOT at <ip>:443 (channel pinned to the
     cert). wire-pod's token server answers through the robot and returns a
     fresh guid; its hash is APPENDED to the robot's vic.AppTokens jdoc, so
     re-pairing never invalidates existing clients.
  4. Write ~/.anki_vector/<name>-<serial>.cert + sdk_config.ini [serial].

wire-pod must be RUNNING during pairing (steps 1+3). Gameplay afterwards is
pod-free: vic-gateway validates the guid locally.

All functions are synchronous (call via asyncio.to_thread). Failures raise
PairingError(step=...) so the UI can point at the exact stage.
"""
from __future__ import annotations

import configparser
import logging
import os
import socket
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


def fetch_cert(pod: str, serial: str) -> bytes:
    """Download the robot's TLS cert from wire-pod's session-certs store."""
    import requests

    pod = pod.strip().rstrip("/")
    if "://" not in pod:
        pod = "http://" + pod
    url = f"{pod}/session-certs/{serial}"
    try:
        r = requests.get(url, timeout=8)
    except Exception as e:
        raise PairingError(
            STEP_CERT,
            f"Can't reach wire-pod at {pod} ({type(e).__name__}). Is wire-pod "
            "running on this network? Check the address (default "
            "escapepod.local:8080 — try the machine's IP if .local fails).")
    if r.status_code != 200:
        raise PairingError(
            STEP_CERT,
            f"wire-pod has no certificate for serial '{serial}' (HTTP "
            f"{r.status_code}). Check the serial (bottom of the robot), and "
            "that THIS wire-pod instance onboarded the robot.")
    if b"BEGIN CERTIFICATE" not in r.content:
        raise PairingError(
            STEP_CERT, f"Response from {url} is not a PEM certificate.")
    return r.content


def validate_cert_name(cert: bytes, robot_name: str) -> None:
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend

    parsed = x509.load_pem_x509_certificate(cert, default_backend())
    for field in parsed.subject:
        if "commonName" in str(field.oid):
            if field.value != robot_name:
                raise PairingError(
                    STEP_CERT,
                    f"The certificate belongs to '{field.value}', not "
                    f"'{robot_name}'. Check the robot name / serial pair.")
            return


def mint_guid(cert: bytes, ip: str, name: str) -> bytes:
    """gRPC UserAuthentication against the robot -> fresh SDK guid (bytes)."""
    import grpc
    from anki_vector import messaging

    creds = grpc.ssl_channel_credentials(root_certificates=cert)
    channel = grpc.secure_channel(
        f"{ip}:443", creds, options=(("grpc.ssl_target_name_override", name),))
    try:
        grpc.channel_ready_future(channel).result(timeout=15)
    except grpc.FutureTimeoutError:
        raise PairingError(
            STEP_TLS,
            f"Can't reach {name} at {ip}:443 (15 s timeout). Is the robot ON "
            "and on the same Wi-Fi? Wrong IP? If the robot was re-onboarded, "
            "the certificate may have rotated — retry pairing from scratch.")

    try:
        interface = messaging.client.ExternalInterfaceStub(channel)
        request = messaging.protocol.UserAuthenticationRequest(
            # wire-pod ignores the session token contents — this dummy value
            # is what the SDK's own configure tool sends.
            user_session_id=b"2vMhFgktH3Jrbemm2WHkfGN",
            client_name=socket.gethostname().encode("utf-8"))
        response = interface.UserAuthentication(request)
    except grpc.RpcError as e:
        raise PairingError(
            STEP_AUTH,
            "The robot refused the authentication call "
            f"({e.code().name if hasattr(e, 'code') else e}). Usually this "
            "means the robot can't reach ITS token server — is wire-pod "
            "running, and did THIS wire-pod onboard the robot?")
    if response.code != messaging.protocol.UserAuthenticationResponse.AUTHORIZED:
        raise PairingError(
            STEP_AUTH,
            "Authentication not authorized by the robot. The robot's trusted "
            "server is not this wire-pod — re-run wire-pod onboarding, then "
            "pair again.")
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
    config[serial] = {
        "cert": cert_file,
        "ip": ip,
        "name": name,
        "guid": guid.decode("utf-8"),
    }
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


def pair(pod: str, serial: str, name: str, ip: str) -> dict:
    """Full pairing: cert -> validate -> mint -> persist. Returns a summary."""
    serial = serial.strip().lower()
    if not serial:
        raise PairingError(STEP_CERT, "Robot serial is required "
                           "(printed on the bottom of the robot, e.g. 00e20145).")
    if not ip.strip():
        raise PairingError(STEP_TLS, "Robot IP is required (double-press the "
                           "backpack button on the charger, then raise+lower "
                           "the arms to see it on his face).")
    name = standardize_name(name)
    ip = ip.strip()

    cert = fetch_cert(pod, serial)
    validate_cert_name(cert, name)
    guid = mint_guid(cert, ip, name)
    try:
        cert_file = save_cert(cert, name, serial)
        write_config(serial, cert_file, ip, name, guid)
    except PairingError:
        raise
    except Exception as e:
        raise PairingError(STEP_WRITE, f"Could not write SDK config: {e}")
    logger.info(f"Paired {name} ({serial}) at {ip} — sdk_config.ini updated")
    return {"serial": serial, "name": name, "ip": ip, "cert_file": cert_file}


def test_connection(serial: str = "") -> dict:
    """Short-lived SDK connect to prove the pairing works (no behavior control
    so we don't hijack the robot). Returns battery/version info."""
    os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")
    from .. import config as gconfig

    ser, ips, name = gconfig.read_robot_identity()
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
