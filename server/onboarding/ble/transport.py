"""Vector RTS BLE transport — bleak GATT + 20-byte fragmentation.

GATT (RE'd, DECISIONS #74):
  service   0000fee3-...     (RTS)
  write     7d2a4bda-...     write-WITH-response, app -> robot
  notify    30619f2d-...     robot -> app

Framing: every GATT packet is <=20 bytes. Byte 0 is a header:
  header = (multipart << 6) | (size & 0x3F)
  multipart: 0=SOLO (whole msg in one packet), 1=START, 2=CONTINUE, 3=END
  size: number of payload bytes in THIS packet (1..19)
A logical message is the concatenation of one SOLO, or START..CONTINUE*..END.
"""
from __future__ import annotations

import asyncio
import logging

from bleak import BleakClient, BleakScanner

logger = logging.getLogger("vectar.ble.transport")

RTS_SERVICE = "0000fee3-0000-1000-8000-00805f9b34fb"
WRITE_CHAR = "7d2a4bda-d29b-4152-b725-2491478c5cd7"
NOTIFY_CHAR = "30619f2d-0f54-41bd-a65a-7588d8c85b45"

PACKET_SIZE = 20
MAX_PAYLOAD = PACKET_SIZE - 1  # 19

# 2-bit multipart codes (vector-bluetooth/ble/conn/receive.go:6-9)
CONTINUE, END, START, SOLO = 0b00, 0b01, 0b10, 0b11


def frame(message: bytes) -> list[bytes]:
    """Split a logical message into <=20-byte GATT packets (§B)."""
    if len(message) < PACKET_SIZE:
        return [bytes([(SOLO << 6) | len(message)]) + message]
    packets = []
    off, n = 0, len(message)
    while off < n:
        chunk = message[off:off + MAX_PAYLOAD]
        if off == 0:
            mp = START
        elif off + len(chunk) >= n:
            mp = END
        else:
            mp = CONTINUE
        off += len(chunk)
        packets.append(bytes([(mp << 6) | len(chunk)]) + chunk)
    return packets


class _Reassembler:
    def __init__(self):
        self._buf = bytearray()

    def feed(self, packet: bytes) -> bytes | None:
        """Return a complete logical message, or None if still assembling.
        Drops malformed packets (size byte must equal payload length)."""
        if not packet:
            return None
        header = packet[0]
        mp = (header >> 6) & 0x3
        size = header & 0x3F
        if size != len(packet) - 1:            # receive.go:59-65 validation
            return None
        payload = packet[1:1 + size]
        if mp == SOLO:
            self._buf = bytearray()
            return bytes(payload)
        if mp == START:
            self._buf = bytearray(payload)
            return None
        # CONTINUE or END
        self._buf.extend(payload)
        if mp == END:
            msg = bytes(self._buf)
            self._buf = bytearray()
            return msg
        return None


class VectorBLE:
    """Async GATT link to a Vector in pairing mode. Fragments outgoing and
    reassembles incoming logical messages; delivers them to `on_message`."""

    def __init__(self):
        self._client: BleakClient | None = None
        self._reasm = _Reassembler()
        self._inbox: asyncio.Queue[bytes] = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._connected = False   # low-level RTS connection handshake done
        self.version: int | None = None
        self.name: str | None = None
        self.address: str | None = None

    @staticmethod
    async def scan(timeout: float = 6.0) -> list[dict]:
        """Return Vectors currently advertising for pairing.

        A Vector advertises for BLE onboarding only after a backpack
        double-press on the charger. The pairing flag lives in
        manufacturer data ([3] == ord('p')).
        """
        found: dict[str, dict] = {}

        def cb(dev, adv):
            name = adv.local_name or (dev.name or "")
            # Vector's name is often None on macOS CoreBluetooth, so match on
            # the RTS service UUID (fee3) — that's what the Go lib keys on too.
            svcs = [str(u).lower() for u in (adv.service_uuids or [])]
            is_vector = name.startswith("Vector") or any(
                "fee3" in u for u in svcs)
            if not is_vector:
                return
            pairing = False
            for _cid, data in (adv.manufacturer_data or {}).items():
                if len(data) > 3 and data[3] == ord("p"):
                    pairing = True
            found[dev.address] = {
                "address": dev.address, "name": name or "Vector",
                "rssi": adv.rssi, "pairing": pairing,
            }

        scanner = BleakScanner(detection_callback=cb)
        await scanner.start()
        await asyncio.sleep(timeout)
        await scanner.stop()
        return sorted(found.values(), key=lambda r: -r["rssi"])

    async def connect(self, address: str, name: str | None = None) -> None:
        self._loop = asyncio.get_running_loop()
        self._client = BleakClient(address)
        await self._client.connect()
        self.address = address
        self.name = name

        def _notify(_char, data: bytearray):
            raw = bytes(data)
            logger.debug(f"RX packet [{len(raw)}]: {raw.hex()}")
            msg = self._reasm.feed(raw)
            if msg is None:
                return
            logger.debug(f"RX message [{len(msg)}]: {msg.hex()}")
            # The FIRST complete message is the low-level RTS connection
            # handshake: echo the raw packet verbatim, record the version
            # (byte 2 of the raw packet), enable the connection — do NOT hand
            # it to the RTS layer. (vector-bluetooth conn/connect.go:161-165)
            if not self._connected:
                self._connected = True
                self.version = raw[2] if len(raw) > 2 else None
                logger.debug(f"conn handshake: echo verbatim, version="
                             f"{self.version}")
                self._loop.create_task(self._raw_write(raw))
                return
            self._inbox.put_nowait(msg)

        await self._client.start_notify(NOTIFY_CHAR, _notify)
        logger.info(f"BLE connected to {name or address}")

    async def _raw_write(self, packet: bytes) -> None:
        assert self._client is not None
        await self._client.write_gatt_char(WRITE_CHAR, packet, response=True)

    async def send(self, message: bytes) -> None:
        assert self._client is not None
        logger.debug(f"TX message [{len(message)}]: {message.hex()}")
        for pkt in frame(message):
            await self._client.write_gatt_char(WRITE_CHAR, pkt, response=True)

    async def recv(self, timeout: float = 10.0) -> bytes:
        return await asyncio.wait_for(self._inbox.get(), timeout)

    async def disconnect(self) -> None:
        if self._client:
            try:
                await self._client.stop_notify(NOTIFY_CHAR)
            except Exception:
                pass
            await self._client.disconnect()
            self._client = None
