"""M1 CLI: pretends to be the lens — sends place_confirm + scripted volleys.

Robot must be physically standing at the taped field mark (GOALIE_X, 0)
facing sideways (+Y, i.e. 90 deg field heading) when you press Enter.

    python -m game_bridge.sim.fake_puck [--volleys 10] [--speed 250] [--url ws://localhost:8777]

Prints intercept-margin stats: distance between robot y and puck y at the
moment the puck crosses the patrol line.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import time

import websockets

from .. import config


class FakePuck:
    def __init__(self, url: str, volleys: int, speed: float,
                 deg: float = 90.0):
        self.url = url
        self.volleys = volleys
        self.speed = speed
        self.deg = deg  # robot's physical heading at placement (180 = facing player)
        self.robot_pose: dict | None = None
        self.results: list[float] = []
        self._anim_done = False

    async def run(self):
        async with websockets.connect(self.url) as ws:
            self.ws = ws
            await ws.send(json.dumps({"t": "hello", "role": "lens", "proto": 1}))
            welcome = json.loads(await ws.recv())
            print(f"welcome: {welcome}")

            facing = ("FACING THE PLAYER" if abs(self.deg) > 135
                      else "sideways(+Y = player's left)")
            input(f"Place robot on the tape mark (140,0) {facing}, "
                  "then press Enter...")
            await ws.send(json.dumps({
                "t": "place_confirm",
                "field": {"L": config.FIELD_L, "W": config.FIELD_W},
                "robotFieldPose": {"x": config.GOALIE_X, "y": 0,
                                   "deg": self.deg},
            }))

            recv_task = asyncio.create_task(self._recv_loop())
            # Real rallies are continuous — one rally_start for the whole
            # series, no pause between volleys (matches actual gameplay).
            await self.ws.send(json.dumps(
                {"t": "event", "name": "rally_start", "score": [0, 0]}))
            # sanity: pose stream must flow before we bother with volleys
            t0 = time.monotonic()
            while self.robot_pose is None and time.monotonic() - t0 < 5.0:
                await asyncio.sleep(0.1)
            if self.robot_pose is None:
                recv_task.cancel()
                raise SystemExit(
                    "No pose from bridge within 5 s after place_confirm — "
                    "robot link is down or place_confirm was rejected. "
                    "Check the bridge log.")
            print(f"pose stream OK: robot at field "
                  f"({self.robot_pose['x']:.0f},{self.robot_pose['y']:.0f}) "
                  f"deg={self.robot_pose['deg']:.0f}")

            for i in range(self.volleys):
                await self._volley(i)
                await asyncio.sleep(2.0)

            # Finale 1: concede a goal -> sad anim + repark
            await ws.send(json.dumps(
                {"t": "event", "name": "goal_player", "score": [1, 0]}))
            print("goal_player -> sad anim + repark...")
            await self._wait_anim_done(25)

            # Finale 2: match over with the real series score ->
            # win dance (lift!) or loss drama
            blocks = sum(1 for m in self.results if m <= 40.0)
            misses = len(self.results) - blocks
            print(f"game_over: score player={misses} vector={blocks} -> "
                  f"{'WIN dance' if blocks > misses else 'loss drama'}")
            await ws.send(json.dumps(
                {"t": "event", "name": "game_over",
                 "score": [misses, blocks]}))
            await self._wait_anim_done(30)

            recv_task.cancel()
            self._report()

    async def _wait_anim_done(self, timeout_s: float):
        self._anim_done = False
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout_s:
            await asyncio.sleep(0.5)
            if self._anim_done:
                return

    async def _recv_loop(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if msg["t"] == "pose":
                self.robot_pose = msg
            elif msg["t"] == "anim_done":
                self._anim_done = True
                print(f"anim_done: {msg['name']}")
            elif msg["t"] in ("robot_status", "pong"):
                pass
            else:
                print(f"<- {msg}")

    async def _volley(self, i: int):
        """Serve a puck from player's side toward the robot's goal line."""
        x0, y0 = -150.0, random.uniform(-60, 60)
        # aim at a random point on the goalie line
        y_hit_target = random.uniform(-config.GOALIE_Y_RANGE, config.GOALIE_Y_RANGE)
        dx = config.GOALIE_X - x0
        dy = y_hit_target - y0
        norm = (dx * dx + dy * dy) ** 0.5
        vx, vy = self.speed * dx / norm, self.speed * dy / norm
        t_flight = dx / vx

        print(f"volley {i + 1}: from ({x0:.0f},{y0:.0f}) "
              f"aim y={y_hit_target:.0f} flight {t_flight:.1f}s")

        t_start = time.monotonic()
        while True:
            t = time.monotonic() - t_start
            x = x0 + vx * t
            y = y0 + vy * t
            if x >= config.GOALIE_X:
                break
            await self.ws.send(json.dumps({
                "t": "puck", "x": round(x, 1), "y": round(y, 1),
                "vx": round(vx, 1), "vy": round(vy, 1), "ts": time.time()}))
            await asyncio.sleep(0.05)  # 20 Hz

        # measure intercept margin
        margin = None
        if self.robot_pose is not None:
            margin = abs(self.robot_pose["y"] - y_hit_target)
            self.results.append(margin)
            if margin <= 40.0:
                # blocked! -> eyes-only celebration on the robot
                await self.ws.send(json.dumps(
                    {"t": "event", "name": "vector_block", "score": [0, 0]}))
        print(f"  crossed line; robot y={self.robot_pose['y'] if self.robot_pose else '?'} "
              f"target={y_hit_target:.0f} margin={margin and round(margin, 1)} mm")

    def _report(self):
        if not self.results:
            print("No results collected")
            return
        ok = sum(1 for m in self.results if m <= 30.0)
        print(f"\n=== Intercepts within 30 mm: {ok}/{len(self.results)} "
              f"(target >= 8/10) ===")
        print("margins:", [round(m, 1) for m in self.results])


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--volleys", type=int, default=10)
    p.add_argument("--speed", type=float, default=250.0)
    p.add_argument("--url", default="ws://localhost:8777")
    p.add_argument("--deg", type=float, default=90.0,
                   help="robot heading at placement: 90=sideways, 180=facing player")
    args = p.parse_args()
    asyncio.run(FakePuck(args.url, args.volleys, args.speed, args.deg).run())


if __name__ == "__main__":
    main()
