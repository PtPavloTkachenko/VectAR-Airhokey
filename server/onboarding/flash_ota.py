"""Flash an ankidev OTA to the robot over BLE (OTAStart), serving the image from
this Mac. Used to put wire-os on our own dev unit so it authorizes an SSH key we
hold (its localsshuser adds victor-dev@anki = our ssh_root_key), after which we
can SSH in and provision — reviving a robot whose own key was lost to a Clear
User Data wipe.

Safe by construction: OTAStart writes the INACTIVE A/B slot and only flips on a
verified success; a bad/incompatible image (or a signature the robot rejects,
die 209) leaves the current slot untouched. Full backups exist to flash back.

The robot downloads the image over Wi-Fi, so it must be on Wi-Fi (this script
joins it if you pass --ssid/--pw and it isn't already).

Run (robot on charger, then double-press his backpack):
    python -m onboarding.flash_ota --ota dev.ota --ssid "MyWiFi" --pw "secret"
PIN: type it, or (no TTY) echo it to /tmp/vector_pin.
"""
from __future__ import annotations

import argparse
import asyncio
import functools
import http.server
import socket
import sys
import threading
from pathlib import Path

from .ble.session import RtsSession, FirstFrameTimeout

OTA_DIR = Path.home() / ".vectar" / "ota"


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80)); return s.getsockname()[0]
    finally:
        s.close()


def serve_ota(port: int) -> threading.Thread:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                directory=str(OTA_DIR))
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return t


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
    ota_path = OTA_DIR / a.ota
    if not ota_path.is_file():
        print(f"OTA not found: {ota_path}", file=sys.stderr); return 2
    ip = lan_ip()
    url = f"http://{ip}:{a.port}/{a.ota}"
    serve_ota(a.port)
    print(f"serving {ota_path.name} at {url}")

    print("scanning BLE (double-press his backpack now)…")
    found = await RtsSession.scan(timeout=a.scan_timeout)
    if not found:
        print("no Vector advertising.", file=sys.stderr); return 2
    dev = found[0]
    # The first frame after a BLE connect often times out (a CoreBluetooth
    # subscribe race), and the robot only shows its PIN once the handshake
    # actually starts — so reconnect and retry until it does.
    sess = None
    for attempt in range(1, 7):
        s = RtsSession()
        try:
            print(f"connecting to {dev.get('name') or dev['address']} "
                  f"(attempt {attempt})…")
            await s.connect(dev["address"], dev.get("name"))
            await s.begin_handshake(first_timeout=6.0)
            sess = s
            break
        except FirstFrameTimeout:
            print("  first-frame race — reconnecting…")
            try:
                await s.disconnect()
            except Exception:
                pass
            await asyncio.sleep(1.0)
    if sess is None:
        print("could not start the handshake — double-press again and rerun.",
              file=sys.stderr)
        return 2
    try:
        print("handshake started — PIN is on his face now.")
        await sess.finish_handshake(await read_pin(a.pin_file, a.pin_timeout))
        print("channel up.")

        # the robot fetches the image over Wi-Fi, so make sure it's connected
        async def wait_ip(tries: int) -> str:
            for _ in range(tries):
                try:
                    r = (await sess.wifi_ip() or "").strip()
                    if r and r != "0.0.0.0":
                        return r
                except Exception:
                    pass
                await asyncio.sleep(4)
            return ""
        rip = await wait_ip(1)
        if not rip and a.ssid:
            print(f"joining Wi-Fi {a.ssid}…")
            try:
                await sess.wifi_connect(a.ssid, a.pw, a.auth)
            except Exception as e:
                print(f"  wifi_connect said: {e} (may still associate)")
            # the robot needs ~10-15 s to actually associate + get a lease
            rip = await wait_ip(6)
        print(f"robot Wi-Fi IP: {rip or '(unknown — download may fail)'}")
        if not rip:
            print("robot has no IP — it can't download the image. Re-run with "
                  "--ssid/--pw for the network this Mac is on.", file=sys.stderr)
            return 1

        print("starting OTA (this replaces the OS; keep him on the charger)…")

        def prog(p):
            if p["expected"]:
                print(f"  {p['percent']:.1f}%  ({p['current']}/{p['expected']})")

        res = await sess.ota_flash(url, progress_cb=prog)
        print(f"OTA result: {res}")
        if res.get("done"):
            print("\n✅ flashed — the robot is rebooting into the new firmware.")
            print("   after ~1 min:  ssh -i ~/.vectar/ssh_root_key "
                  "-o PubkeyAcceptedAlgorithms=+ssh-rsa root@<robot-ip>")
    finally:
        try:
            await sess.disconnect()
        except Exception:
            pass
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ota", default="dev.ota", help="file in ~/.vectar/ota")
    ap.add_argument("--ssid", default="")
    ap.add_argument("--pw", default="")
    ap.add_argument("--auth", type=int, default=6, help="6=WPA2 (default)")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--pin-file", default="/tmp/vector_pin")
    ap.add_argument("--pin-timeout", type=float, default=120.0)
    ap.add_argument("--scan-timeout", type=float, default=30.0)
    return asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
