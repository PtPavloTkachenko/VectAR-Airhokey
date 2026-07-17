"""WS server: one lens client at a time, JSON router by msg['t']."""
from __future__ import annotations

import asyncio
import time
import logging
from typing import Awaitable, Callable

import websockets
from websockets.asyncio.server import ServerConnection, serve

from . import config, protocol

logger = logging.getLogger("game-bridge.ws")

Handler = Callable[[dict], Awaitable[None] | None]


class WSServer:
    last_msg_at: float = 0.0

    def __init__(self):
        self._handlers: dict[str, Handler] = {}
        self.client: ServerConnection | None = None
        self.client_role: str = ""   # 'lens' (Spectacles) | 'screen' (browser)
        self.on_disconnect: Callable[[], None] | None = None

    @property
    def alive(self) -> bool:
        """A lens is truly present only if it's sending (it pings every ~2s).
        Guards against a half-open socket showing 'connected' forever."""
        import time as _t
        return self.client is not None and (_t.monotonic() - self.last_msg_at) < 6.0

    def on(self, msg_type: str, handler: Handler):
        self._handlers[msg_type] = handler

    async def start(self):
        self._server = await serve(
            self._handle, config.WS_HOST, config.WS_PORT,
            ping_interval=None,  # lens does its own app-level ping
        )
        logger.info(f"WS server listening on :{config.WS_PORT}")

    async def _handle(self, ws: ServerConnection):
        if self.client is not None:
            logger.info("New lens client — closing previous connection")
            try:
                await self.client.close(code=4000, reason="superseded")
            except Exception:
                pass
        self.client = ws
        self.client_role = ""
        self.last_msg_at = time.monotonic()
        peer = ws.remote_address
        logger.info(f"Lens connected: {peer}")
        try:
            async for raw in ws:
                self.last_msg_at = time.monotonic()
                if isinstance(raw, bytes):
                    logger.debug("Ignoring unexpected binary frame")
                    continue
                try:
                    msgs = protocol.decode_many(raw)
                except protocol.ProtocolError as e:
                    logger.warning(f"Bad message: {e}")
                    continue
                for msg in msgs:
                    handler = self._handlers.get(msg["t"])
                    if handler is None:
                        continue
                    result = handler(msg)
                    if asyncio.iscoroutine(result):
                        await result
        except websockets.ConnectionClosed:
            pass
        finally:
            if self.client is ws:
                self.client = None
                self.client_role = ""
                logger.info(f"Lens disconnected: {peer}")
                if self.on_disconnect:
                    self.on_disconnect()

    async def send(self, msg: dict) -> bool:
        ws = self.client
        if ws is None:
            return False
        try:
            await ws.send(protocol.encode(msg))
            return True
        except Exception:
            return False
