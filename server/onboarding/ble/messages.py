"""RTS v5 message codec.

Wire envelope (post-decrypt, and the input to encryption):
    byte0 = 0x04   ExternalCommsTag_RtsConnection
    byte1 = 0x05   RtsConnection version tag (v5)
    byte2 = <msgType>   RtsConnection_5Tag
    byte3.. = payload   (little-endian; strings u8-len unless noted u16)

Byte layouts and the u16-length exceptions are from the vector-bluetooth Go
structs (external.go) — see docs and the spec in the module header.
"""
from __future__ import annotations

import struct

EXT_TAG = 0x04
V5_TAG = 0x05
# The robot picks the RTS version (2/3/4/5) — it's the 2nd envelope byte of its
# ConnRequest. We must ECHO that same version on every reply. A factory-reset
# robot often negotiates v2; a provisioned one v5. Default v5, overridden live.
SUPPORTED_VERSIONS = (2, 3, 4, 5)

# RtsConnection_5Tag message types (external.go:5475-5510)
CONN_REQUEST = 0x01
CONN_RESPONSE = 0x02
NONCE = 0x03
CHALLENGE = 0x04
CHALLENGE_SUCCESS = 0x05
WIFI_CONNECT_REQUEST = 0x06
WIFI_CONNECT_RESPONSE = 0x07
WIFI_IP_REQUEST = 0x08
WIFI_IP_RESPONSE = 0x09
STATUS_REQUEST = 0x0A
STATUS_RESPONSE = 0x0B
WIFI_SCAN_REQUEST = 0x0C
WIFI_SCAN_RESPONSE = 0x0D
OTA_UPDATE_REQUEST = 0x0E
OTA_UPDATE_RESPONSE = 0x0F
CANCEL_PAIRING = 0x10
ACK = 0x12
SSH_REQUEST = 0x15
OTA_CANCEL_REQUEST = 0x17
CLOUD_SESSION_REQUEST = 0x1D
CLOUD_SESSION_RESPONSE = 0x1E
SDK_PROXY_REQUEST = 0x22
SDK_PROXY_RESPONSE = 0x23

# ConnectionType (external.go:28-31)
CONN_FIRST_TIME_PAIR = 0x00
CONN_RECONNECTION = 0x01


def envelope(msg_type: int, payload: bytes = b"", version: int = V5_TAG) -> bytes:
    return bytes([EXT_TAG, version, msg_type]) + payload


def parse_envelope(data: bytes) -> tuple[int, int, bytes]:
    """(version, msg_type, payload). Raises on malformed / unknown version."""
    if len(data) < 3 or data[0] != EXT_TAG:
        raise ValueError(f"not an RTS message: {data[:4].hex()}")
    version = data[1]
    if version not in SUPPORTED_VERSIONS:
        raise ValueError(f"unsupported RTS version {version} "
                         f"(supported: {SUPPORTED_VERSIONS})")
    return version, data[2], data[3:]


# --- small LE reader ---

class _Reader:
    def __init__(self, buf: bytes):
        self.b = buf
        self.i = 0

    def u8(self) -> int:
        v = self.b[self.i]
        self.i += 1
        return v

    def u16(self) -> int:
        v = struct.unpack_from("<H", self.b, self.i)[0]
        self.i += 2
        return v

    def u32(self) -> int:
        v = struct.unpack_from("<I", self.b, self.i)[0]
        self.i += 4
        return v

    def take(self, n: int) -> bytes:
        v = self.b[self.i:self.i + n]
        self.i += n
        return v

    def bytes_u8(self) -> bytes:
        return self.take(self.u8())

    def bytes_u16(self) -> bytes:
        return self.take(self.u16())

    def bool(self) -> bool:
        return self.u8() != 0


def _u8bytes(b: bytes) -> bytes:
    return bytes([len(b)]) + b


def _u16bytes(b: bytes) -> bytes:
    return struct.pack("<H", len(b)) + b


# === Builders (app -> robot) ===

def conn_response(app_pubkey: bytes, conn_type: int = CONN_FIRST_TIME_PAIR,
                  version: int = V5_TAG) -> bytes:
    # ConnectionType:u8 + PublicKey[32]  (connrequest.go:37-45)
    return envelope(CONN_RESPONSE, bytes([conn_type]) + app_pubkey, version)


def ack(version: int = V5_TAG) -> bytes:
    # single u8 = the NonceMessage tag value 0x03 (nonce.go:34-41)
    return envelope(ACK, bytes([NONCE]), version)


