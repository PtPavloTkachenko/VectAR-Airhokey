"""Mint the SDK guid over BLE (RtsCloudSession) — the primary-user association
that the NETWORK UserAuthentication skips (and why it returns an empty guid).

This is how onboarding actually worked: the BLE CloudSession makes the robot
authenticate with its cloud (now wire-pod) as the primary user, which mints AND
persists the token. After this, the network SDK connects and the dashboard sees
the robot. Our robot points at wire-pod (SESSION_TOKEN is what wire-pod accepts),
so — unlike a stock robot whose Anki cloud is gone — this should succeed.

Run (robot on charger, double-press backpack so it advertises + shows a PIN):
    python -m onboarding.mint_guid_ble
Then put the 6-digit PIN in /tmp/vector_pin:  echo 123456 > /tmp/vector_pin
"""
from __future__ import annotations

import asyncio
import configparser
import sys
from pathlib import Path

from .ble import messages as m
from .ble.session import RtsSession

PIN_FILE = "/tmp/vector_pin"
ANKI_DIR = Path.home() / ".anki_vector"
SERIAL = "0dd1dfd4"
NAME = "Vector-X1W8"


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
    with open(cfg_file, "w") as f:
        cfg.write(f)
    print(f"guid written to {cfg_file} [{serial}]")


async def run() -> int:
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
        print("channel up — requesting cloud auth (RtsCloudSession)…", flush=True)
        guid = await sess.cloud_auth()
        print(f"\n*** GUID MINTED over BLE: {guid!r} (len {len(guid)}) ***\n",
              flush=True)
        if guid:
            save_guid(SERIAL, guid)
            print("SUCCESS — primary association done, guid persisted.")
            return 0
        print("cloud_auth returned an EMPTY guid.")
        return 1
    finally:
        try:
            await sess.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
