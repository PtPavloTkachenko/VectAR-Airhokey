"""SafetyGate — every wheel command passes through here, no exceptions.

Order of checks matters: hard stops first, then bounds, then shaping.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

from .. import config

STOP = (0.0, 0.0)


@dataclass
class SafetyFlags:
    cliff: bool = False
    held: bool = False
    has_control: bool = True


@dataclass
class SafetyGate:
    escaped = False  # latched runaway stop; cleared by place_confirm
    _last_px = None
    _last_py = None

    _prev: tuple[float, float] = STOP
    _latch_until: float = 0.0
    last_puck_ts: float = field(default_factory=lambda: 0.0)

    def note_puck(self, mono_ts: float | None = None):
        self.last_puck_ts = mono_ts if mono_ts is not None else time.monotonic()

    def filter(self, cmd: tuple[float, float], pose_y: float,
               flags: SafetyFlags, rally_active: bool,
               now: float | None = None,
               pose_deg: float = 90.0,
               pose_x: float = 140.0) -> tuple[float, float]:
        now = now if now is not None else time.monotonic()

        # 1. Hard stops + 1s latch after the condition clears
        if flags.cliff or flags.held or not flags.has_control:
            self._latch_until = now + 1.0
            return self._issue(STOP, slew=False)
        if now < self._latch_until:
            return self._issue(STOP, slew=False)

        # 2b. ESCAPE: pose ran far outside the arena (tread slip runaway,
        # off-table push...) -> LATCHED stop until a new place_confirm.
        if (abs(pose_y) > config.FIELD_Y_SOFT + 90.0 or
                pose_x > config.GOALIE_X_MAX + 90.0 or
                pose_x < config.GOALIE_X_MIN - 110.0):
            self.escaped = True
        if self.escaped:
            return self._issue(STOP, slew=False)

        # 2. Watchdog: stale puck data during an active rally -> stop
        if rally_active and (now - self.last_puck_ts) > config.WATCHDOG_PUCK_S:
            return self._issue(STOP, slew=False)

        # 3. Soft field bounds: outside -> only inward motion.
        # Two independent estimates of motion direction: (a) commanded
        # velocity through heading (heading can LIE after tread slip),
        # (b) ACTUAL displacement between poses — reality itself.
        fwd = 0.5 * (cmd[0] + cmd[1])
        rad = math.radians(pose_deg)
        vy = fwd * math.sin(rad)
        vx = fwd * math.cos(rad)
        if self._last_px is not None:
            ax = pose_x - self._last_px
            ay = pose_y - self._last_py
            # actually moving OUTWARD while outside -> hard veto
            if pose_y > config.FIELD_Y_SOFT and ay > 0.6:
                cmd = STOP
            elif pose_y < -config.FIELD_Y_SOFT and ay < -0.6:
                cmd = STOP
            if pose_x > config.GOALIE_X_MAX and ax > 0.6:
                cmd = STOP
            elif pose_x < config.GOALIE_X_MIN and ax < -0.6:
                cmd = STOP
        self._last_px = pose_x
        self._last_py = pose_y
        if pose_y > config.FIELD_Y_SOFT and vy > 0.0:
            cmd = STOP
        elif pose_y < -config.FIELD_Y_SOFT and vy < 0.0:
            cmd = STOP
        # X corridor around the patrol line (arc driving can drift X)
        if pose_x > config.GOALIE_X_MAX and vx > 0.0:
            cmd = STOP
        elif pose_x < config.GOALIE_X_MIN and vx < 0.0:
            cmd = STOP

        # 4. Hard cap
        cmd = (
            max(-config.MAX_WHEEL, min(config.MAX_WHEEL, cmd[0])),
            max(-config.MAX_WHEEL, min(config.MAX_WHEEL, cmd[1])),
        )

        # 5. Slew limit
        return self._issue(cmd, slew=True)

    def _issue(self, cmd: tuple[float, float], slew: bool) -> tuple[float, float]:
        if slew:
            s = config.SLEW_MM_S_PER_TICK
            l = self._clamp_step(self._prev[0], cmd[0], s)
            r = self._clamp_step(self._prev[1], cmd[1], s)
            cmd = (l, r)
        self._prev = cmd
        return cmd

    @staticmethod
    def _clamp_step(prev: float, target: float, step: float) -> float:
        if target > prev + step:
            return prev + step
        if target < prev - step:
            return prev - step
        return target
