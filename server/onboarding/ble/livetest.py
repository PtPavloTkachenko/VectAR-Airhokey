"""Live BLE handshake test (non-destructive).

  python -m onboarding.ble.livetest            # scan only: is a Vector pairing?
  python -m onboarding.ble.livetest <PIN>      # full handshake + read-only queries

Put Vector on the charger and double-press his backpack button first — his
face shows a 6-digit PIN and he starts advertising. Nothing here writes to the
robot: it only does the handshake, reads status, and lists Wi-Fi networks.
"""
import asyncio
import logging
import os
import sys

from .session import RtsSession

logging.basicConfig(
    level=logging.DEBUG if os.getenv("BLE_DEBUG") else logging.INFO,
    format="%(name)s %(levelname)s %(message)s")
# quiet the very noisy bleak/asyncio backend logs — keep only our trace
for noisy in ("bleak", "asyncio", "bleak.backends.corebluetooth"):
    logging.getLogger(noisy).setLevel(logging.WARNING)

PIN_FILE = "/tmp/vector_pin"


async def _wait_for_pin(timeout: float = 150.0) -> str | None:
    """Poll PIN_FILE — the driver writes the 6 digits the robot now shows."""
    if os.path.exists(PIN_FILE):
        os.remove(PIN_FILE)
    print(f"\n>>> The robot's face should now show a 6-digit PIN.")
    print(f">>> Provide it with:  echo <PIN> > {PIN_FILE}")
    for _ in range(int(timeout * 2)):
        if os.path.exists(PIN_FILE):
            pin = open(PIN_FILE).read().strip()
            if len(pin) == 6 and pin.isdigit():
                os.remove(PIN_FILE)
                return pin
        await asyncio.sleep(0.5)
    return None


async def main(pin: str | None):
    print("Waiting for a Vector in pairing mode — double-press his backpack "
          "button on the charger (face shows ###### then digits). Scanning "
          "up to 90 s...")
    target = None
    for attempt in range(75):          # ~5 min of 4 s scans
        robots = await RtsSession.scan(4.0)
        if robots:
            for r in robots:
                flag = " [pairing]" if r["pairing"] else ""
                print(f"  CAUGHT {r['name']}  {r['address']}  "
                      f"rssi={r['rssi']}{flag}", flush=True)
            target = robots[0]
            break
        print(f"  ...none yet (scan {attempt + 1}) — double-press again",
              flush=True)
    if target is None:
        print("No Vector advertised within 5 min.")
        return

    from .session import FirstFrameTimeout
    sess = None
    for attempt in range(1, 7):
        sess = RtsSession()
        try:
            print(f"\nConnecting to {target['name']} (attempt {attempt})...",
                  flush=True)
            await sess.connect(target["address"], target["name"])
            await sess.begin_handshake(first_timeout=5.0)
            break                      # got ConnRequest -> Nonce; PIN showing
        except FirstFrameTimeout:
            print("  first-frame race, reconnecting...", flush=True)
            await sess.disconnect()
            await asyncio.sleep(1.0)
            sess = None
    if sess is None:
        print("Could not start the handshake after retries — double-press "
              "again and rerun.")
        return
    try:
        # PIN is revealed on the robot's face at the Nonce step (just now).
        if pin is None:
            pin = await _wait_for_pin()
            if not pin:
                print("No PIN provided in time — aborting.")
                return
        print("Finishing handshake with PIN...")
        await sess.finish_handshake(pin)
        print("PAIRED — encrypted channel up.\n")

        st = await sess.status()
        print(f"status: esn={st['esn']} fw={st['firmware']} "
              f"wifi_state={st['wifi_state']} has_owner={st['has_owner']} "
              f"cloud_authed={st['is_cloud_authed']}")

        print("\nWi-Fi networks Vector can see:")
        for n in await sess.wifi_scan():
            print(f"  {n['signal']:3d}  auth={n['auth']}  "
                  f"{'*' if n['provisioned'] else ' '} {n['ssid']}")
    finally:
        await sess.disconnect()
        print("\nDisconnected (nothing was changed on the robot).")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
