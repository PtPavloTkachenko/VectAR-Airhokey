"""RTS v5 onboarding session — the full flow on top of transport+crypto+codec.

    sess = RtsSession()
    await sess.scan()                      # find Vectors in pairing mode
    await sess.connect(address)
    await sess.begin_handshake()           # -> returns; robot now shows a PIN
    await sess.finish_handshake(pin)       # secure channel established
    nets = await sess.wifi_scan()
    await sess.wifi_connect(ssid, pw, auth)
    ip = await sess.wifi_ip()
    guid = await sess.cloud_auth()         # mint SDK GUID
    await sess.onboard_complete()          # mark onboarding done
    await sess.disconnect()

Encryption turns on right after the plaintext Ack (§C step 5). Every message
after that is XChaCha20-Poly1305; send()/recv() below route through the
channel once `self._chan` exists.
"""
from __future__ import annotations

import asyncio
import logging

from . import messages as m
from .crypto import (SecureChannel, client_session_keys, derive_channel_keys,
                     generate_keypair)
from .transport import VectorBLE

logger = logging.getLogger("vectar.ble.session")

SESSION_TOKEN = "2vMhFgktH3Jrbemm2WHkfGN"  # wire-pod/escape-pod accept this


class HandshakeError(Exception):
    pass


class FirstFrameTimeout(HandshakeError):
    """Robot's first frame missed (subscribe race) — reconnect and retry."""


async def pair_begin(address: str, name: str | None = None,
                     tries: int = 6) -> "RtsSession":
    """Connect + run the handshake up to the Nonce (PIN now shows on the
    robot's face), retrying the CoreBluetooth subscribe/first-frame race.
    Returns a live session awaiting finish_handshake(pin)."""
    last = None
    for attempt in range(1, tries + 1):
        sess = RtsSession()
        try:
            await sess.connect(address, name)
            await sess.begin_handshake(first_timeout=5.0)
            return sess
        except FirstFrameTimeout as e:
            last = e
            logger.info(f"first-frame race (attempt {attempt}); reconnecting")
            await sess.disconnect()
            await asyncio.sleep(1.0)
    raise HandshakeError(f"handshake did not start after {tries} tries ({last})")


