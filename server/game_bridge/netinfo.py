"""Facts about the network this Mac is on, measured instead of assumed.

Setting a robot up away from home broke in four places in one morning, and
every one of them was a question nobody was asking:

  * What address are we on *right now*? Both mDNS names are bound to whatever
    the address was at startup. Switch Wi-Fi mid-onboarding and the robot is
    sent to an address that no longer exists, while the log blames the cloud.
  * Is the robot even on our network? A robot remembered from home carries a
    192.168.x address into a 10.x network, and the SDK spends 40 seconds
    failing at it before guessing "another client must hold the robot".
  * Does the name we publish still point at us? `escapepod.local` resolving on
    the Mac proves nothing — the Mac is answering about itself.
  * Is this a LAN link at all? A guest network answers ping in 300 ms and
    blocks client-to-client traffic outright. The robot then cannot reach the
    pairing engine, and the failure surfaces as a token error three steps later.

None of this is exotic: it is one person setting up a robot somewhere that
isn't their living room. Measuring it takes about a second; guessing it cost a
morning.
"""
from __future__ import annotations

import ipaddress
import logging
import re
import socket
import subprocess

logger = logging.getLogger("game-bridge.netinfo")

# A LAN hop is sub-millisecond to a few ms. Anything above this on a link that
# claims to be local means the traffic is being relayed somewhere — the usual
# culprit is a guest/corporate SSID, which also tends to block the
# client-to-client traffic the robot needs.
LAN_RTT_CEILING_MS = 50.0


def lan_ip() -> str:
    """This machine's outbound address. No traffic is sent — a UDP connect
    only makes the kernel pick an interface."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return ""
    finally:
        s.close()


def _netmask_for(ip: str) -> str:
    """The netmask of the interface holding `ip`, read from ifconfig.

    macOS prints it in hex (`netmask 0xfffffe00`). Parsed rather than assumed
    because the assumption people make is /24, and the network that broke us
    was /23 — wide enough that two addresses looking unrelated were in fact
    neighbours.
    """
    if not ip:
        return ""
    try:
        out = subprocess.run(["ifconfig"], capture_output=True, text=True,
                             timeout=4).stdout
    except Exception:
        return ""
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("inet ") or ip not in line:
            continue
        m = re.search(r"netmask\s+(0x[0-9a-fA-F]+|\d+\.\d+\.\d+\.\d+)", line)
        if not m:
            continue
        raw = m.group(1)
        if raw.startswith("0x"):
            v = int(raw, 16)
            return str(ipaddress.IPv4Address(v))
        return raw
    return ""


def same_subnet(a: str, b: str) -> bool | None:
    """True/False, or None when we cannot tell (no address, no mask).

    None matters: "we don't know" must not be reported as "they differ", or a
    preflight starts blocking people over a mask it failed to read.
    """
    if not a or not b:
        return None
    mask = _netmask_for(a)
    if not mask:
        return None
    try:
        net = ipaddress.IPv4Network(f"{a}/{mask}", strict=False)
        return ipaddress.IPv4Address(b) in net
    except Exception:
        return None


def rtt_ms(ip: str, count: int = 3, timeout_s: float = 4.0) -> float | None:
    """Average round-trip in ms, or None if nothing came back.

    None is not the same as "slow": a silent robot and a relayed one need
    different advice, and only the caller knows which it is looking at.
    """
    if not ip:
        return None
    try:
        p = subprocess.run(
            ["ping", "-c", str(count), "-W", "1200", ip],
            capture_output=True, text=True, timeout=timeout_s)
    except Exception:
        return None
    m = re.search(r"=\s*[\d.]+/([\d.]+)/", p.stdout)
    return float(m.group(1)) if m else None


def resolves_to(name: str) -> list[str]:
    """Addresses `name` currently resolves to on this machine.

    Used to catch the stale-announcement case: a published .local name that
    still points at the address we had before the network changed. Note this
    only proves what *this* Mac believes — it says nothing about whether the
    robot can see the name.
    """
    try:
        infos = socket.getaddrinfo(name, None, socket.AF_INET)
    except Exception:
        return []
    return sorted({i[4][0] for i in infos})


def snapshot(robot_ip: str = "") -> dict:
    """One pass over everything above, for a preflight or a status panel."""
    ip = lan_ip()
    out: dict = {
        "lan_ip": ip,
        "netmask": _netmask_for(ip),
        "vectar_local": resolves_to("vectar.local"),
        "escapepod_local": resolves_to("escapepod.local"),
        "robot_ip": robot_ip,
        "robot_same_subnet": None,
        "robot_rtt_ms": None,
    }
    if robot_ip:
        out["robot_same_subnet"] = same_subnet(ip, robot_ip)
        out["robot_rtt_ms"] = rtt_ms(robot_ip)
    return out