def challenge_reply(number: int, version: int = V5_TAG) -> bytes:
    # Number+1 : u32 (challengeresponse.go:32-38)
    return envelope(CHALLENGE, struct.pack("<I", number + 1), version)


def wifi_scan_request(version: int = V5_TAG) -> bytes:
    return envelope(WIFI_SCAN_REQUEST, b"", version)


def wifi_connect_request(ssid: str, password: str, auth_type: int,
                         hidden: bool = False, timeout: int = 15,
                         version: int = V5_TAG) -> bytes:
    # WifiSsidHex(u8) + Password(u8) + Timeout(u8) + AuthType(u8) + Hidden(bool)
    ssid_hex = ssid.encode().hex().encode("ascii")
    return envelope(WIFI_CONNECT_REQUEST,
                    _u8bytes(ssid_hex) + _u8bytes(password.encode())
                    + bytes([timeout, auth_type, 1 if hidden else 0]), version)


def wifi_ip_request(version: int = V5_TAG) -> bytes:
    return envelope(WIFI_IP_REQUEST, b"", version)


def ota_start_request(url: str, version: int = V5_TAG) -> bytes:
    """RtsOtaUpdateRequest — tell the robot to download+flash an OTA from `url`.

    Layout (external.go RtsOtaUpdateRequest.Pack): Url length (uint_8) + Url
    bytes. This is how wire-pod installs the escape-pod firmware on a stock
    robot (`ble.go` -> BleClient.OTAStart), which is what repoints the robot's
    server_config at escapepod.local. Max URL length is 255.
    """
    raw = url.encode()
    if len(raw) > 255:
        raise ValueError(f"OTA url too long ({len(raw)} > 255): {url}")
    return envelope(OTA_UPDATE_REQUEST, bytes([len(raw)]) + raw, version)


def ota_cancel_request(version: int = V5_TAG) -> bytes:
    """RtsOtaCancelRequest — abort an in-flight OTA (no payload)."""
    return envelope(OTA_CANCEL_REQUEST, b"", version)


def parse_ota_update_response(payload: bytes) -> dict:
    """RtsOtaUpdateResponse = Status(uint_8) + Current(uint_64) + Expected(uint_64).

    `current`/`expected` are byte counters -> download/flash progress. Status 0
    means "in progress / ok"; the robot reboots into the new firmware once
    current == expected.
    """
    status = payload[0] if payload else 0
    current = expected = 0
    if len(payload) >= 17:
        current, expected = struct.unpack_from("<QQ", payload, 1)
    pct = (current / expected * 100.0) if expected else 0.0
    return {"status": status, "current": current, "expected": expected,
            "percent": pct, "done": bool(expected and current >= expected)}


# --- robot state classification (mirrors wire-pod setup/ble.go RobotStatus) ---
# Firmware strings look like:
#   v1.8.1.6051-453e582_os1.8.1.6051ep-1536e0d-...   <- escape-pod build
#   v0.9.0-12efb91_os0.9.0-3e8307e-...               <- recovery mode
STATE_RECOVERY_DEV = "in_recovery_dev"
STATE_RECOVERY_PROD = "in_recovery_prod"
STATE_FIRMWARE_DEV = "in_firmware_dev"      # OSKR / ankidev unit
STATE_FIRMWARE_EP = "in_firmware_ep"        # already escape-pod provisioned
STATE_FIRMWARE_NONEP = "in_firmware_nonep"  # plain stock — needs the ep flash


def is_dev_robot(firmware: str) -> bool:
    """OSKR / dev unit — its firmware string carries `ankidev`."""
    return "ankidev" in (firmware or "").lower()


def classify_robot(firmware: str) -> str:
    """Which provisioning path this robot needs. Drives the wizard branch:
      *_nonep    -> flash the escape-pod firmware over BLE (stock path)
      *_dev      -> SSH provisioning (server_config + cert) — no flash
      *_ep       -> already provisioned, go straight to pairing
      in_recovery* -> robot is in recovery; ready to accept an OTA flash
    """
    fw = (firmware or "").lower()
    dev = is_dev_robot(fw)
    if "0.9.0" in fw:
        return STATE_RECOVERY_DEV if dev else STATE_RECOVERY_PROD
    if dev:
        return STATE_FIRMWARE_DEV
    if "ep-" in fw:
        return STATE_FIRMWARE_EP
    return STATE_FIRMWARE_NONEP


def status_request(version: int = V5_TAG) -> bytes:
    return envelope(STATUS_REQUEST, b"", version)


