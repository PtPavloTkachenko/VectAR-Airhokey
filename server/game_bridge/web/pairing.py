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


def wirepod_status(pod: str = "") -> dict:
    """Is the pairing engine actually usable by a STOCK (escape-pod) robot?

    A robot running the `ep` firmware reaches its cloud at the fixed name
    `escapepod.local:443` and only trusts the well-known Digital Dream Labs
    escape-pod certificate (CN=escapepod.local). wire-pod serves that identity
    ONLY in escape-pod mode (`apiConfig.json` -> `server.epconfig: true`); in
    the other mode it serves a self-signed IP certificate and never broadcasts
    the mDNS name, so a freshly flashed stock robot silently talks to nobody
    and pairing dies later at "cert does not exist".

    Probing the live behaviour (name resolves + which cert :443 presents) is
    what actually matters, so we check that rather than reading the config.

    Returns {up, mdns, ep_cert, ready, ip, detail} — never raises.
    """
    import socket
    import ssl

    out = {"up": False, "mdns": False, "ep_cert": False, "ready": False,
           "ip": "", "detail": ""}

    import requests
    base = (pod or "").strip().rstrip("/") or "http://localhost:8080"
    if "://" not in base:
        base = "http://" + base
    try:
        requests.get(base, timeout=4)
        out["up"] = True
    except Exception as e:
        out["detail"] = (f"wire-pod is not answering at {base} "
                         f"({type(e).__name__}). Start `vectar-onboard`.")
        return out

    try:
        out["ip"] = socket.gethostbyname("escapepod.local")
        out["mdns"] = True
    except Exception:
        out["detail"] = ("wire-pod is running but `escapepod.local` does not "
                         "resolve — it is not in escape-pod mode, so a stock "
                         "robot can never find it. Set `server.epconfig: true` "
                         "in chipper/apiConfig.json and restart vectar-onboard.")
        return out

    # Which certificate does :443 present? The ep firmware pins this.
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((out["ip"], 443), timeout=5) as raw:
            with ctx.wrap_socket(raw, server_hostname="escapepod.local") as tls:
                der = tls.getpeercert(binary_form=True)
        from cryptography import x509
        parsed = x509.load_der_x509_certificate(der)
        cn = ""
        for field in parsed.subject:
            if "commonName" in str(field.oid):
                cn = field.value
        out["ep_cert"] = (cn == "escapepod.local")
        if not out["ep_cert"]:
            out["detail"] = (
                f"escapepod.local:443 presents a certificate for '{cn}', not "
                "'escapepod.local'. A stock robot will refuse it. Restart "
                "vectar-onboard in escape-pod mode.")
            return out
    except Exception as e:
        out["detail"] = (f"Nothing is serving TLS on escapepod.local:443 "
                         f"({type(e).__name__}) — wire-pod is not in "
                         "escape-pod mode or its port 443 failed to bind.")
        return out

    out["ready"] = True
    out["detail"] = f"Escape-pod mode live on {out['ip']} (mDNS + ep cert)."
    return out


def fetch_cert(pod: str, serial: str, wait: float = 0.0,
               on_wait=None) -> bytes:
    """Download the robot's TLS cert from wire-pod's session-certs store.

    `wait` (seconds) polls instead of failing on the first miss: the cert only
    appears once the ROBOT has completed its own handshake against wire-pod,
    which lags the wizard's Wi-Fi step by a few seconds to a minute on a fresh
    stock unit. Failing fast here was the classic "cert does not exist" dead
    end even though the robot was on its way.
    """
    import requests

    pod = pod.strip().rstrip("/")
    if "://" not in pod:
        pod = "http://" + pod
    url = f"{pod}/session-certs/{serial}"
    started = time.monotonic()
    deadline = started + max(0.0, wait)
    last_status = None
    while True:
        if callable(on_wait):
            try:
                on_wait(time.monotonic() - started)
            except Exception:
                pass
        try:
            r = requests.get(url, timeout=8)
        except Exception as e:
            raise PairingError(
                STEP_CERT,
                f"Can't reach wire-pod at {pod} ({type(e).__name__}). Is wire-pod "
                "running on this network? Check the address (default "
                "escapepod.local:8080 — try the machine's IP if .local fails).")
        if r.status_code == 200 and b"BEGIN CERTIFICATE" in r.content:
            return r.content
        last_status = r.status_code
        if time.monotonic() >= deadline:
            break
        time.sleep(2.0)

    if last_status == 200:
        raise PairingError(
            STEP_CERT, f"Response from {url} is not a PEM certificate.")
    waited = (f" (waited {wait:.0f}s for the robot's handshake)"
              if wait else "")
    # Diagnosing WHY is the caller's job (it adds wirepod_status to the reply)
    # so this stays a pure HTTP function with no side probes.
    raise PairingError(
        STEP_CERT,
        f"wire-pod has no certificate for serial '{serial}' (HTTP "
        f"{last_status}){waited}. The robot has not completed its handshake "
        "against THIS wire-pod.")