class RtsSession:
    def __init__(self):
        self.ble = VectorBLE()
        self._app_pk = b""
        self._app_sk = b""
        self._robot_pk = b""
        self._to_robot_nonce = b""
        self._to_device_nonce = b""
        self._chan: SecureChannel | None = None
        self.guid = ""
        self.name: str | None = None

    # --- discovery / link ---

    @staticmethod
    async def scan(timeout: float = 6.0) -> list[dict]:
        return await VectorBLE.scan(timeout)

    async def connect(self, address: str, name: str | None = None) -> None:
        await self.ble.connect(address, name)
        self.name = name

    async def disconnect(self) -> None:
        await self.ble.disconnect()

    # --- transport with optional encryption ---

    async def _send(self, message: bytes) -> None:
        if self._chan is not None:
            message = self._chan.encrypt(message)
        await self.ble.send(message)

    async def _recv(self, timeout: float = 15.0) -> tuple[int, bytes]:
        raw = await self.ble.recv(timeout)
        if self._chan is not None:
            raw = self._chan.decrypt(raw)
        return m.parse_envelope(raw)

    # --- handshake (§C) ---

    async def begin_handshake(self, first_timeout: float = 6.0) -> None:
        """ConnRequest -> ConnResponse -> Nonce. After this the robot shows a
        6-digit PIN on its face; call finish_handshake(pin).

        Raises FirstFrameTimeout if the robot's first frame never arrives —
        a CoreBluetooth subscribe/first-notify race; the caller should
        reconnect and retry."""
        self._app_pk, self._app_sk = generate_keypair()

        try:
            mtype, payload = await self._recv(first_timeout)
        except Exception:
            raise FirstFrameTimeout()
        if mtype != m.CONN_REQUEST:
            raise HandshakeError(f"expected ConnRequest, got 0x{mtype:02x}")
        self._robot_pk = m.parse_conn_request(payload)

        await self._send(m.conn_response(self._app_pk))

        mtype, payload = await self._recv()
        if mtype != m.NONCE:
            raise HandshakeError(f"expected Nonce, got 0x{mtype:02x}")
        self._to_robot_nonce, self._to_device_nonce = m.parse_nonce(payload)
        logger.info("Handshake primed — robot is showing its PIN")

    async def finish_handshake(self, pin: str) -> None:
        """Ack (plaintext) -> encryption ON -> Challenge(+1) -> Success."""
        pin = pin.strip()
        if len(pin) != 6 or not pin.isdigit():
            raise HandshakeError("PIN must be the 6 digits shown on Vector")

        rx, tx = client_session_keys(self._app_pk, self._app_sk, self._robot_pk)
        dec_key, enc_key = derive_channel_keys(rx, tx, pin)

        # Ack is the LAST plaintext message; encryption turns on right after.
        await self._send(m.ack())
        self._chan = SecureChannel(dec_key, enc_key,
                                   self._to_robot_nonce, self._to_device_nonce)

        try:
            mtype, payload = await self._recv()
        except Exception as e:
            raise HandshakeError(
                "Wrong PIN or handshake failed (could not decrypt the "
                f"robot's challenge): {e}")
        if mtype != m.CHALLENGE:
            raise HandshakeError(f"expected Challenge, got 0x{mtype:02x}")
        number = m.parse_challenge(payload)

        await self._send(m.challenge_reply(number))

        mtype, _ = await self._recv()
        if mtype != m.CHALLENGE_SUCCESS:
            raise HandshakeError(
                f"challenge rejected (got 0x{mtype:02x}) — wrong PIN?")
        logger.info("Handshake complete — encrypted channel established")

    # --- provisioning (§E-G) ---

    async def status(self) -> dict:
        await self._send(m.status_request())
        mtype, payload = await self._recv()
        if mtype != m.STATUS_RESPONSE:
            raise HandshakeError(f"expected StatusResponse, got 0x{mtype:02x}")
        return m.parse_status_response(payload)

    async def wifi_scan(self) -> list[dict]:
        await self._send(m.wifi_scan_request())
        mtype, payload = await self._recv(timeout=25.0)
        if mtype != m.WIFI_SCAN_RESPONSE:
            raise HandshakeError(f"expected WifiScanResponse, got 0x{mtype:02x}")
        return m.parse_wifi_scan_response(payload)["networks"]

    async def wifi_connect(self, ssid: str, password: str,
                           auth_type: int, hidden: bool = False) -> dict:
        await self._send(m.wifi_connect_request(ssid, password, auth_type,
                                                hidden))
        mtype, payload = await self._recv(timeout=30.0)
        if mtype != m.WIFI_CONNECT_RESPONSE:
            raise HandshakeError(
                f"expected WifiConnectResponse, got 0x{mtype:02x}")
        return m.parse_wifi_connect_response(payload)

    async def wifi_ip(self) -> str:
        await self._send(m.wifi_ip_request())
        mtype, payload = await self._recv()
        if mtype != m.WIFI_IP_RESPONSE:
            raise HandshakeError(f"expected WifiIpResponse, got 0x{mtype:02x}")
        return m.parse_wifi_ip_response(payload)["ipv4"]

    async def cloud_auth(self) -> str:
        """Mint the SDK GUID over BLE (RtsCloudSessionRequest_5)."""
        await self._send(m.cloud_session_request(SESSION_TOKEN))
        mtype, payload = await self._recv(timeout=30.0)
        if mtype != m.CLOUD_SESSION_RESPONSE:
            raise HandshakeError(
                f"expected CloudSessionResponse, got 0x{mtype:02x}")
        resp = m.parse_cloud_session_response(payload)
        if not resp["success"]:
            raise HandshakeError(
                f"cloud auth failed (status {resp['status']}) — a stock robot "
                "validates the session token against Anki's cloud, which is "
                "gone; use the vendored wire-pod token path instead.")
        self.guid = resp["guid"]
        return self.guid

    async def _sdk_proxy(self, url_path: str, json_body: str) -> dict:
        await self._send(m.sdk_proxy_request(self.guid, url_path, json_body))
        mtype, payload = await self._recv(timeout=25.0)
        if mtype != m.SDK_PROXY_RESPONSE:
            raise HandshakeError(f"expected SdkProxyResponse, got 0x{mtype:02x}")
        return m.parse_sdk_proxy_response(payload)

    async def onboard_complete(self) -> None:
        await self._sdk_proxy("/v1/send_onboarding_input",
                              '{"onboarding_mark_complete_and_exit": {}}')

    async def reset_onboarding(self) -> None:
        await self._sdk_proxy(
            "/v1/send_onboarding_input",
            '{"onboarding_set_phase_request": {"phase": 2}}')