def cloud_session_request(session_token: str, version: int = V5_TAG) -> bytes:
    # SessionToken(u16) + ClientName(u8, empty) + AppId(u8, empty)
    return envelope(CLOUD_SESSION_REQUEST,
                    _u16bytes(session_token.encode()) + _u8bytes(b"")
                    + _u8bytes(b""), version)


def sdk_proxy_request(client_guid: str, url_path: str, json_body: str,
                      message_id: str = "1", version: int = V5_TAG) -> bytes:
    # ClientGuid(u8) + MessageId(u8) + UrlPath(u8) + Json(u16)
    return envelope(SDK_PROXY_REQUEST,
                    _u8bytes(client_guid.encode()) + _u8bytes(message_id.encode())
                    + _u8bytes(url_path.encode()) + _u16bytes(json_body.encode()),
                    version)


# === Parsers (robot -> app) ===

def parse_conn_request(payload: bytes) -> bytes:
    """returns robot X25519 public key (32 bytes)."""
    return _Reader(payload).take(32)


def parse_nonce(payload: bytes) -> tuple[bytes, bytes]:
    """(to_robot_nonce[24], to_device_nonce[24])."""
    r = _Reader(payload)
    return r.take(24), r.take(24)


def parse_challenge(payload: bytes) -> int:
    return struct.unpack_from("<I", payload, 0)[0]


def parse_wifi_scan_response(payload: bytes, version: int = V5_TAG) -> dict:
    # v2 result = {auth, signal, ssid, hidden}; v3+ adds {provisioned}.
    r = _Reader(payload)
    status = r.u8()
    count = r.u8()
    out = []
    for _ in range(count):
        auth = r.u8()
        signal = r.u8()
        ssid_hex = r.bytes_u8()
        hidden = r.bool()
        provisioned = r.bool() if version >= 3 else False
        try:
            ssid = bytes.fromhex(ssid_hex.decode("ascii")).decode(
                "utf-8", "replace")
        except Exception:
            ssid = ssid_hex.decode("ascii", "replace")
        out.append({"ssid": ssid, "auth": auth, "signal": signal,
                    "hidden": hidden, "provisioned": provisioned})
    out.sort(key=lambda n: -n["signal"])
    return {"status": status, "networks": out}


def parse_wifi_connect_response(payload: bytes, version: int = V5_TAG) -> dict:
    # v2 = {ssid, state}; v3+ adds {result}. WifiState 1=online/connected.
    r = _Reader(payload)
    _ssid_hex = r.bytes_u8()
    state = r.u8()
    if version >= 3:
        result = r.u8()
    else:
        result = 0 if state in (1, 2) else 1   # normalize: 0 = success
    return {"state": state, "result": result}


def parse_wifi_ip_response(payload: bytes) -> dict:
    r = _Reader(payload)
    has_v4 = r.bool()
    has_v6 = r.bool()
    v4 = r.take(4)
    ip = ".".join(str(b) for b in v4) if has_v4 else ""
    return {"has_ipv4": has_v4, "ipv4": ip}


def parse_cloud_session_response(payload: bytes) -> dict:
    r = _Reader(payload)
    success = r.bool()
    status = r.u8()
    guid = r.bytes_u16()
    return {"success": success, "status": status,
            "guid": guid.decode("ascii", "replace")}


def parse_sdk_proxy_response(payload: bytes) -> dict:
    r = _Reader(payload)
    message_id = r.bytes_u8()
    status_code = r.u16()
    resp_type = r.bytes_u8()
    body = r.bytes_u16()
    return {"status_code": status_code,
            "body": body.decode("utf-8", "replace")}


def parse_status_response(payload: bytes, version: int = V5_TAG) -> dict:
    # v2 = {ssid, state, ap, ble, battery, fw, ota} — NO esn/owner/cloud.
    # v3+ inserts esn after fw, then ota, and (v5) adds owner + cloud flags.
    r = _Reader(payload)
    _ssid_hex = r.bytes_u8()
    wifi_state = r.u8()
    _access_point = r.bool()
    ble_state = r.u8()
    battery_state = r.u8()
    fw = r.bytes_u8()
    out = {"wifi_state": wifi_state, "ble_state": ble_state,
           "battery_state": battery_state,
           "firmware": fw.decode("ascii", "replace"),
           "esn": "", "has_owner": False, "is_cloud_authed": False}
    if version >= 3:
        out["esn"] = r.bytes_u8().decode("ascii", "replace")
        _ota = r.bool()
        if version >= 5:
            out["has_owner"] = r.bool()
            out["is_cloud_authed"] = r.bool()
    return out
