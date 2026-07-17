"""Goalie AI — pure functions, no SDK, fully unit-testable.

Vector parks at (GOALIE_X, 0) heading 90 deg (facing +Y, sideways along his
goal line) and only drives forward/backward along Y — sidesteps the
non-holonomic constraint entirely.
"""
from __future__ import annotations

import math
import logging
logger = logging.getLogger('game-bridge.goalie')
from dataclasses import dataclass

from .. import config


@dataclass
class PuckState:
    x: float
    y: float
    vx: float
    vy: float
    ts: float = 0.0


@dataclass
class FieldPose:
    x: float
    y: float
    deg: float


def fold(y: float, h: float) -> float:
    """Fold an unreflected y into [-h, +h] via triangle-wave wall reflections."""
    period = 4.0 * h
    y = math.fmod(y + h, period)
    if y < 0.0:
        y += period
    if y <= 2.0 * h:
        return y - h
    return 3.0 * h - y


def predict_intercept(puck: PuckState,
                      x_g: float = config.GOALIE_X) -> float | None:
    """Predicted puck y at the goalie patrol line, or None if not incoming.

    Straight-line propagation with wall reflections folded in.
    """
    if puck.vx <= config.PUCK_MIN_VX:
        return None
    t_hit = (x_g - puck.x) / puck.vx
    if t_hit < 0.0 or t_hit > config.INTERCEPT_MAX_T:
        return None
    y_raw = puck.y + puck.vy * t_hit
    h = config.FIELD_W / 2.0 - config.PUCK_R
    y_hit = fold(y_raw, h)
    r = config.GOALIE_Y_RANGE
    return max(-r, min(r, y_hit))


def wrap_deg(a: float) -> float:
    a = math.fmod(a, 360.0)
    if a > 180.0:
        a -= 360.0
    elif a <= -180.0:
        a += 360.0
    return a


def wheel_command(y_target: float, pose: FieldPose) -> tuple[float, float]:
    """(left_mm_s, right_mm_s) to drive goalie toward y_target on his line.

    P-controller on y error + heading servo holding GOALIE_HEADING.
    Positive wheel speeds drive the robot toward +Y when heading is 90.
    """
    e = y_target - pose.y
    if abs(e) < config.DEADBAND_MM:
        v = 0.0
    else:
        v = max(-config.MAX_WHEEL, min(config.MAX_WHEEL, config.KP * e))

    d_theta = wrap_deg(config.GOALIE_HEADING - pose.deg)
    w = max(-config.MAX_TURN_DIFF, min(config.MAX_TURN_DIFF, config.KH * d_theta))

    left = v - w
    right = v + w
    # renormalize if the differential pushed us over the cap
    m = max(abs(left), abs(right))
    if m > config.MAX_WHEEL:
        scale = config.MAX_WHEEL / m
        left *= scale
        right *= scale
    return left, right


class SideGoalie:
    """Fore/aft patrol ALONG the goal line, standing sideways (+/-90 deg).
    Pure linear moves = clean odometry, minimal tread slip, fast reactions.
    Turns happen ONLY in choreography (block flash, goal anims) — never here.
    """

    def command(self, y_target: float, pose: FieldPose) -> tuple[float, float]:
        # X-CORRIDOR: drifted deep off the goal line -> nose-first return
        # (rare; ordinary drift is handled by the patrol lean below)
        x_err = pose.x - config.GOALIE_X
        if abs(x_err) > 45.0:
            bearing = 180.0 if x_err > 0 else 0.0
            d_home = wrap_deg(bearing - pose.deg)
            if abs(d_home) > 25.0:
                w = max(-config.MAX_TURN_WHEEL,
                        min(config.MAX_TURN_WHEEL, config.KW_TURN * d_home))
                return -w, w
            v = min(config.MAX_WHEEL, 2.5 * abs(x_err))
            w = max(-20.0, min(20.0, 1.2 * d_home))
            return v - w, v + w
        # patrol heading: whichever of +/-90 is closer to the current nose
        d_pos = wrap_deg(90.0 - pose.deg)
        d_neg = wrap_deg(-90.0 - pose.deg)
        patrol = 90.0 if abs(d_pos) <= abs(d_neg) else -90.0
        d = d_pos if patrol > 0 else d_neg

        if abs(d) > 22.0:
            # realign gently (e.g. right after a choreography turn)
            w = max(-config.MAX_TURN_WHEEL,
                    min(config.MAX_TURN_WHEEL, config.KW_TURN * d))
            return -w, w

        dy = y_target - pose.y
        if abs(dy) < 12.0:
            # holding position: keep the nose trimmed, wheels quiet
            if abs(d) > 6.0:
                w = max(-40.0, min(40.0, config.KW_TURN * d))
                return -w, w
            return 0.0, 0.0

        # facing +90 -> forward = +y ; facing -90 -> forward = -y
        v = config.KP * dy * (1.0 if patrol > 0 else -1.0)
        v = max(-config.MAX_WHEEL, min(config.MAX_WHEEL, v))
        # BOUNDARY BRAKE: past the safe range only inward travel is allowed
        # (tread slip on hard reversals overshot to y=-132 in a live run)
        vy_intent = v * (1.0 if patrol > 0 else -1.0)
        yr = config.GOALIE_Y_RANGE
        if (pose.y >= yr and vy_intent > 0) or (pose.y <= -yr and vy_intent < 0):
            v = 0.0
        # X-HYGIENE: tilt the patrol heading a few degrees so ordinary
        # fore/aft travel slowly recovers x back to the goal line
        # (no turns — just a lean; sign flips with drive direction)
        x_err = pose.x - config.GOALIE_X
        drive_sign = 1.0 if v >= 0 else -1.0
        side_sign = 1.0 if patrol > 0 else -1.0
        bias = max(-9.0, min(9.0, 0.22 * x_err)) * drive_sign * side_sign
        d = wrap_deg((patrol + bias) - pose.deg)
        # small heading-hold trim rides on top of the linear drive
        w = max(-22.0, min(22.0, 1.2 * d))
        left, right = v - w, v + w
        m = max(abs(left), abs(right))
        if m > config.MAX_WHEEL:
            left *= config.MAX_WHEEL / m
            right *= config.MAX_WHEEL / m
        return left, right
