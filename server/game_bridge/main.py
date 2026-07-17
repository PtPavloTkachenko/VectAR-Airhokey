"""Bridge — assembles WS server + robot control into the game loop.

Run:
    python -m game_bridge.main                      # real robot
    python -m game_bridge.main --no-robot           # WS only, robot="disconnected"
    python -m game_bridge.main --no-robot --mock-pose   # M2: simulated goalie
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import time

from . import config, protocol
from .transform import RobotFieldTransform
from .ws_server import WSServer
from .robot.goalie import (
    FieldPose, PuckState, SideGoalie, predict_intercept, wheel_command,
)
from .robot.safety import SafetyFlags, SafetyGate

logger = logging.getLogger("game-bridge")


class MockPosePump:
    """Simulated goalie for lens development (--mock-pose):
    tracks the last puck's predicted intercept with lag + noise."""

    def __init__(self):
        # deg=0 so that bind(robot(0,0,0) -> field(140,0,90)) yields a 90 deg
        # rotation: mock robot-frame +x maps to field +y (the patrol axis).
        self.snapshot = {"x": 0.0, "y": 0.0, "deg": 0.0, "origin_id": 1,
                         "cliff": False, "held": False,
                         "mono_ts": time.monotonic(), "count": 1}
        self._y = 0.0
        self._target = 0.0

    def set_target(self, y: float):
        self._target = max(-config.GOALIE_Y_RANGE,
                           min(config.GOALIE_Y_RANGE, y))

    def tick(self, dt: float):
        # imperfect chase: capped speed, small lag
        err = self._target - self._y
        v = max(-180.0, min(180.0, 2.0 * err))
        self._y += v * dt
        s = self.snapshot
        s["x"] = self._y          # in mock robot-frame, x maps to field y (bind handles it)
        s["y"] = 0.0
        s["deg"] = 0.0
        s["mono_ts"] = time.monotonic()
        s["count"] += 1

    @property
    def held_duration(self):
        return 0.0

    @property
    def fresh(self):
        return True


