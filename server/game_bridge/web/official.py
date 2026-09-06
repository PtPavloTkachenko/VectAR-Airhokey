"""Credentials from Digital Dream Labs' cloud, for a robot set up their way.

The rest of this project exists because Anki's cloud died: without it nothing
issues the two things the SDK needs — the robot's certificate, and a token he
will accept — so wire-pod stands in as a local replacement, and a stock robot
has to be flashed before he will talk to it.

DDL's cloud is alive and issues both. For anyone willing to use it, that makes
the whole firmware step unnecessary: set the robot up in their web tool, sign
in here, and the SDK works over Wi-Fi. Same robot, same SDK, same
`sdk_config.ini`, same game — only the source of the credentials differs.

Kept as a peer of the wire-pod path, not a replacement. That path is the one
that needs nobody's servers, and it is the one that still works the day DDL
turns theirs off, which has happened to this robot once already.

The four steps, from DDL's own configure tool:

    1. POST accounts.api.ddl.io/1/sessions   -> a session token for the account
    2. GET  device-cert.api.ddl.io/vic/<esn> -> that robot's certificate
    3. UserAuthentication over gRPC, to the ROBOT, carrying the session token
       -> the guid, which is what the SDK actually authenticates with
    4. write both into ~/.anki_vector

Steps 3 and 4 are the same code the wire-pod path uses. Only 1 and 2 are here.
"""
from __future__ import annotations

import logging

from . import pairing

logger = logging.getLogger("game-bridge.official")

SESSIONS_URL = "https://accounts.api.ddl.io/1/sessions"
DEVICE_CERT_URL = "https://device-cert.api.ddl.io/vic/{serial}"

# From DDL's configure tool. Their API rejects a request without them, and they
# identify the client rather than authorise anything.
_APP_HEADERS = {
    "User-Agent": "Vector-sdk/0.0.0",
    "Anki-App-Key": "aung2ieCho3aiph7Een3Ei",
}

STEP_ACCOUNT = "account"
STEP_CERT = "cert"


def session_token(email: str, password: str) -> str:
    """Sign in to the DDL account -> the session token step 3 carries.

    This is the one place a password is handled: it is sent to their endpoint
    and never stored, and what comes back is a session token, not the
    password.
    """
    import requests
    try:
        r = requests.post(SESSIONS_URL, headers=_APP_HEADERS,
                          data={"username": email, "password": password},
                          timeout=20)
    except Exception as e:
        raise pairing.PairingError(
            STEP_ACCOUNT,
            f"Could not reach the account service ({type(e).__name__}). It is "
            "on the internet, not on this network — check this Mac is online.")
    if r.status_code != 200:
        raise pairing.PairingError(
            STEP_ACCOUNT,
            "That account was refused (HTTP "
            f"{r.status_code}). It has to be the DDL/Anki account the robot "
            "was set up with — the same one used at vector-setup.ddl.io.")
    try:
        token = r.json()["session"]["session_token"]
    except Exception:
        raise pairing.PairingError(
            STEP_ACCOUNT,
            "The account service answered in a shape this does not "
            "understand, which usually means their API changed.")
    if not token:
        raise pairing.PairingError(
            STEP_ACCOUNT, "The account service returned an empty session.")
    return token


def fetch_cert(serial: str) -> bytes:
    """The robot's certificate, by serial. Their endpoint asks for no auth.

    A 404 here is the useful answer, not an error to retry: it means this
    robot has never been set up through DDL, so there is nothing to fetch.
    """
    import requests
    serial = (serial or "").strip().lower()
    if not serial:
        raise pairing.PairingError(STEP_CERT, "No serial to ask about.")
    try:
        r = requests.get(DEVICE_CERT_URL.format(serial=serial), timeout=20)
    except Exception as e:
        raise pairing.PairingError(
            STEP_CERT,
            f"Could not reach the certificate service ({type(e).__name__}).")
    if r.status_code == 404:
        raise pairing.PairingError(
            STEP_CERT,
            f"DDL holds no certificate for '{serial}'. He has not been set up "
            "through their web tool yet — do that first at "
            "vector-setup.ddl.io, then come back here.")
    if r.status_code != 200:
        raise pairing.PairingError(
            STEP_CERT,
            f"The certificate service refused (HTTP {r.status_code}).")
    return r.content


def pair(email: str, password: str, serial: str, name: str, ip: str) -> dict:
    """Full official pairing: account -> certificate -> guid -> config.

    Ends where the wire-pod path ends, with credentials on this Mac that the
    game server picks up without knowing which route wrote them.
    """
    token = session_token(email, password)
    cert = fetch_cert(serial)
    pairing.validate_cert_name(cert, name)
    cert_file = pairing.save_cert(cert, name, serial)
    guid = pairing.mint_guid(cert, ip, name, session_id=token.encode("utf-8"))
    pairing.write_config(serial, cert_file, ip, name, guid)
    logger.info("paired %s (%s) through the DDL account", name, serial)
    return {"serial": serial, "name": name, "ip": ip, "cert": cert_file}
