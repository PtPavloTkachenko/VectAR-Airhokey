"""Restore SSH access to an OSKR robot over BLE (no adb, no USB).

A Clear User Data wipe deletes `/data/ssh/authorized_keys`, so an OSKR robot
keeps sshd running but rejects every key. The RTS protocol can install
authorized_keys over the encrypted BLE channel (RtsSshRequest), which is the
only remaining door — and it's a stock feature, no OSKR-specific tooling.

With SSH back, `onboarding.oskr_provision` points the robot's cloud at wire-pod
and the pairing wizard completes.

Usage:
    # robot on the charger, then double-press its backpack button first
    python -m onboarding.restore_ssh --pub ~/.ssh/id_rsa.pub --ip 172.20.10.2

`--pub` defaults to the public half derived from --key, so the usual call is
just `python -m onboarding.restore_ssh --ip <robot-ip>`.
"""
from __future__ import annotations

import argparse
import asyncio
import subprocess
import sys
from pathlib import Path

from .ble.session import RtsSession


def derive_pub(key_path: str) -> str:
    p = subprocess.run(["ssh-keygen", "-y", "-f", key_path],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"could not derive a public key from {key_path}: "
                         f"{p.stderr.strip()}")
    return p.stdout.strip()


async def read_pin(pin_file: str, timeout: float) -> str:
    """Read the 6-digit PIN, from the terminal when there is one, otherwise from
    a file. The PIN only appears on Vector's face AFTER the BLE handshake
    starts, so it can't be passed up front; agents/CI drop it into `pin_file`
    (`echo 123456 > /tmp/vector_pin`) while this waits."""
    if sys.stdin is not None and sys.stdin.isatty():
        return input("PIN shown on Vector's face: ").strip()
    p = Path(pin_file)
    p.unlink(missing_ok=True)
    print(f"PIN is on Vector's face — write it to {pin_file} "
          f"(echo 123456 > {pin_file}); waiting {timeout:.0f}s…", flush=True)
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if p.is_file():
            pin = p.read_text().strip()
            if len(pin) == 6 and pin.isdigit():
                p.unlink(missing_ok=True)
                print(f"got PIN from {pin_file}", flush=True)
                return pin
        await asyncio.sleep(1.0)
    raise SystemExit(f"no PIN appeared in {pin_file} within {timeout:.0f}s")


def ssh_works(ip: str, key: str) -> bool:
    p = subprocess.run(
        ["ssh", "-i", key, "-o", "ConnectTimeout=12", "-o", "BatchMode=yes",
         "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
         "-o", "HostkeyAlgorithms=+ssh-rsa",
         "-o", "StrictHostKeyChecking=no",
         "-o", "UserKnownHostsFile=/dev/null",
         f"root@{ip}", "echo ok"],
        capture_output=True, text=True)
    return p.returncode == 0 and "ok" in p.stdout


async def run(args) -> int:
    pub = (Path(args.pub).read_text().strip() if args.pub
           else derive_pub(args.key))
    print(f"key to install: {pub[:48]}… ({len(pub)} bytes)")

    if args.ip and ssh_works(args.ip, args.key):
        print("SSH already works — nothing to restore.")
        return 0

    print("scanning for the robot over BLE "
          "(double-press his backpack button now)…")
    found = await RtsSession.scan(timeout=args.scan_timeout)
    if not found:
        print("no Vector advertising. Put him on the charger and double-press "
              "the back button, then retry.", file=sys.stderr)
        return 2
    dev = found[0]
    print(f"connecting to {dev.get('name') or dev.get('address')}…")

    sess = RtsSession()
    await sess.connect(dev["address"], dev.get("name"))
    try:
        await sess.begin_handshake()
        pin = args.pin or await read_pin(args.pin_file, args.pin_timeout)
        await sess.finish_handshake(pin)
        print("encrypted channel up — installing authorized_keys…")
        await sess.install_ssh_key(pub + "\n")
    finally:
        try:
            await sess.disconnect()
        except Exception:
            pass

    if args.ip:
        print("verifying SSH…")
        await asyncio.sleep(2)
        if ssh_works(args.ip, args.key):
            print(f"SSH RESTORED ✅  next: python -m onboarding.oskr_provision "
                  f"--ip {args.ip}")
            return 0
        print("key installed but SSH still refuses — the robot may need a "
              "reboot, or this build ignores BLE key provisioning.",
              file=sys.stderr)
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--key", default="/tmp/vector_key",
                    help="ssh private key (its public half is installed)")
    ap.add_argument("--pub", default="", help="explicit public key file")
    ap.add_argument("--ip", default="", help="robot IP, to verify SSH after")
    ap.add_argument("--pin", default="", help="skip the prompt")
    ap.add_argument("--pin-file", default="/tmp/vector_pin",
                    help="where to read the PIN when there's no terminal")
    ap.add_argument("--pin-timeout", type=float, default=120.0)
    ap.add_argument("--scan-timeout", type=float, default=8.0)
    return asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