class Bridge:
    def __init__(self, use_robot: bool, mock_pose: bool):
        self.use_robot = use_robot
        self.mock_pose = mock_pose
        self.ws = WSServer()
        self.transform = RobotFieldTransform()
        self.safety = SafetyGate()
        self.side = SideGoalie()
        self.driving = False
        self._busy_stopped = False
        self.battery = None  # (x, y) power cell the goalie should hunt
        self.link = None
        self.pump = None
        self.commander = None
        self.rally_active = False
        self.last_score = [0, 0]   # [player, vector] — last reported by the lens
        self.batt_v: float | None = None
        self.batt_charging = False
        self.latest_puck: PuckState | None = None
        self._pose_seq = 0
        self._prev_field_pose: tuple[float, float, float] | None = None  # (ts, fx, fy)
        self._field_vy = 0.0
        self._delocalized_sent = False

        self.ws.on("hello", self._on_hello)
        self.ws.on("place_confirm", self._on_place_confirm)
        self.ws.on("puck", self._on_puck)
        self.ws.on("event", self._on_event)
        self.ws.on("vision_fix", self._on_vision_fix)
        self.ws.on("battery", self._on_battery)
        self.ws.on("ping", self._on_ping)
        self.chat = None   # in-game Gemini voice agent (created in run() if VECTAR_CHAT)
        if config.VECTAR_CHAT:
            self.ws.on("utter", self._on_utter)
            self.ws.on("llm_response", self._on_llm_response)
        self.ws.on_disconnect = self._on_lens_disconnect
        if self.commander:
            self.commander.on_say = lambda t: asyncio.create_task(
                self.ws.send(protocol.say(t)))
            self.commander.pose_getter = self._field_pose_now

    # --- WS handlers ---

    async def _on_hello(self, msg: dict):
        self.ws.client_role = msg.get("role", "lens")
        state = "disconnected"
        if self.mock_pose:
            state = "connected"
        elif self.use_robot and self.link and self.link.robot:
            state = "connected" if self.link.has_control else "no_control"
        # a (re)connecting lens means a fresh session — reset game state
        self.rally_active = False
        self.latest_puck = None
        self._delocalized_sent = False
        self._escape_sent = False
        self._last_snap = None
        self._busy_t0 = 0.0
        self._busy_last_zero = 0.0
        self._rebind_grace_until = 0.0  # ignore 'held' during firmware re-init
        self.safety.escaped = False
        self.battery = None
        # unbind: the new session re-places the robot anyway; a stale bind
        # + changed origin caused instant DELOCALIZED at fresh boot
        self.transform.invalidate()
        if self.commander:
            self.commander.set_wheels(0.0, 0.0)
        await self.ws.send(protocol.welcome(state))
        logger.info(f"Lens hello (proto {msg.get('proto')}), robot={state} (state reset)")

    def _field_pose_now(self):
        # snapshot is always the LAST robot_state (pump keeps it), so this
        # never returns None once bound — the recover drive used to skip on
        # a transient None and leave the robot off its post.
        if self.pump is None or not self.transform.bound:
            return None
        s = self.pump.snapshot
        if s is None:
            return None
        return self.transform.robot_to_field(s["x"], s["y"], s["deg"])

    async def _on_place_confirm(self, msg: dict):
        self.safety.escaped = False  # fresh bind clears a runaway latch
        self._escape_sent = False
        rp = msg["robotFieldPose"]
        # Never bind against a stale pose (dead gRPC stream, robot offline) —
        # a zero/frozen snapshot would silently anchor the field to garbage.
        if not self.mock_pose and (self.pump is None or not self.pump.fresh):
            logger.warning("place_confirm REJECTED: no fresh robot pose")
            await self.ws.send(protocol.delocalized("no_fresh_pose"))
            return
        snap = dict(self.pump.snapshot) if self.pump else \
            {"x": 0, "y": 0, "deg": 0, "origin_id": 0}
        self.transform.bind(
            robot_pose=(snap["x"], snap["y"], snap["deg"]),
            field_pose=(rp["x"], rp["y"], rp["deg"]),
            origin_id=snap["origin_id"],
        )
        self._delocalized_sent = False
        self._prev_field_pose = None
        # placed at center facing the player -> nod, then DRIVE to the post
        if self.commander and not self.mock_pose:
            self.commander.enqueue_drive_intro()
            self.commander.enqueue_repark()
        logger.info(
            f"Transform bound: robot ({snap['x']:.0f},{snap['y']:.0f},{snap['deg']:.0f}) "
            f"-> field ({rp['x']},{rp['y']},{rp['deg']})")

    def _on_puck(self, msg: dict):
        self.latest_puck = PuckState(
            x=msg["x"], y=msg["y"], vx=msg["vx"], vy=msg["vy"], ts=msg["ts"])
        self.safety.note_puck()

    async def _on_event(self, msg: dict):
        name = msg["name"]
        score = msg.get("score")   # [player, vector] — fed to the proactive Gemini agent
        if isinstance(score, (list, tuple)) and len(score) == 2:
            self.last_score = [int(score[0]), int(score[1])]
        logger.info(f"Game event: {name} score={score}")
        if name == "rally_start":
            self.rally_active = True
            self.safety.note_puck()
            # eyes back to game cyan
            if self.commander:
                self.commander._eye_mood(config.EYE_NORMAL)
        elif name == "puck_paddle":
            # collision sound FROM the robot (the physical speaker)
            if self.commander:
                self.commander.collision_react(config.ANIM_PUCK_PADDLE)
        elif name == "puck_wall":
            if self.commander:
                self.commander.collision_react(config.ANIM_PUCK_WALL)
        elif name in ("goal_player", "goal_vector"):
            self.rally_active = False
            self.latest_puck = None
            if self.commander:
                self.commander.enqueue_goal_choreo(
                    scored_by_vector=(name == "goal_vector"))
                if self.chat:
                    await self.chat.proactive(name, score)   # Vector comments the goal
            elif self.mock_pose:
                await asyncio.sleep(1.0)
                await self.ws.send(protocol.anim_done("mock"))
        elif name == "game_over":
            self.rally_active = False
            self.latest_puck = None
            score = msg.get("score") or [0, 0]
            if self.commander:
                self.commander.stop()
                # score = [player, vector]
                self.commander.enqueue_match_end(
                    vector_won=(score[1] > score[0]))
                if self.chat:
                    await self.chat.proactive(
                        "game_over_win" if score[1] > score[0] else "game_over_lose",
                        score)
            elif self.mock_pose:
                await asyncio.sleep(1.0)
                await self.ws.send(protocol.anim_done("mock_match_end"))
        elif name == "pause":
            self.rally_active = False
            self.latest_puck = None
            if self.commander:
                self.commander.stop()
        elif name == "resume":
            self.rally_active = True
            self.safety.note_puck()
        elif name == "countdown":
            if self.commander:
                # first countdown of the session -> greeting + how-to-play intro;
                # every countdown after -> the usual pre-serve taunt
                fired = await self.chat.intro() if self.chat else False
                if not fired:
                    self.commander.enqueue_taunt()
        elif name == "battery_picked_player":
            if self.commander:
                import random as _r
                self.commander.face_react(
                    _r.choice(config.FACE_REACT_BLOCK))
                if not (self.chat and await self.chat.proactive(
                        "battery_picked_player", score)):
                    self.commander.say_line(_r.choice(config.SAY_STOLEN))
        elif name == "battery_picked_vector":
            if self.commander:
                import random as _r
                self.commander.face_react("anim_eyepose_furious")
                if not (self.chat and await self.chat.proactive(
                        "battery_picked_vector", score)):
                    self.commander.say_line(_r.choice(config.SAY_POWER))
        elif name == "vector_block":
            if self.commander:
                import random as _r
                self.commander.face_react(_r.choice(config.FACE_REACT_BLOCK))
                self.commander.lift_jab()
                # the SHOW: spin to face the player, then back to patrol
                self.commander.enqueue_face_flash()
                # tennis-player grunt (rate-limited)
                now = time.time()
                if now - getattr(self, "_last_grunt", 0) \
                        > config.SAY_BLOCK_COOLDOWN_S:
                    self._last_grunt = now
                    self.commander.say_async(_r.choice(config.SAY_BLOCK))

    def _on_battery(self, msg: dict):
        if msg.get("on"):
            self.battery = (float(msg["x"]), float(msg["y"]))
        else:
            self.battery = None

    def _on_vision_fix(self, msg: dict):
        # when the robot has ESCAPED, relax the spatial gate so YOLO can
        # re-anchor to his real off-line position and pull him back
        far = self.safety.escaped if self.safety else False
        applied = self.transform.apply_vision_fix(
            msg["x"], msg["y"], msg["conf"], allow_far=far)
        logger.info(f"VISION_FIX ({msg['x']},{msg['y']}) conf={msg['conf']:.2f} applied={applied}")
        if applied and self.safety.escaped and self.pump:
            snap = dict(self.pump.snapshot)
            fx, fy, _ = self.transform.robot_to_field(
                snap["x"], snap["y"], snap["deg"])
            if (abs(fy) < config.GOALIE_Y_RANGE + 40
                    and abs(fx - config.GOALIE_X) < 90):
                logger.warning("ESCAPE SELF-HEAL: vision puts robot back "
                               "inside the arena — resuming without re-place")
                self.safety.escaped = False
                self._escape_sent = False
                self._delocalized_sent = False
                if self.commander:
                    self.commander.enqueue_repark()
                asyncio.create_task(
                    self.ws.send({"t": "relocalized"}))

    async def _on_ping(self, msg: dict):
        await self.ws.send(protocol.pong(msg["ts"]))

    # --- In-game Gemini voice agent (through the lens RSG; gated VECTAR_CHAT) ---
    async def _on_utter(self, msg: dict):
        if self.chat:
            await self.chat.on_utter(msg)

    async def _on_llm_response(self, msg: dict):
        if self.chat:
            self.chat.on_llm_response(msg)

    def _on_lens_disconnect(self):
        # lens gone (restart/close): full reset to the WAITING state so a
        # fresh session never inherits a stale rally or a moving robot
        self.rally_active = False
        self.latest_puck = None
        self._delocalized_sent = False
        if self.commander:
            self.commander.set_wheels(0.0, 0.0)
        logger.info("Lens disconnected -> bridge reset, waiting for reconnect")

    # --- Tasks ---

    async def cube_anchor_task(self):
        """Vision-only cube anchor (PoC-proven): every robot_observed_object
        sighting of the cube nudges translation AND heading. No BLE, no
        battery, no enable_custom_object_detection (that call crashes
        vic-engine, errors 914/915). Active only once the transform is
        bound (= after PLAY)."""
        if not config.CUBE_ANCHOR:
            return
        # robot_observed_object was a vic-engine (SDK) event — the lean
        # engine has no cube vision. YOLO vision_fix from the lens carries
        # anchoring now (this flag has defaulted off since it was retired).
        logger.warning("CUBE_ANCHOR requested but unsupported on the "
                       "VectAR Link — ignored (YOLO vision_fix covers it)")

    async def control_watchdog(self):
        """Behavior control silently drops sometimes (robot slips into
        free-play). Re-acquire every 5s so the game NEVER loses the robot."""
        while True:
            await asyncio.sleep(5.0)
            try:
                if self.link and self.link.robot:
                    ok = await self.link.ensure_control()
                    if not ok:
                        logger.warning("control watchdog: reacquire FAILED")
            except Exception as e:
                logger.debug(f"control watchdog: {e}")

    async def pose_task(self):
        interval = 1.0 / config.POSE_RATE_HZ
        while True:
            await asyncio.sleep(interval)
            if not (self.transform.bound and self.pump and self.pump.fresh):
                continue
            snap = dict(self.pump.snapshot)
            fx, fy, fdeg = self.transform.robot_to_field(
                snap["x"], snap["y"], snap["deg"])
            now = time.monotonic()
            self.transform.record_field_pose(fx, fy, now)
            if self._prev_field_pose is not None:
                pt, _, pfy = self._prev_field_pose
                dt = now - pt
                if dt > 1e-3:
                    raw_vy = (fy - pfy) / dt
                    self._field_vy = 0.7 * self._field_vy + 0.3 * raw_vy
            self._prev_field_pose = (now, fx, fy)
            self._pose_seq += 1
            await self.ws.send(protocol.pose(
                fx, fy, fdeg, self._field_vy,
                ts=time.time(), seq=self._pose_seq,
                head=snap.get("head_rad", 0.0),
                lift=snap.get("lift_mm", 32.0),
                drv=1 if self.driving else 0))
            if self.safety.escaped and not getattr(self, "_escape_sent", False):
                self._escape_sent = True
                await self.ws.send(protocol.delocalized("escaped"))
                logger.warning("ESCAPE STOP: pose far outside arena — waiting for re-place")
            # SYNC telemetry: raw odom vs field pose vs last command, 2 Hz
            if self._pose_seq % 12 == 0:
                lw, rw = getattr(self.commander, "last_wheels", (0.0, 0.0))
                logger.info(
                    "SYNC seq=%d raw=(%.0f,%.0f,%.0f) field=(%.0f,%.0f,%.0f) "
                    "wheels=(%.0f,%.0f) origin=%s held=%s",
                    self._pose_seq, snap["x"], snap["y"], snap["deg"],
                    fx, fy, fdeg, lw, rw,
                    snap["origin_id"], snap["held"])
            # delocalization check
            if (self.transform.origin_id is not None
                    and snap["origin_id"] != self.transform.origin_id
                    and not self._delocalized_sent):
                # TABLE-BANG FILTER (robot.log 19:36): mallet hits shake the
                # desk -> IMUFilter.PDWhileStationary -> vic-engine declares
                # delocalized even though the robot NEVER MOVED. If nobody
                # was holding him, silently REBIND the transform to the new
                # odometry origin at the last known field pose and play on.
                if self.pump.held_duration < 0.2:
                    fx, fy, fdeg = self.transform.robot_to_field(
                        self._last_snap["x"], self._last_snap["y"],
                        self._last_snap["deg"]) if self._last_snap else (
                        config.GOALIE_X, 0.0, 90.0)
                    self.transform.bind(
                        (snap["x"], snap["y"], snap["deg"]), (fx, fy, fdeg),
                        origin_id=snap["origin_id"])
                    logger.warning(
                        f"ORIGIN CHANGED but robot not held (table bang?) — "
                        f"silent rebind at field ({fx:.0f},{fy:.0f},{fdeg:.0f})")
                    self._rebind_grace_until = time.monotonic() + 2.5
                else:
                    await self._delocalize("origin_changed")
            elif self.pump.held_duration > config.HELD_STOP_S \
                    and not self._delocalized_sent:
                # IGNORE held during choreography: turns/anims (even
                # ignore_body_track — head/lift still move) jostle the IMU
                # and Vector's is_being_held false-fires. A real pickup on a
                # standing goalie is not happening mid-reaction. Only trust
                # held when the robot is idle AND we don't own the motors.
                choreo = (self.commander is not None
                          and (self.commander.owns_motors
                               or self.commander.busy != "idle"))
                # firmware asserts held=True during its own map re-init
                # (origin reset) — a 2.5s grace after a silent rebind stops
                # that transient from false-firing 'picked_up'
                in_grace = time.monotonic() < self._rebind_grace_until
                if not choreo and not in_grace:
                    await self._delocalize("picked_up")
            self._last_snap = snap

    async def _delocalize(self, reason: str):
        logger.warning(f"DELOCALIZED: {reason}")
        self._delocalized_sent = True
        self.rally_active = False
        self.latest_puck = None
        if self.commander:
            self.commander.stop()
        self.transform.invalidate()
        await self.ws.send(protocol.delocalized(reason))

    async def goalie_task(self):
        interval = 1.0 / config.GOALIE_RATE_HZ
        while True:
            await asyncio.sleep(interval)
            if self.pump is None:
                continue
            # DEADMAN: pose stream stale -> spam best-effort STOP through
            # whatever is left of the connection. set_wheel_motors persists
            # robot-side until overwritten; a half-dead link mid-drive means
            # a runaway robot (observed live!). Never drive on stale pose.
            if not self.mock_pose and not self.pump.fresh:
                if self.commander:
                    self.commander.set_wheels(0.0, 0.0)
                continue
            if not self.transform.bound:
                continue
            # NO LENS = NO GAME: if no client is connected (screen game stopped,
            # glasses closed), HOLD ZERO every tick and never drive. Without
            # this the goalie keeps reparking/patrolling on a stale bound
            # transform after the lens is gone -> runaway (screen-game STOP bug).
            if self.ws.client is None:
                if self.commander:
                    self.commander.set_wheels(0.0, 0.0)
                self.driving = False
                continue
            # LENS-SILENCE WATCHDOG: sleeping glasses leave TCP half-open
            # (no disconnect event) — 1.5s of silence in a rally means STOP
            if (self.rally_active and self.ws.last_msg_at > 0
                    and time.monotonic() - self.ws.last_msg_at > 1.5):
                self.rally_active = False
                if self.commander:
                    self.commander.set_wheels(0.0, 0.0)
                logger.warning("Lens silent 1.5s -> rally stop")
                continue
            if self.commander and self.commander.busy != "idle":
                self.driving = False
                # HANDS OFF while the choreography owns the motors: direct
                # set_wheel_motors(0,0) FIGHTS turn_in_place / drive_straight
                # at the motor-arbitration level and makes the robot stutter
                # on every turn (user-observed 'tупить'). Only kill leftover
                # wheels during the brief window BEFORE a behavior move grabs
                # the motors.
                if self.commander.owns_motors:
                    self._busy_stopped = True  # leftover already superseded
                    continue
                now_b = time.monotonic()
                if not self._busy_stopped:
                    self._busy_stopped = True
                    self._busy_t0 = now_b
                    self._busy_last_zero = 0.0
                if (now_b - self._busy_t0 < 0.25
                        and now_b - self._busy_last_zero > 0.1):
                    self.commander.force_stop()
                    self._busy_last_zero = now_b
                continue
            snap = dict(self.pump.snapshot)
            fx, fy, fdeg = self.transform.robot_to_field(
                snap["x"], snap["y"], snap["deg"])
            pose = FieldPose(x=fx, y=fy, deg=fdeg)

            y_target = 0.0  # home
            if self.rally_active and self.latest_puck is not None:
                hit = predict_intercept(self.latest_puck)
                if hit is not None:
                    y_target = max(-config.GOALIE_Y_RANGE,
                                   min(config.GOALIE_Y_RANGE, hit))
                elif self.battery is not None:
                    # HUNT THE POWER CELL: park on its y so blocks deflect
                    # the puck into it (that is how Vector "picks it up")
                    y_target = max(-config.GOALIE_Y_RANGE,
                                   min(config.GOALIE_Y_RANGE,
                                       self.battery[1]))
                elif self.latest_puck.vx < 0:
                    # puck moving away — drift to its y as light anticipation
                    y_target = max(-config.GOALIE_Y_RANGE,
                                   min(config.GOALIE_Y_RANGE,
                                       self.latest_puck.y * 0.65))

            if self.mock_pose:
                self.pump.set_target(y_target)
                self.pump.tick(interval)
                continue

            if config.SHOWMAN:
                # SIDE MODE: fore/aft patrol along the goal line, standing
                # sideways. Turns are CHOREOGRAPHY-ONLY (block flash, goals).
                cmd = self.side.command(y_target, pose)
            else:
                cmd = wheel_command(y_target, pose)
            flags = SafetyFlags(
                cliff=snap["cliff"], held=snap["held"],
                has_control=(self.link.has_control if self.link else False))
            cmd = self.safety.filter(
                cmd, fy, flags, rally_active=self.rally_active,
                pose_deg=fdeg, pose_x=fx)
            self._busy_stopped = False
            self.driving = cmd != (0.0, 0.0)
            self.transform.stationary = not self.driving
            if self.commander:
                self.commander.set_wheels(*cmd)
                if config.HEAD_TRACKING:
                    self._track_head(snap, fx, fy)

    def _track_head(self, snap: dict, fx: float, fy: float):
        """Head follows the puck: tilt down as it gets close, glance up at
        the player when idle. Real-time motor path, same rate as wheels."""
        import math as _m
        if self.rally_active and self.latest_puck is not None:
            d = max(30.0, _m.hypot(self.latest_puck.x - fx,
                                   self.latest_puck.y - fy))
            target = -_m.atan2(config.HEAD_EYE_HEIGHT_MM, d)
        else:
            target = config.HEAD_IDLE_RAD
        target = max(config.HEAD_MIN_RAD, min(config.HEAD_MAX_RAD, target))
        # Link = head POSITION control (no velocity command); the commander
        # dedupes so this is cheap at wheel rate
        self.commander.set_head_target(target, speed=config.HEAD_MAX_SPEED * 2)

    async def health_task(self):
        """Watch for a stale VectAR Link and resume cleanly when it returns.

        Reconnecting itself is the Link supervisor's job (it cycles the
        .194/.195 DHCP bounce with backoff). Our job: freeze the rally
        while telemetry is stale, then — when frames flow again — decide
        whether the transform survived. vic-robot odometry is CONTINUOUS
        across a WiFi blip, so the transform is still valid unless the
        robot REBOOTED (pose_pump bumps origin_id on a timestamp
        regression)."""
        if not self.use_robot:
            return
        stale = False
        bound_origin = None
        while True:
            await asyncio.sleep(2.0)
            if self.pump is None or self.link is None:
                continue
            age = time.monotonic() - self.pump.snapshot["mono_ts"]
            if age < 3.5:
                if stale:
                    # link came back — force a fresh stop, then keep or drop
                    # the transform depending on whether the robot rebooted
                    stale = False
                    self.commander._last_wheels = (999.0, 999.0)  # force send
                    self.commander.force_stop()
                    snap = dict(self.pump.snapshot)
                    if (bound_origin is not None
                            and snap.get("origin_id") == bound_origin):
                        logger.info(
                            "Link recovered, SAME odometry origin — "
                            "transform kept, resuming without re-place")
                        await self.ws.send({"t": "relocalized"})
                    elif bound_origin is not None:
                        self.transform.invalidate()
                        await self.ws.send(
                            protocol.delocalized("robot_link_lost"))
                        logger.info("Link recovered after a robot reboot — "
                                    "waiting for new place_confirm")
                continue
            if not stale:
                stale = True
                bound_origin = self.transform.origin_id
                self.rally_active = False
                logger.warning(
                    f"Pose stale for {age:.0f}s — Link supervisor is "
                    f"reconnecting; rally frozen")

    async def status_task(self):
        battery = 0
        counter = 0
        while True:
            await asyncio.sleep(1.0)
            if self.ws.client is None:
                continue
            snap = dict(self.pump.snapshot) if self.pump else {}
            counter += 1
            # robot_state telemetry has no voltage on the SDK transport —
            # battery_task polls it into self.batt_v
            v = snap.get("batt_v") or self.batt_v
            if self.use_robot and v:
                # map the usable window (3.62 V = low latch, ~4.1 V = full) to %
                battery = int(max(0.0, min(1.0, (v - 3.6) / 0.5)) * 100)
            busy = self.commander.busy if self.commander else "idle"
            await self.ws.send(protocol.robot_status(
                battery=battery,
                cliff=bool(snap.get("cliff")), held=bool(snap.get("held")),
                busy=busy, origin_id=int(snap.get("origin_id", 0))))

    async def battery_task(self):
        """Poll battery over the SDK (~20 s) for the dashboard + lens HUD."""
        while True:
            await asyncio.sleep(5.0 if self.batt_v is None else 20.0)
            if not (self.link and self.link.robot):
                continue
            try:
                fut = self.link.robot.get_battery_state()
                b = await asyncio.wait_for(
                    asyncio.to_thread(fut.result, 10), timeout=15)
                self.batt_v = float(getattr(b, "battery_volts", 0.0)) or None
                self.batt_charging = bool(getattr(b, "is_charging", False))
            except Exception as e:
                logger.debug(f"battery poll: {e}")

    async def connect_robot(self) -> bool:
        """Connect + acquire control over the SDK (gRPC). NON-FATAL: returns
        False when the robot is unpaired or unreachable — the server keeps
        running so the web UI can pair and then retry via /api/connect."""
        if self.link and self.link.robot:
            return True   # already connected
        from .robot.sdk.connection import RobotLink
        from .robot.sdk.pose_pump import PosePump
        from .robot.sdk.commander import RobotCommander

        self.link = RobotLink()
        ok = await self.link.connect()
        if not ok or not self.link.has_control:
            logger.warning(
                "Robot not connected — server stays up; pair/retry from the "
                f"web UI (http://localhost:{config.WEB_PORT})")
            self.link = None
            return False
        self.pump = PosePump(self.link.robot)
        self.pump.start()
        self.commander = RobotCommander(self.link, self.pump, self.transform)

        def _notify_anim_done(name: str):
            # the recover drive may have brought an 'escaped' robot home
            if self.safety.escaped and self.pump:
                snap = dict(self.pump.snapshot)
                fx, fy, _ = self.transform.robot_to_field(
                    snap["x"], snap["y"], snap["deg"])
                if abs(fy) < config.GOALIE_Y_RANGE + 40 \
                        and abs(fx - config.GOALIE_X) < 90:
                    logger.warning("ESCAPE cleared after recover drive")
                    self.safety.escaped = False
                    self._escape_sent = False
                    self._delocalized_sent = False
                    asyncio.create_task(
                        self.ws.send({"t": "relocalized"}))
            asyncio.create_task(self.ws.send(protocol.anim_done(name)))

        self.commander.on_anim_done = _notify_anim_done
        # wire HERE: the setup-time `if self.commander:` block ran before
        # the commander existed, so pose_getter stayed None and every
        # TURN_TO was silently skipped
        self.commander.on_say = lambda t: asyncio.create_task(
            self.ws.send(protocol.say(t)))
        self.commander.pose_getter = self._field_pose_now
        if config.VECTAR_CHAT and self.chat is None:
            from .chat import GameChat
            self.chat = GameChat(self.ws.send, self.commander)
            logger.info("VECTAR_CHAT ON — in-game Gemini voice agent armed "
                        "(lens must run LLMProxy RSG + ASR->utter)")
        # run_queue as its own task so late connects (post-pairing) work too
        self._commander_task = asyncio.create_task(self.commander.run_queue())
        return True

    async def run(self):
        if self.mock_pose:
            self.pump = MockPosePump()
            logger.info("MOCK POSE mode — simulated goalie, no robot")
        elif self.use_robot:
            await self.connect_robot()   # non-fatal; web UI can retry
        else:
            logger.info("--no-robot: WS server only")

        await self.ws.start()
        self.web = None
        if config.WEB_PORT:
            try:
                from .web.server import WebUI
                self.web = WebUI(self)
                await self.web.start()
            except Exception as e:
                logger.warning(f"Web UI failed to start (continuing): {e}")
        tasks = [self.pose_task(), self.goalie_task(), self.status_task(),
                 self.health_task(), self.control_watchdog(),
                 self.battery_task(), self.cube_anchor_task()]
        try:
            await asyncio.gather(*tasks)
        finally:
            if self.commander:
                self.commander.stop()
            if self.link:
                await self.link.disconnect()
            if self.web:
                await self.web.stop()


def main():
    p = argparse.ArgumentParser(description="Vector Robo Air-Hockey bridge")
    p.add_argument("--no-robot", action="store_true")
    p.add_argument("--mock-pose", action="store_true",
                   help="simulate goalie pose (implies --no-robot)")
    p.add_argument("--no-web", action="store_true",
                   help="disable the web UI (pairing wizard + dashboard)")
    p.add_argument("--log-level", default="INFO")
    args = p.parse_args()
    if args.no_web:
        config.WEB_PORT = 0
    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    bridge = Bridge(use_robot=not (args.no_robot or args.mock_pose),
                    mock_pose=args.mock_pose)
    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        logger.info("Bye")


if __name__ == "__main__":
    main()
