"""Find Vectors on the LAN via mDNS (`_ankivector._tcp.local.`).

mDNS is unreliable on some home networks (repeaters often eat multicast), so
discovery returning [] is a NORMAL outcome, not an error — the wizard always
offers manual IP entry as an equal path.
"""
from __future__ import annotations

import asyncio
import logging
import socket

logger = logging.getLogger("game-bridge.discovery")

SERVICE = "_ankivector._tcp.local."


async def discover(timeout: float = 5.0) -> list[dict]:
    """Browse for ~timeout seconds; returns [{name, ip}] for every responder."""
    try:
        from zeroconf import ServiceStateChange
        from zeroconf.asyncio import AsyncServiceBrowser, AsyncZeroconf
    except ImportError:
        logger.warning("zeroconf not installed — discovery disabled")
        return []

    found: dict[str, dict] = {}
    aiozc = AsyncZeroconf()
    pending: set[asyncio.Task] = set()
    loop = asyncio.get_running_loop()

    def on_change(zeroconf, service_type, name, state_change):
        if state_change is not ServiceStateChange.Added:
            return

        async def resolve():
            info = await aiozc.async_get_service_info(service_type, name,
                                                      timeout=3000)
            if info is None:
                return
            ips = [socket.inet_ntoa(a) for a in info.addresses] \
                if info.addresses else []
            robot = name.split(".")[0]
            if ips:
                found[robot] = {"name": robot, "ip": ips[0]}
                logger.info(f"Discovered {robot} at {ips[0]}")

        task = loop.create_task(resolve())
        pending.add(task)
        task.add_done_callback(pending.discard)

    browser = AsyncServiceBrowser(aiozc.zeroconf, SERVICE,
                                  handlers=[on_change])
    try:
        await asyncio.sleep(timeout)
        if pending:
            await asyncio.wait(pending, timeout=3.0)
    finally:
        await browser.async_cancel()
        await aiozc.async_close()
    return sorted(found.values(), key=lambda r: r["name"])
