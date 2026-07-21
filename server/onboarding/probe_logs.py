"""Probe the robot's BLE log request to find a mode/filter that returns a SMALL
bundle (we only want /data/ssh out of it — the full bundle is ~149k packets).

For each (mode, filters) we send RtsLogRequest, then read only the FIRST
RtsFileDownload packet, whose PacketTotal tells us how big that bundle would be
— so we learn the size without downloading gigabytes. Whichever config yields a
few packets is the one to use in provision_oskr's download_logs().

Run (robot on charger, then double-press his backpack button):
    python -m onboarding.probe_logs --pin-file /tmp/vector_pin
Then, when it prints "PIN is on Vector's face", drop it in the file:
    echo 123456 > /tmp/vector_pin
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from .ble import messages as m
from .ble.session import RtsSession

# Guesses to map, cheapest-hoped-first. Mode is a uint8; the rootfs showed a
# "vic-log-upload" and a "vic-log-upload.full", hinting at a normal vs full
# split. Filters may be paths or globs; we try the ssh dir a few ways.
PROBES = [
    (0, ["/data/ssh"]),
    (0, ["data/ssh"]),
    (0, ["ssh"]),
    (1, None),
    (2, None),
    (3, None),
    (0, None),   # the known-huge baseline, last, for reference
]


async def probe_one(sess: RtsSession, mode: int, filters, timeout: float) -> int | None:
    """Return PacketTotal for this config, or None if it didn't start."""
    await sess._send(m.log_request(mode=mode, filters=filters, version=sess.version))
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    file_id = None
    while loop.time() < deadline:
        try:
            mtype, payload = await sess._recv(timeout=8.0)
        except Exception:
            return None
        if mtype == m.LOG_RESPONSE:
            r = m.parse_log_response(payload)
            if r["exit_code"] != 0:
                print(f"    exit_code={r['exit_code']} (refused)")
                return None
            file_id = r["file_id"]
            continue
        if mtype == m.FILE_DOWNLOAD:
            d = m.parse_file_download(payload)
            return d["total"]
    return None


async def read_pin(pin_file: str, timeout: float) -> str:
    if sys.stdin is not None and sys.stdin.isatty():
        return input("PIN on Vector's face: ").strip()
    p = Path(pin_file); p.unlink(missing_ok=True)
    print(f"PIN is on Vector's face — echo it: echo 123456 > {pin_file}", flush=True)
    loop = asyncio.get_event_loop(); end = loop.time() + timeout
    while loop.time() < end:
        if p.is_file():
            pin = p.read_text().strip()
            if len(pin) == 6 and pin.isdigit():
                p.unlink(missing_ok=True); return pin
        await asyncio.sleep(1.0)
    raise SystemExit("no PIN provided")


async def run(a) -> int:
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
        print("channel up — probing log configs (PacketTotal per config):\n")
        best = None
        for mode, filters in PROBES:
            total = await probe_one(sess, mode, filters, a.per_probe_timeout)
            tag = f"mode={mode} filters={filters}"
            if total is None:
                print(f"  {tag:38} -> (no response / refused)")
            else:
                print(f"  {tag:38} -> {total} packets")
                if total > 0 and (best is None or total < best[0]):
                    best = (total, mode, filters)
        print()
        if best:
            print(f"SMALLEST: {best[0]} packets at mode={best[1]} "
                  f"filters={best[2]}")
            if best[0] <= 2000:
                print("=> small enough to pull the SSH key quickly. Wire this "
                      "mode/filter into provision_oskr.")
            else:
                print("=> still large; filters/modes don't narrow it on this "
                      "firmware. The pasted-key path is the fast route.")
    finally:
        try:
            await sess.disconnect()
        except Exception:
            pass
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pin-file", default="/tmp/vector_pin")
    ap.add_argument("--pin-timeout", type=float, default=120.0)
    ap.add_argument("--scan-timeout", type=float, default=10.0)
    ap.add_argument("--per-probe-timeout", type=float, default=20.0)
    return asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
