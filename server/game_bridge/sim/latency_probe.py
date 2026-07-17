"""M0 probe: SDK connect, wheel-command RTT, pose event rate, anim + eyes.

    python -m game_bridge.sim.latency_probe [--skip-anim]

Gate from the plan: if set_wheel_motors RTT p95 > 250 ms, lower puck max
speed in config before building the game.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import statistics
import time

from .. import config
from ..robot.connection import RobotLink
from ..robot.pose_pump import PosePump

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("latency-probe")


async def probe(skip_anim: bool):
    link = RobotLink()
    ok = await link.connect()
    if not ok:
        raise SystemExit("Connect failed")
    if not link.has_control:
        raise SystemExit("No behavior control — stop vector-bot / other SDK clients")
    robot = link.robot

    # --- Pose event rate over 5 s ---
    pump = PosePump(robot)
    pump.start()
    start_count = pump.snapshot["count"]
    await asyncio.sleep(5.0)
    rate = (pump.snapshot["count"] - start_count) / 5.0
    logger.info(f"Pose event rate: {rate:.1f} Hz (target >= 25)")

    # --- Wheel command RTT: 100 zero-speed commands, await gRPC ack ---
    rtts = []
    for i in range(100):
        t0 = time.perf_counter()
        fut = robot.motors.set_wheel_motors(0.0, 0.0)
        if hasattr(fut, "result"):
            await asyncio.to_thread(fut.result, 5)
        rtts.append((time.perf_counter() - t0) * 1000.0)
        await asyncio.sleep(0.03)
    rtts.sort()
    p50 = statistics.median(rtts)
    p95 = rtts[int(len(rtts) * 0.95)]
    logger.info(f"set_wheel_motors RTT: p50={p50:.0f} ms  p95={p95:.0f} ms  "
                f"min={rtts[0]:.0f}  max={rtts[-1]:.0f}")
    if p95 > 250:
        logger.warning("GATE FAILED: p95 > 250 ms — lower PUCK max speed for playability")
    else:
        logger.info("GATE OK: latency fine for 350 mm/s puck")

    # --- Short physical wheel pulse (visible check) ---
    logger.info("Wheel pulse: forward 0.4 s...")
    robot.motors.set_wheel_motors(60, 60)
    await asyncio.sleep(0.4)
    robot.motors.set_wheel_motors(-60, -60)
    await asyncio.sleep(0.4)
    robot.motors.set_wheel_motors(0, 0)

    # --- Eye color + animation (trigger path, same as the game uses) ---
    if not skip_anim:
        # Animations refuse to play on the charger — hop off first.
        try:
            fut = robot.get_battery_state()
            st = await asyncio.to_thread(fut.result, 10)
            if getattr(st, "is_on_charger_platform", False):
                logger.info("On charger — driving off before animation test...")
                fut = robot.behavior.drive_off_charger()
                await asyncio.to_thread(fut.result, 20)
        except Exception as e:
            logger.warning(f"drive_off_charger: {e}")

        logger.info("Eye color -> sad violet")
        fut = robot.behavior.set_eye_color(*config.EYE_SAD)
        if hasattr(fut, "result"):
            await asyncio.to_thread(fut.result, 5)
        logger.info(f"Playing sad trigger: {config.ANIM_SAD[0]}")
        trig = getattr(robot.anim, "_anim_trigger_dict", {}).get(
            config.ANIM_SAD[0], config.ANIM_SAD[0])
        fut = robot.anim.play_animation_trigger(trig)
        if hasattr(fut, "result"):
            await asyncio.to_thread(fut.result, 15)
        logger.info("Eye color -> normal cyan")
        fut = robot.behavior.set_eye_color(*config.EYE_NORMAL)
        if hasattr(fut, "result"):
            await asyncio.to_thread(fut.result, 5)

    # --- Pose snapshot ---
    s = pump.snapshot
    logger.info(f"Pose: x={s['x']:.0f} y={s['y']:.0f} deg={s['deg']:.0f} "
                f"origin={s['origin_id']} cliff={s['cliff']} held={s['held']}")

    await link.disconnect()
    logger.info("M0 probe complete")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--skip-anim", action="store_true")
    args = p.parse_args()
    asyncio.run(probe(args.skip_anim))


if __name__ == "__main__":
    main()
