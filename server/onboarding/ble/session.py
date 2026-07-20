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
                     tries: int = 3) -> "RtsSession":
    """Connect + run the handshake up to the Nonce (PIN now shows on the
    robot's face), retrying if the robot's first frame doesn't arrive.

    A just-provisioned re-pair sends the first frame immediately; a
    FACTORY-RESET (first-time-pair) robot can take several seconds to start
    the handshake (it generates keys + shows the PIN for the first time), so
    each attempt holds the connection open a long time before giving up —
    tearing down too fast is itself what stalls it."""
    last = None
    for attempt in range(1, tries + 1):
        sess = RtsSession()
        try:
            await sess.connect(address, name)
            await sess.begin_handshake(first_timeout=18.0)
            return sess
        except FirstFrameTimeout as e:
            last = e
            logger.info(f"first frame didn't arrive in 18s (attempt "
                        f"{attempt}/{tries}); reconnecting")
            await sess.disconnect()
            await asyncio.sleep(2.0)
    raise HandshakeError(
        f"Vector connected but never started pairing after {tries} tries. "
        "Make sure his face shows the pairing screen (double-press the "
        "backpack button on the charger), then try again.")


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
        self.esn = ""          # robot serial, read over BLE (status)
        self.ip = ""           # robot LAN IP, read over BLE (wifi_ip)
        self.version = m.V5_TAG  # RTS version the robot chose (echoed on replies)

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
        version, mtype, payload = m.parse_envelope(raw)
        self.version = version   # echo the robot's chosen RTS version on replies
        return mtype, payload

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

        await self._send(m.conn_response(self._app_pk, version=self.version))

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
        await self._send(m.ack(self.version))
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

        await self._send(m.challenge_reply(number, self.version))

        mtype, _ = await self._recv()
        if mtype != m.CHALLENGE_SUCCESS:
            raise HandshakeError(
                f"challenge rejected (got 0x{mtype:02x}) — wrong PIN?")
        logger.info("Handshake complete — encrypted channel established")

    # --- provisioning (§E-G) ---

    async def status(self) -> dict:
        await self._send(m.status_request(self.version))
        mtype, payload = await self._recv()
        if mtype != m.STATUS_RESPONSE:
            raise HandshakeError(f"expected StatusResponse, got 0x{mtype:02x}")
        st = m.parse_status_response(payload, self.version)
        self.esn = st.get("esn", "") or self.esn
        return st

    async def wifi_scan(self) -> list[dict]:
        await self._send(m.wifi_scan_request(self.version))
        mtype, payload = await self._recv(timeout=25.0)
        if mtype != m.WIFI_SCAN_RESPONSE:
            raise HandshakeError(f"expected WifiScanResponse, got 0x{mtype:02x}")
        return m.parse_wifi_scan_response(payload, self.version)["networks"]

    async def wifi_connect(self, ssid: str, password: str,
                           auth_type: int, hidden: bool = False) -> dict:
        await self._send(m.wifi_connect_request(ssid, password, auth_type,
                                                hidden, version=self.version))
        mtype, payload = await self._recv(timeout=30.0)
        if mtype != m.WIFI_CONNECT_RESPONSE:
            raise HandshakeError(
                f"expected WifiConnectResponse, got 0x{mtype:02x}")
        return m.parse_wifi_connect_response(payload, self.version)

    async def wifi_ip(self) -> str:
        await self._send(m.wifi_ip_request(self.version))
        mtype, payload = await self._recv()
        if mtype != m.WIFI_IP_RESPONSE:
            raise HandshakeError(f"expected WifiIpResponse, got 0x{mtype:02x}")
        self.ip = m.parse_wifi_ip_response(payload)["ipv4"] or self.ip
        return self.ip

    async def cloud_auth(self) -> str:
        """Mint the SDK GUID over BLE (RtsCloudSessionRequest_5)."""
        await self._send(m.cloud_session_request(SESSION_TOKEN, self.version))
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

    async def robot_state(self) -> dict:
        """{state, firmware, esn} — which provisioning path this robot needs.

        `state` is one of messages.STATE_* (see classify_robot). The wizard uses
        it to branch: stock -> escape-pod flash, OSKR/dev -> SSH provisioning,
        ep -> already provisioned.
        """
        st = await self.status()
        fw = st.get("firmware", "")
        return {"state": m.classify_robot(fw), "firmware": fw,
                "esn": st.get("esn", ""), "wifi_state": st.get("wifi_state")}

    async def ota_flash(self, url: str, progress_cb=None,
                        timeout: float = 900.0) -> dict:
        """Flash an OTA (the escape-pod firmware) over BLE and follow progress.

        This is the missing provisioning step for a plain STOCK robot: the ep
        firmware ships `server_config -> escapepod.local` and trusts wire-pod's
        cert, so afterwards the robot reaches wire-pod on ANY Wi-Fi (no OSKR, no
        DNS override). Mirrors wire-pod `BleClient.OTAStart` + its status loop.

        The robot streams RtsOtaUpdateResponse frames as it downloads/writes;
        it reboots into the new firmware when current == expected (the BLE link
        drops at that point, which is success, not an error).
        """
        await self._send(m.ota_start_request(url, self.version))
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        last = {"status": 0, "current": 0, "expected": 0, "percent": 0.0,
                "done": False}
        while loop.time() < deadline:
            try:
                mtype, payload = await self._recv(timeout=60.0)
            except Exception as e:
                # The robot reboots into the new image mid-stream -> the link
                # drops. If we had real progress, treat it as a completed flash.
                if last["current"] > 0:
                    logger.info("OTA link closed after %.1f%% — robot is "
                                "rebooting into the new firmware", last["percent"])
                    last["done"] = True
                    return last
                raise HandshakeError(f"OTA failed before any progress: {e}")
            if mtype != m.OTA_UPDATE_RESPONSE:
                continue
            last = m.parse_ota_update_response(payload)
            if callable(progress_cb):
                progress_cb(last)
            if last["status"] not in (0, 1):
                raise HandshakeError(
                    f"OTA rejected by the robot (status {last['status']}). "
                    "A stock robot may need to be in recovery mode "
                    "(hold the backpack button ~15 s until anki.com/v).")
            if last["done"]:
                logger.info("OTA complete (%d bytes) — robot is rebooting",
                            last["current"])
                return last
        raise HandshakeError(f"OTA timed out after {timeout:.0f}s")

    async def ota_cancel(self) -> None:
        await self._send(m.ota_cancel_request(self.version))

    async def _sdk_proxy(self, url_path: str, json_body: str) -> dict:
        await self._send(m.sdk_proxy_request(self.guid, url_path, json_body, version=self.version))
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
