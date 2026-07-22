"""Diagnostic capture of the BLE log bundle — ground truth for the 30 KB puzzle.

Unlike get_robot_key.py (which indexes chunks by packetNumber, an old frame-count
assumption) this uses the SAME byte-counter logic as session.download_logs: concat
every chunk in ARRIVAL order, done when packetNumber >= packetTotal. It then dumps
exactly what we need to decide truncation vs. small-bundle:

  * PacketTotal on frame 1  (the size the robot ADVERTISES)
  * assembled bytes + frame count + per-frame (packet,total,chunklen) trace
  * a listing of the tar contents and whether data/ssh/id_rsa is inside

Run (robot on charger, double-press backpack so he advertises + shows a PIN):
    python -m onboarding.capture_logs
When it says so, put the 6-digit PIN in /tmp/vector_pin:  echo 123456 > /tmp/vector_pin
"""
from __future__ import annotations

import asyncio
import io
import sys
import tarfile
from pathlib import Path

from .ble import messages as m
from .ble.session import RtsSession
from . import oskr_provision as prov

PIN_FILE = "/tmp/vector_pin"
BUNDLE_OUT = "/tmp/vector_logs_capture.bin"
TRACE_OUT = "/tmp/vector_logs_trace.txt"


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
    trace = []
    blob = b""
    try:
        await sess.begin_handshake()
        await sess.finish_handshake(await read_pin())
        print("channel up — requesting logs (mode=0, no filter = full bundle)…",
              flush=True)
        await sess._send(m.log_request(mode=0, filters=None, version=sess.version))

        loop = asyncio.get_event_loop()
        deadline = loop.time() + 300.0
        file_id = None
        parts: list[bytes] = []
        first_total = None
        frames = 0
        done = False
        while not done and loop.time() < deadline:
            mt, pl = await sess._recv(timeout=45.0)
            if mt == m.LOG_RESPONSE:
                r = m.parse_log_response(pl)
                if r["exit_code"] != 0:
                    print(f"robot refused (exit {r['exit_code']})")
                    return 1
                file_id = r["file_id"]
                print(f"log stream started (file_id={file_id})", flush=True)
                continue
            if mt != m.FILE_DOWNLOAD:
                trace.append(f"  (non-download frame type=0x{mt:02x} len={len(pl)})")
                continue
            d = m.parse_file_download(pl)
            frames += 1
            if first_total is None:
                first_total = d["total"]
                print(f"\n*** PacketTotal on frame 1 = {first_total} bytes "
                      f"({first_total/1024:.1f} KB) ***\n", flush=True)
            # byte-counter logic, matching session.download_logs
            if file_id is not None and d["file_id"] != file_id:
                trace.append(f"[{frames}] SKIP file_id={d['file_id']} "
                             f"(want {file_id})")
                continue
            parts.append(d["chunk"])
            done = bool(d["total"] and d["packet"] >= d["total"])
            if frames <= 5 or frames % 25 == 0 or done:
                print(f"  frame {frames}: packet={d['packet']} total={d['total']} "
                      f"chunklen={len(d['chunk'])} acc={sum(len(x) for x in parts)}"
                      f"{'  <DONE>' if done else ''}", flush=True)
            trace.append(f"[{frames}] packet={d['packet']} total={d['total']} "
                         f"chunklen={len(d['chunk'])} done={done}")
        blob = b"".join(parts)
        print(f"\nassembled {len(blob)} bytes across {frames} frames "
              f"(done={done})", flush=True)
    finally:
        try:
            await sess.disconnect()
        except Exception:
            pass

    Path(BUNDLE_OUT).write_bytes(blob)
    Path(TRACE_OUT).write_text("\n".join(trace))
    print(f"\nsaved bundle -> {BUNDLE_OUT} ({len(blob)} bytes)")
    print(f"saved frame trace -> {TRACE_OUT}")

    # what's inside?
    print("\n=== tar contents ===")
    listed = False
    for opener in ("r:*", "r"):
        try:
            with tarfile.open(fileobj=io.BytesIO(blob), mode=opener) as tf:
                for mem in tf.getmembers():
                    flag = "  <-- SSH KEY" if (
                        "ssh" in mem.name and "id_" in mem.name
                        and not mem.name.endswith(".pub")) else ""
                    print(f"  {mem.size:>8}  {mem.name}{flag}")
                    listed = True
            break
        except tarfile.TarError as e:
            print(f"  (not a valid tar via {opener}: {e})")
    if not listed:
        print("  bundle is NOT a readable tar — likely truncated/corrupt "
              "(first 16 bytes:", blob[:16].hex(), ")")

    key = prov.extract_ssh_key(blob)
    print(f"\nSSH key present in bundle: {'YES ✅' if key else 'NO ❌'}")
    return 0 if key else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
