"""Rigid 2D transform between robot odometry frame and field frame.

Bound once at place_confirm: the lens guarantees the robot is physically
standing at a known field pose (GOALIE_X, 0, 90 deg). From the simultaneous
odometry snapshot we solve rotation + translation (no scale — both frames
are metric mm).

    p_field = R(theta_off) * p_robot + t

Vision fixes (lens-observed robot position on the table plane) nudge `t`
via a complementary filter; rotation is not corrected in MVP (goalie yaw is
actively servoed, and single-point observations can't observe theta).
Math shape mirrors vector-server/vector-bot/utils/spatial_map.py:152-171.
"""
from __future__ import annotations

import math
import logging
logger = logging.getLogger('game-bridge.transform')
import time
from collections import deque

from . import config


def wrap_deg(a: float) -> float:
    """Wrap angle to (-180, 180]."""
    a = math.fmod(a, 360.0)
    if a > 180.0:
        a -= 360.0
    elif a <= -180.0:
        a += 360.0
    return a


class RobotFieldTransform:
    def __init__(self):
        self._bound = False
        self._theta_off = 0.0     # deg
        self._cos = 1.0
        self._sin = 0.0
        self._rej_n = 0
        self._rej_x: float | None = None
        self.stationary = True  # bridge updates from live wheel state
        self._rej_y = 0.0
        self._tx = 0.0
        self._ty = 0.0
        self._origin_id: int | None = None
        # (mono_ts, field_x, field_y) history for vision-fix matching
        self._history: deque[tuple[float, float, float]] = deque()

    @property
    def bound(self) -> bool:
        return self._bound

    @property
    def origin_id(self) -> int | None:
        return self._origin_id

    def invalidate(self):
        self._bound = False
        self._history.clear()

    def bind(self, robot_pose: tuple[float, float, float],
             field_pose: tuple[float, float, float],
             origin_id: int | None = None):
        """robot_pose/field_pose = (x_mm, y_mm, heading_deg)."""
        rx, ry, rdeg = robot_pose
        fx, fy, fdeg = field_pose
        self._theta_off = wrap_deg(fdeg - rdeg)
        th = math.radians(self._theta_off)
        self._cos, self._sin = math.cos(th), math.sin(th)
        self._tx = fx - (self._cos * rx - self._sin * ry)
        self._ty = fy - (self._sin * rx + self._cos * ry)
        self._origin_id = origin_id
        self._history.clear()
        self._bound = True

    def robot_to_field(self, x: float, y: float, deg: float = 0.0
                       ) -> tuple[float, float, float]:
        fx = self._cos * x - self._sin * y + self._tx
        fy = self._sin * x + self._cos * y + self._ty
        return fx, fy, wrap_deg(deg + self._theta_off)

    def field_to_robot(self, x: float, y: float) -> tuple[float, float]:
        dx, dy = x - self._tx, y - self._ty
        # R^T
        return self._cos * dx + self._sin * dy, -self._sin * dx + self._cos * dy

    # --- Vision fix ---

    def record_field_pose(self, fx: float, fy: float, ts: float | None = None):
        """Call from the pose loop so vision fixes can match by timestamp."""
        now = ts if ts is not None else time.monotonic()
        self._history.append((now, fx, fy))
        cutoff = now - config.POSE_HISTORY_S
        while self._history and self._history[0][0] < cutoff:
            self._history.popleft()

    def _predicted_at(self, ts: float) -> tuple[float, float] | None:
        if not self._history:
            return None
        best = min(self._history, key=lambda h: abs(h[0] - ts))
        if abs(best[0] - ts) > 0.5:
            return None
        return best[1], best[2]

    def apply_anchor_fix(self, odom_x: float, odom_y: float,
                         odom_ang: float | None = None) -> bool:
        """The CUBE (a landmark at a KNOWN field spot, placed square with
        the field) was seen at odom (x, y, ang). Blend translation AND —
        when the angle is given — heading. Heading uses the residual to
        the nearest 90 deg, so ANY square placement works."""
        if not self._bound:
            return False
        fx_k, fy_k = config.CUBE_FIELD_X, config.CUBE_FIELD_Y
        cx, cy, _ = self.robot_to_field(odom_x, odom_y, 0.0)
        ex, ey = fx_k - cx, fy_k - cy
        if math.hypot(ex, ey) > config.CUBE_OUTLIER_MM:
            return False
        # --- heading: cube field angle must be a multiple of 90 ---
        if odom_ang is not None:
            cube_field_ang = odom_ang + self._theta_off
            resid = wrap_deg(cube_field_ang)
            resid = resid - round(resid / 90.0) * 90.0
            if abs(resid) < 20.0:  # sane residuals only
                dth = -config.ALPHA_CUBE_THETA * resid
                # rotate around the CUBE so it stays anchored while
                # heading corrects
                th = math.radians(dth)
                c, s = math.cos(th), math.sin(th)
                px = self._tx - fx_k
                py = self._ty - fy_k
                self._tx = fx_k + c * px - s * py
                self._ty = fy_k + s * px + c * py
                self._theta_off += dth
                rad = math.radians(self._theta_off)
                self._cos, self._sin = math.cos(rad), math.sin(rad)
                cx, cy, _ = self.robot_to_field(odom_x, odom_y, 0.0)
                ex, ey = fx_k - cx, fy_k - cy
        self._tx += config.ALPHA_CUBE * ex
        self._ty += config.ALPHA_CUBE * ey
        return True

    def apply_vision_fix(self, obs_x: float, obs_y: float, conf: float,
                         ts: float | None = None,
                         allow_far: bool = False) -> bool:
        """Blend an observed field position into translation. Returns applied?

        allow_far=True (robot has ESCAPED off the goal line) relaxes the
        spatial gate so YOLO can re-anchor the transform to the robot's REAL
        off-line position — otherwise the escaped robot is stuck forever
        because its true detection is 'not where a goalie should be'."""
        if not self._bound or conf < config.VISION_MIN_CONF:
            return False
        pred = self._predicted_at(ts if ts is not None else time.monotonic())
        if pred is None:
            return False
        ex, ey = obs_x - pred[0], obs_y - pred[1]
        if math.hypot(ex, ey) > config.VISION_OUTLIER_MM:
            # RE-ANCHOR: the robot was moved OR odometry drifted. Consecutive
            # rejected fixes that agree with each other are the new truth.
            # While DRIVING demand 3 (a 2-cluster of bad detections once
            # teleported the transform mid-rally -> robot 'escaped'); when
            # the robot is STILL 2 is enough (end-of-game drift heal).
            need = 2 if self.stationary else 3
            # live sessions showed the on-glasses YOLO sits at conf 0.45-0.50
            # while being spatially dead-on (user: "він досить чітко детектить
            # позицію") — 0.5 here starved the re-anchor cluster forever
            if conf < config.VISION_REANCHOR_CONF:
                return False
            if allow_far:
                # ESCAPE recovery: accept the robot's real position anywhere
                # on the table (a clustered detection = the robot, not noise)
                if abs(obs_x) > 320.0 or abs(obs_y) > 320.0:
                    return False
            else:
                # NORMAL PLAY spatial gate: the goalie lives on his goal
                # line. A cluster mid-field is the mallet/hand fooling YOLO;
                # snapping to it teleported the pose (150,-100)->(108,-259).
                if (abs(obs_x - config.GOALIE_X) > 70.0
                        or abs(obs_y) > config.GOALIE_Y_RANGE + 25.0):
                    return False
                need = 2 if self.stationary else 3
            if (self._rej_x is not None
                    and math.hypot(obs_x - self._rej_x,
                                   obs_y - self._rej_y) < 75.0):
                self._rej_n += 1
            else:
                self._rej_n = 1
            self._rej_x, self._rej_y = obs_x, obs_y
            if self._rej_n >= need:
                logger.warning(
                    f"VISION RE-ANCHOR: snap ({ex:+.0f},{ey:+.0f})mm "
                    f"after {self._rej_n} agreeing rejects "
                    f"(stationary={self.stationary})")
                self._tx += ex
                self._ty += ey
                self._rej_n = 0
                self._rej_x = None
                return True
            return False
        self._rej_n = 0
        self._rej_x = None
        a = config.ALPHA_VISION
        self._tx += a * ex
        self._ty += a * ey
        return True
