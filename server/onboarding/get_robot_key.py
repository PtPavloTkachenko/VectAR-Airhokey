"""Recover THIS robot's own SSH key from its logs over BLE, using a narrowed
request so we don't pull the whole ~149k-packet bundle.

The robot trusts two keys: its own /data/ssh/id_rsa_Vector-XXXX (regenerated on
every Clear User Data) and DDL's dev key (whose private half DDL never
published). So the only key we can obtain is the robot's own, and the only
channel is the BLE log bundle — but RtsLogRequest has Mode + Filter, so we try
to make it send just /data/ssh.

One config per run (a log stream can't be cleanly aborted mid-way to try
another). It reads the first packet to learn PacketTotal:
  * small  -> downloads the rest and extracts the key, then prints where it went
  * huge   -> reports that this mode/filter doesn't narrow it, and stops

Run (robot on charger, then double-press his backpack):
    python -m onboarding.get_robot_key --mode 0 --filter /data/ssh
PIN: type it when asked, or (no TTY) echo it to /tmp/vector_pin.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from .ble import messages as m
from .ble.session import RtsSession
from . import oskr_provision as prov


async def read_pin(pin_file: str, timeout: float) -> str:
    if sys.stdin is not None and sys.stdin.isatty():
        return input("PIN on Vector's face: ").strip()
    p = Path(pin_file); p.unlink(missing_ok=True)
    print(f"PIN is on his face — echo it: echo 123456 > {pin_file}", flush=True)
    loop = asyncio.get_event_loop(); end = loop.time() + timeout
    while loop.time() < end:
        if p.is_file():
            v = p.read_text().strip()
            if len(v) == 6 and v.isdigit():
                p.unlink(missing_ok=True); return v
        await asyncio.sleep(1.0)
    raise SystemExit("no PIN provided")


async def run(a) -> int:
    filters = [a.filter] if a.filter else None
    print(f"config: mode={a.mode} filter={filters}")
    print("scanning BLE (double-press his backpack now)…")
    found = await RtsSession.scan(timeout=a.scan_timeout)
    if not found:
        print("no Vector advertising.", file=sys.stderr); return 2
    dev = found[0]
    print(f"connecting to {dev.get('name') or dev['address']}…")
    sess = RtsSession()
    await sess.connect(dev["address"], dev.get("name"))
    try:
        await sess.begin_handshake()
        await sess.finish_handshake(await read_pin(a.pin_file, a.pin_timeout))
        print("channel up — requesting logs…")

        # peek the first packet for PacketTotal without committing to a download
        await sess._send(m.log_request(mode=a.mode, filters=filters,
                                       version=sess.version))
        loop = asyncio.get_event_loop(); deadline = loop.time() + 40
        first = None
        while loop.time() < deadline:
            mt, pl = await sess._recv(timeout=15.0)
            if mt == m.LOG_RESPONSE:
                r = m.parse_log_response(pl)
                if r["exit_code"] != 0:
                    print(f"robot refused (exit {r['exit_code']})"); return 1
                continue
            if mt == m.FILE_DOWNLOAD:
                first = m.parse_file_download(pl); break
        if not first:
            print("no file stream started."); return 1

        total = first["total"]
        print(f"PacketTotal = {total}")
        if total > a.max_packets:
            print(f"too big (> {a.max_packets}); this mode/filter doesn't narrow "
                  "it. Try another --mode/--filter, or use the Vector app's "
                  "Send Logs to get the bundle faster.")
            return 1

        # small enough — collect the rest (we already have packet `first`)
        print("small enough — downloading…")
        chunks = {first["packet"]: first["chunk"]}
        while len(chunks) < total and loop.time() < deadline + a.download_timeout:
            mt, pl = await sess._recv(timeout=30.0)
            if mt != m.FILE_DOWNLOAD:
                continue
            d = m.parse_file_download(pl)
            chunks[d["packet"]] = d["chunk"]
            if len(chunks) % 20 == 0:
                print(f"  {len(chunks)}/{total}")
        blob = b"".join(chunks[k] for k in sorted(chunks))
        print(f"got {len(blob)} bytes across {len(chunks)} packets")
    finally:
        try:
            await sess.disconnect()
        except Exception:
            pass

    key = prov.extract_ssh_key(blob)
    if not key:
        Path(a.save_bundle).write_bytes(blob)
        print(f"no SSH key found in the bundle; saved it to {a.save_bundle} for "
              "inspection.")
        return 1
    dest = prov.save_ssh_key(key, Path(a.out).expanduser())
    print(f"\n✅ recovered the robot's SSH key -> {dest}")
    print(f"   next: python -m onboarding.oskr_provision --ip {a.ip} "
          f"--key {dest}" if a.ip else
          f"   next: run oskr_provision with --key {dest}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mode", type=int, default=0)
    ap.add_argument("--filter", default="/data/ssh",
                    help="path/glob to narrow the bundle; empty for everything")
    ap.add_argument("--max-packets", type=int, default=4000,
                    help="abort if PacketTotal exceeds this")
    ap.add_argument("--out", default="~/.vectar/id_rsa_robot")
    ap.add_argument("--ip", default="", help="robot IP (for the provision follow-up)")
    ap.add_argument("--save-bundle", default="/tmp/vector_logs.bin")
    ap.add_argument("--pin-file", default="/tmp/vector_pin")
    ap.add_argument("--pin-timeout", type=float, default=120.0)
    ap.add_argument("--scan-timeout", type=float, default=12.0)
    ap.add_argument("--download-timeout", type=float, default=180.0)
    return asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
