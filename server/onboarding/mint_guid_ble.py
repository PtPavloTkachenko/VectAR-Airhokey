"""Mint the SDK guid over BLE (RtsCloudSession) — the primary-user association
that the NETWORK UserAuthentication skips (and why it returns an empty guid).

This is how onboarding actually worked: the BLE CloudSession makes the robot
authenticate with its cloud (now wire-pod) as the primary user, which mints AND
persists the token. After this, the network SDK connects and the dashboard sees
the robot.

A Vector never contacts his token server on his own, so this message is the
whole trigger — without it the robot sits on Wi-Fi talking to nobody and
`/session-certs/<esn>` stays 404 forever. It is needed once per robot, on both
paths: a stock robot after the firmware install, and a dev (OSKR) robot after
his cloud is repointed over SSH.

Run (robot on charger, double-press the backpack so he advertises + shows a PIN):
    python -m onboarding.mint_guid_ble
    python -m onboarding.mint_guid_ble --serial 00e20145   # override identity

Then put the 6-digit PIN in /tmp/vector_pin:  echo 123456 > /tmp/vector_pin
"""
from __future__ import annotations

import argparse
import asyncio
import configparser
import sys
from pathlib import Path

from .ble.session import RtsSession

PIN_FILE = "/tmp/vector_pin"
ANKI_DIR = Path.home() / ".anki_vector"


async def read_pin(timeout: float = 150.0) -> str:
    if sys.stdin is not None and sys.stdin.isatty():
        return input("PIN on Vector's face: ").strip()
    p = Path(PIN_FILE)
    p.unlink(missing_ok=True)
    print(f"PIN is on his face — echo it:  echo 123456 > {PIN_FILE}", flush=True)
    loop = asyncio.get_event_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if p.is_file():
            v = p.read_text().strip()
            if len(v) == 6 and v.isdigit():
                p.unlink(missing_ok=True)
                return v
        await asyncio.sleep(1.0)
    raise SystemExit("no PIN provided in time")


def save_guid(serial: str, guid: str) -> None:
    """Write the minted guid into ~/.anki_vector/sdk_config.ini [serial]."""
    cfg_file = ANKI_DIR / "sdk_config.ini"
    cfg = configparser.ConfigParser(strict=False)
    if cfg_file.exists():
        cfg.read(cfg_file)
    if serial not in cfg:
        cfg[serial] = {}
    cfg[serial]["guid"] = guid
    ANKI_DIR.mkdir(parents=True, exist_ok=True)
    with open(cfg_file, "w") as f:
        cfg.write(f)
    print(f"guid written to {cfg_file} [{serial}]")


async def run(serial: str = "", name: str = "") -> int:
    print("scanning BLE (double-press his backpack now)…", flush=True)
    found = await RtsSession.scan(timeout=12.0)
    if not found:
        print("no Vector advertising.", file=sys.stderr)
        return 2
    dev = found[0]
    print(f"connecting to {dev.get('name') or dev['address']}…", flush=True)
    sess = RtsSession()
    await sess.connect(dev["address"], dev.get("name"))
    try:
        await sess.begin_handshake()
        await sess.finish_handshake(await read_pin())
        # Identity comes from the robot we just connected to, not from a
        # constant: this tool has to work for whichever Vector is in the room.
        serial = serial or (sess.esn or "")
        name = name or (sess.name or "")
        print(f"channel up with {name or 'Vector'} ({serial or 'serial unknown'})"
              " — requesting cloud auth (RtsCloudSession)…", flush=True)
        guid = await sess.cloud_auth()
        print(f"\n*** GUID MINTED over BLE: {guid!r} (len {len(guid)}) ***\n",
              flush=True)
        if not guid:
            print("cloud_auth returned an EMPTY guid.")
            return 1
        if not serial:
            print("Minted, but the robot did not report a serial over BLE — "
                  "re-run with --serial to persist it.")
            return 1
        save_guid(serial, guid)
        print("SUCCESS — primary association done, guid persisted.")
        return 0
    finally:
        try:
            await sess.disconnect()
        except Exception:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--serial", default="",
                    help="robot ESN (default: whatever he reports over BLE)")
    ap.add_argument("--name", default="",
                    help="robot name, e.g. Vector-A1B2 (default: from BLE)")
    a = ap.parse_args()
    return asyncio.run(run(a.serial, a.name))


if __name__ == "__main__":
    sys.exit(main())
