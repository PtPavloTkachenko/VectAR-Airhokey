"""Publish this Mac under a stable name, so the Lens never carries an IP.

A Lens hard-codes the bridge URL, the Mac's address moves with DHCP, and the
result is glasses that silently never connect — a failure that looks like a
broken server and costs a debugging session to trace. (It did: the Mac moved
from .118 to .204 and three lens copies kept dialling the old one.)

A name fixes it permanently: `ws://vectar.local:8777` follows the Mac wherever
DHCP puts it, on any network, for every Lens at once.

wire-pod already publishes `escapepod.local`, but that belongs to the pairing
flow — our own docs say wire-pod is only needed while pairing, so a Lens
pointed at it breaks the moment you stop it. Hence our own record, owned by
the game server and alive exactly as long as it is.
"""
from __future__ import annotations

import logging
import os
import socket

logger = logging.getLogger("game-bridge.mdns")

# `vectar` -> vectar.local
NAME = os.getenv("VECTAR_MDNS_NAME", "vectar")


class Responder:
    """Registers <NAME>.local -> this machine for as long as it's open."""

    def __init__(self, ip: str, port: int):
        self.ip = ip
        self.port = port
        self._zc = None
        self._info = None

    def start(self) -> bool:
        try:
            from zeroconf import ServiceInfo, Zeroconf
        except ImportError:
            logger.info("zeroconf not installed — skipping the .local name "
                        "(the Lens then needs the IP)")
            return False
        if not self.ip:
            return False
        try:
            self._zc = Zeroconf()
            self._info = ServiceInfo(
                "_vectar._tcp.local.",
                f"VectAR._vectar._tcp.local.",
                addresses=[socket.inet_aton(self.ip)],
                port=self.port,
                # `server` is what actually creates the A record we care
                # about; the service type just carries it.
                server=f"{NAME}.local.",
                properties={"role": "game-bridge"},
            )
            self._zc.register_service(self._info)
            logger.info(f"published {NAME}.local -> {self.ip} "
                        f"(lens can use ws://{NAME}.local:{self.port})")
            return True
        except Exception as e:
            # Never fatal: the server is perfectly usable over its IP.
            logger.warning(f"could not publish {NAME}.local: {e}")
            self._zc = None
            return False

    def stop(self):
        try:
            if self._zc and self._info:
                self._zc.unregister_service(self._info)
            if self._zc:
                self._zc.close()
        except Exception as e:
            logger.debug(f"mdns stop: {e}")
        finally:
            self._zc = None
            self._info = None
