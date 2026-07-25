"""Set up a dev (OSKR) robot end to end: repoint his cloud, then mint.

`oskr_provision` only tells the robot WHERE his cloud is. That alone never
produces a usable robot, because a Vector does not contact his token server on
his own — something has to ask him to sign in, and only then does the pairing
engine hold a session certificate for his serial and the SDK guid can be
minted. Running those two halves as one flow is the whole point of this module:
it is what the wizard drives, and what you can drive from a terminal to prove
the path without a browser.

    python -m onboarding.oskr_setup --ip <robot-ip>
    python -m onboarding.oskr_setup            # find him by who accepts our key

The BLE half needs the robot advertising (double-press his backpack) and a PIN,
so it is opt-in: `--ble`. It is only needed once per robot, and not at all if
the engine already holds a certificate for him from an earlier setup.
"""
from __future__ import annotations

import argparse
import re
import sys
import time

from . import oskr_provision as prov


def robot_identity(ip: str, key: str) -> tuple[str, str]:
    """(serial, name) read off the robot over SSH.

    The serial is the one thing pairing cannot guess, and unlike the stock path
    there is no BLE session to ask. The robot's factory cloud certificate
    carries it as `CN=vic:<esn>`; `emr-cat` is the fallback for builds that
    keep /factory locked down.
    """
    _, name = prov.ssh(ip, key, "hostname")
    name = name.strip()

    serial = ""
    _, out = prov.ssh(
        ip, key,
        "for f in /factory/cloud/*.crt /factory/cloud/*.cert; do "
        "  [ -f \"$f\" ] && openssl x509 -in \"$f\" -noout -subject 2>/dev/null; "
        "done")
    m = re.search(r"vic:([0-9a-fA-F]{8})", out or "")
    if m:
        serial = m.group(1).lower()
    if not serial:
        _, out = prov.ssh(ip, key, "emr-cat e 2>/dev/null | head -5")
        m = re.search(r"([0-9a-fA-F]{8})", out or "")
        if m:
            serial = m.group(1).lower()
    return serial, name


def wait_for_robot(ip: str, key: str, timeout: float = 180.0,
                   on_wait=None) -> bool:
    """Block until the robot answers SSH again after his reboot.

    He drops off the network entirely for a while, so an immediate retry looks
    like a hard failure. Poll instead.
    """
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if callable(on_wait):
            try:
                on_wait(max(0.0, end - time.monotonic()))
            except Exception:
                pass
        if prov.ssh_reachable(ip, key):
            return True
    return False


def _ble_mint(serial: str, name: str) -> str:
    """Ask the robot to sign in, over BLE. Returns the minted guid (may be '')."""
    import asyncio

    from .mint_guid_ble import run as ble_run

    rc = asyncio.run(ble_run(serial, name))
    if rc != 0:
        raise RuntimeError(
            "the robot did not complete the BLE cloud session — he must be "
            "advertising (double-press his backpack) and the PIN entered")
    return ""


def setup(ip: str = "", key: str = "", pod: str = "", host_mode: str = "auto",
          use_ble: bool = False, log=print) -> dict:
    from game_bridge import config as gconfig
    from game_bridge.web import pairing

    key = key or str(gconfig.ROBOT_SSH_KEY)
    pod = pod or gconfig.WIREPOD_URL

    if not ip:
        log("looking for a robot that accepts our key…")
        ip = prov.find_robot_ip(key) or ""
        if not ip:
            raise SystemExit(
                "No robot on this network accepts that key. Is he awake, and "
                "is this his key? (his name — and his key — change after a "
                "Clear User Data wipe)")
        log(f"found him at {ip}")

    if not prov.ssh_reachable(ip, key):
        raise SystemExit(f"{ip} does not accept {key}.")

    serial, name = robot_identity(ip, key)
    log(f"robot: {name or '(no name)'}  serial: {serial or '(unknown)'}")

    status = prov.provision(ip, key, host_mode, reboot=True)
    if status != "already":
        log("waiting for him to come back from the reboot…")
        if not wait_for_robot(ip, key):
            raise SystemExit(
                "He did not come back within 3 minutes. A Vector off the "
                "charger shuts his stack down when the battery runs out — put "
                "him on the charger and run this again.")
        log("he's back")

    if not serial:
        raise SystemExit(
            "Could not read his serial, so pairing has nothing to ask the "
            "engine for. Pass it with --serial (it is printed under his lift).")

    def on_wait(waited: float):
        log(f"  waiting for his handshake… {waited:.0f}s")

    try:
        result = pairing.pair(pod, serial, name, ip, cert_wait=45.0,
                              on_wait=on_wait)
    except pairing.PairingError as e:
        if e.step != pairing.STEP_CERT or not use_ble:
            hint = ("" if e.step != pairing.STEP_CERT else
                    " Nothing has asked him to sign in yet — re-run with --ble.")
            raise SystemExit(f"{e.message}{hint}")
        log("no certificate for him yet — asking him to sign in over BLE")
        _ble_mint(serial, name)
        result = pairing.pair(pod, serial, name, ip, cert_wait=45.0,
                              on_wait=on_wait)

    log(f"paired {result['name']} ({result['serial']}) at {result['ip']}")
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ip", default="", help="robot LAN IP (default: find him)")
    ap.add_argument("--key", default="", help="his SSH private key")
    ap.add_argument("--pod", default="", help="pairing engine base URL")
    ap.add_argument("--host-mode", choices=("auto", "escapepod", "ip"),
                    default="auto")
    ap.add_argument("--ble", action="store_true",
                    help="if the engine holds no certificate for him, ask him "
                         "to sign in over BLE (needs the backpack press + PIN)")
    a = ap.parse_args()
    setup(a.ip, a.key, a.pod, a.host_mode, a.ble)
    return 0


if __name__ == "__main__":
    sys.exit(main())