class StaleCertError(PairingError):
    """The engine's stored certificate predates the robot's factory reset."""


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
                raise StaleCertError(
                    STEP_CERT,
                    f"The pairing engine still holds {field.value}'s "
                    f"certificate for this serial, but he is now "
                    f"{robot_name} — it was minted before his factory reset. "
                    "He has to sign in once more so it gets replaced.")
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
        channel.close()
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
            f"The robot refused the authentication call ({code}). Usually this "
            "means the robot can't reach ITS token server — is wire-pod "
            "running, and did THIS wire-pod onboard the robot?")
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
            "Authentication not authorized by the robot. The robot's trusted "
            "server is not this wire-pod — re-run wire-pod onboarding, then "
            "pair again.")
    return response.client_token_guid


def pod_guid(pod: str, serial: str) -> bytes:
    """The guid the pairing engine issued for this robot, or b''.

    The robot does not always hand his guid back over the network call — on a
    dev robot he answers with an empty one — but the engine minted it and knows
    it, and its hash is already in the robot's token store. So asking the engine
    is not a workaround; it is asking whoever actually issued the thing.
    """
    import requests

    pod = (pod or "").strip().rstrip("/")
    if "://" not in pod:
        pod = "http://" + pod
    try:
        r = requests.get(f"{pod}/api-sdk/get_sdk_info", timeout=8)
        for robot in (r.json() or {}).get("robots") or []:
            if str(robot.get("esn", "")).lower() == serial.lower():
                return (robot.get("guid") or "").encode("utf-8")
    except Exception as e:
        logger.debug(f"could not read the engine's sdk info: {e}")
    return b""


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


def pair(pod: str, serial: str, name: str, ip: str,
         cert_wait: float = 0.0, on_wait=None) -> dict:
    """Full pairing: cert -> validate -> mint -> persist. Returns a summary.

    `name` may be empty — it's then taken from the certificate's CommonName
    (the robot name), so the on-Wi-Fi shortcut doesn't need a name typed.
    `cert_wait` polls wire-pod for the robot's session cert instead of failing
    on the first miss (see fetch_cert) — a fresh stock robot needs a moment
    after joining Wi-Fi before its handshake lands.
    """
    serial = serial.strip().lower()
    if not serial:
        raise PairingError(STEP_CERT, "Robot serial is required "
                           "(printed on the bottom of the robot, e.g. 00e20145).")
    if not ip.strip():
        raise PairingError(STEP_TLS, "Robot IP is required.")
    ip = ip.strip()

    cert = fetch_cert(pod, serial, wait=cert_wait, on_wait=on_wait)
    if name.strip():
        name = standardize_name(name)
        validate_cert_name(cert, name)
    else:
        name = _cert_common_name(cert) or f"Vector-{serial[-4:].upper()}"
    guid = mint_guid(cert, ip, name)
    if not guid:
        # A dev robot answers the authentication call with an EMPTY guid — the
        # call succeeds, so this used to be written out and reported as a
        # successful pairing. Every later connection then failed with a bare
        # 401 and nothing pointed back here. The engine issued a real guid for
        # him, so use that; if even it has none, say so instead of persisting
        # a credential that cannot work.
        guid = pod_guid(pod, serial)
        if guid:
            logger.info(f"{serial}: robot returned no guid; used the engine's")
    if not guid:
        raise PairingError(
            STEP_AUTH,
            "The robot accepted the authentication call but issued no key, and "
            "the pairing engine has none for him either. He has not been "
            "associated with this engine yet — connect over Bluetooth once so "
            "he can sign in.")
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
