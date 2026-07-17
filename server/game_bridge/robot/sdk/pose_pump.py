"""PosePump — latest robot state snapshot from the SDK event stream.

No polling task: the SDK fires Events.robot_state at ~30 Hz and the handler
just overwrites an atomic snapshot dict (pattern from
vector-server/vector-bot/utils/sensor_hub.py:_on_robot_state).
"""
from __future__ import annotations

import logging
import math
import time

from ... import config

logger = logging.getLogger("game-bridge.pose")


class PosePump:
    def __init__(self, robot):
        self._robot = robot
        self.snapshot: dict = {
            "x": 0.0, "y": 0.0, "deg": 0.0,
            "origin_id": 0, "cliff": False, "held": False,
            "head_rad": 0.0, "lift_mm": 32.0,
            "mono_ts": 0.0, "count": 0,
        }
        self._held_since: float | None = None
        self._gyro_deg: float | None = None   # B6.4 gyro-fused heading (deg)
        self._gyro_last: float | None = None

    def start(self):
        from anki_vector.events import Events
        self._robot.events.subscribe(self._on_robot_state, Events.robot_state)
        logger.info("PosePump subscribed to robot_state")

    # --- Link-era interface shims (SDK measures pose from robot_state -> no-op) ---
    def set_target(self, y_target):
        """Link-era prediction hook; unused on SDK (pose is measured)."""
        return

    def tick(self, dt):
        """Link-era prediction tick; unused on SDK."""
        return

    def _on_robot_state(self, robot, event_type, event):
        try:
            s = self.snapshot
            now = time.monotonic()
            s["x"] = robot.pose.position.x
            s["y"] = robot.pose.position.y
            s["deg"] = self._fuse_heading(robot, now)   # gyro-fused if enabled, else raw odom
            s["origin_id"] = getattr(robot.pose, "origin_id", 0)
            s["head_rad"] = robot.head_angle_rad
            s["lift_mm"] = robot.lift_height_mm
            s["cliff"] = robot.status.is_cliff_detected
            held = robot.status.is_being_held
            s["held"] = held
            if held:
                if self._held_since is None:
                    self._held_since = now
            else:
                self._held_since = None
            s["mono_ts"] = now
            s["count"] += 1
        except Exception as e:
            logger.debug(f"robot_state handler error: {e}")

    def _fuse_heading(self, robot, now) -> float:
        """B6.4: complementary heading filter. VECTAR_GYRO_HEADING OFF -> raw odometry
        (byte-identical). ON -> integrate the IMU gyro yaw-rate (true rotation, immune to
        the tread slip that inflates odom heading on point-turns) + a weak pull toward
        odometry to cancel the gyro's own bias drift. Wrap-aware, dt-guarded."""
        odom_deg = robot.pose.rotation.angle_z.degrees
        if not config.VECTAR_GYRO_HEADING:
            return odom_deg
        gz = 0.0
        try:
            gz = float(robot.gyro.z)   # yaw rate, rad/s
        except Exception:
            gz = 0.0
        if self._gyro_deg is None or self._gyro_last is None:
            self._gyro_deg = odom_deg
        else:
            dt = now - self._gyro_last
            if 0.0 < dt < 0.5:
                self._gyro_deg += math.degrees(gz) * dt              # trust gyro for rotation
                err = (odom_deg - self._gyro_deg + 180.0) % 360.0 - 180.0
                self._gyro_deg += err * config.GYRO_ODOM_ALPHA      # cancel gyro bias drift
        self._gyro_last = now
        return (self._gyro_deg + 180.0) % 360.0 - 180.0

    @property
    def held_duration(self) -> float:
        if self._held_since is None:
            return 0.0
        return time.monotonic() - self._held_since

    @property
    def fresh(self) -> bool:
        """Pose younger than 0.5 s."""
        return (time.monotonic() - self.snapshot["mono_ts"]) < 0.5
