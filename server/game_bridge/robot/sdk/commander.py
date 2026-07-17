"""RobotCommander — the ONLY module that talks to the SDK for actions.

Two paths:
- Real-time: set_wheels() — direct fire-and-forget gRPC (motors.set_wheel_motors),
  called from the goalie loop at 20 Hz. No queue, no await on result.
- Choreography: queued coroutines (animations, eye color, repark) executed
  one at a time; `busy` is exposed so the goalie loop pauses during them.
"""
from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from typing import Callable, Optional

from ... import config

logger = logging.getLogger("game-bridge.commander")


class RobotCommander:
    def __init__(self, link, pose_pump, transform):
        self._link = link
        self._pump = pose_pump
        self._transform = transform
        self._queue: asyncio.Queue = asyncio.Queue()
        self.busy: str = "idle"
        self._last_sent_at = 0.0   # idle | anim | repark
        self._last_wheels = (0.0, 0.0)
        self.on_anim_done: Optional[Callable[[str], None]] = None

    # --- Real-time path ---

    def set_wheels(self, left: float, right: float):
        robot = self._link.robot
        if robot is None:
            return
        self.last_wheels = (left, right)  # SYNC telemetry
        now = time.monotonic()
        if (left, right) == self._last_wheels:
            # identical command: robot-side value persists — skip the gRPC
            # call entirely; refresh every 0.4s as a dropped-packet guard
            if (left, right) == (0.0, 0.0) or now - self._last_sent_at < 0.4:
                return
        try:
            robot.motors.set_wheel_motors(left, right)
            self._last_wheels = (left, right)
            self._last_sent_at = now
        except Exception as e:
            logger.debug(f"set_wheels failed: {e}")

    def force_stop(self):
        """Zero the wheels BYPASSING the dedupe — used as a burst right
        after entering busy: a single stop packet can vanish in a WiFi
        stall while the robot-side wheel command persists (observed:
        -17 -> -285mm sprint during a goal pause)."""
        robot = self._link.robot
        if robot is None:
            return
        try:
            robot.motors.set_wheel_motors(0.0, 0.0)
            self._last_wheels = (0.0, 0.0)
            self.last_wheels = (0.0, 0.0)
        except Exception as e:
            logger.debug(f"force_stop failed: {e}")

    def stop(self):
        self.set_wheels(0.0, 0.0)
        self.set_head_speed(0.0)

    def set_head_speed(self, speed: float):
        """Real-time head motor control (rad/s-ish, fire-and-forget)."""
        robot = self._link.robot
        if robot is None:
            return
        try:
            robot.motors.set_head_motor(speed)
        except Exception as e:
            logger.debug(f"set_head_motor failed: {e}")

    # --- Link-era interface shims (demo parity; minimal, "без фанатизму") ---
    def set_head_target(self, rad: float, speed: float = 4.0):
        """Link API: track head toward `rad` (radians). SDK: proportional via
        set_head_speed using the pump's measured head_rad."""
        try:
            cur = float(self._pump.snapshot.get("head_rad", 0.0))
        except Exception:
            cur = 0.0
        v = (rad - cur) * config.HEAD_KP
        v = max(-speed, min(speed, v))
        self.set_head_speed(v)

    def collision_react(self, clip: str):
        """Link API: robot plays a short collision SOUND clip. SDK demo shim:
        no-op — config.ANIM_PUCK_* are on-robot CLIP names, not SDK triggers.
        (Robot-as-speaker collision SFX is Link-era polish; map SDK triggers later.)"""
        return

    def _eye_mood(self, color: tuple):
        """Link eye-color helper -> SDK queued eye set (never blocks the goalie loop)."""
        async def job():
            await self._set_eye_color(color[0], color[1])
        try:
            self._queue.put_nowait(job)
        except Exception:
            pass

    def face_react(self, name: str):
        """Eyes-only reaction: play a trigger with body/head/lift tracks
        ignored so the goalie never leaves position. Fire-and-forget,
        bypasses the choreography queue (doesn't set busy)."""
        robot = self._link.robot
        if robot is None or self.busy != "idle":
            return
        try:
            trig = getattr(robot.anim, "_anim_trigger_dict", {}).get(name)
            if trig is None:
                return
            robot.anim.play_animation_trigger(
                trig, ignore_body_track=True, ignore_head_track=True,
                ignore_lift_track=True)
            logger.info(f"Face reaction: {name}")
        except Exception as e:
            logger.debug(f"face_react failed: {e}")

    # --- Choreography path ---

    async def run_queue(self):
        """Consume choreography jobs forever (task in Bridge)."""
        while True:
            job = await self._queue.get()
            try:
                await job()
            except Exception as e:
                logger.error(f"Choreography job failed: {e}")
            finally:
                self.busy = "idle"
                self._queue.task_done()

    def say_async(self, text: str):
        """Fire-and-forget grunt — must NOT block the goalie loop."""
        async def job():
            await self._say(text)
        self._queue.put_nowait(job)

    on_say = None  # main wires this -> speech bubble on the lens

    pose_getter = None  # bridge wires: () -> (fx, fy, fdeg) field pose
    owns_motors = False  # True while a behavior move (turn/drive/anim) runs

    _last_flash = 0.0

    async def _head_nod(self, times: int = 2):
        """Quick 'come here' nods via the head motor."""
        robot = self._link.robot
        if robot is None:
            return
        try:
            for _ in range(times):
                robot.motors.set_head_motor(-4.0)
                await asyncio.sleep(0.16)
                robot.motors.set_head_motor(4.0)
                await asyncio.sleep(0.22)
            robot.motors.set_head_motor(0.0)
        except Exception:
            pass

    def enqueue_taunt(self):
        """Pre-serve stare-down: face the player, RED eyes, double nod,
        a short line — then back to patrol. Fits the countdown window."""
        async def job():
            try:
                self.busy = "anim"
                self.stop()
                # NO turn: mid-game turns displace the robot and pile up
                # odometry drift (user: turns ONLY on goals / match end)
                await self._set_eye_color(*config.EYE_ANGRY)
                if random.random() < 0.5:
                    asyncio.create_task(
                        self._say(random.choice(config.SAY_TAUNT)))
                await self._head_nod(2)
                await self._set_eye_color(*config.EYE_NORMAL)
            finally:
                self.set_wheels(0.0, 0.0)
                self.busy = "idle"
        self._queue.put_nowait(job)

    def enqueue_drive_intro(self):
        """START pressed: 'Let's go!' + happy eyes + a nod, then he rolls
        to the post (repark is queued right behind this job)."""
        async def job():
            try:
                self.busy = "anim"
                await self._set_eye_color(*config.EYE_NORMAL)
                say_task = asyncio.create_task(
                    self._say(random.choice(config.SAY_LETSGO)))
                await self._head_nod(2)
                try:
                    await asyncio.wait_for(say_task, timeout=3)
                except Exception:
                    pass
            finally:
                self.busy = "idle"
        self._queue.put_nowait(job)

    def enqueue_face_flash(self):
        """Block celebration: spin to face the player, hold a beat,
        spin back to the sideways patrol. Wheels are ours (busy set).
        DROPPABLE: skipped when anything else is running/queued, and
        rate-limited — blocks fire every couple seconds in a hot rally."""
        now = time.monotonic()
        if (self.busy != "idle" or not self._queue.empty()
                or now - self._last_flash < 7.0):
            return
        self._last_flash = now
        async def job():
            try:
                self.busy = "anim"
                # NO TURN: mid-rally turns are forbidden (user rule —
                # turns only on goals / match end). Eyes + lift jab only.
                await self._set_eye_color(*config.EYE_VICTORY)
                robot = self._link.robot
                if robot is not None:
                    robot.motors.set_lift_motor(4.0)
                    await asyncio.sleep(0.18)
                    robot.motors.set_lift_motor(-4.0)
                    await asyncio.sleep(0.18)
                    robot.motors.set_lift_motor(0.0)
                await asyncio.sleep(0.3)
                await self._set_eye_color(*config.EYE_NORMAL)
            finally:
                self.set_wheels(0.0, 0.0)
                self.busy = "idle"
        self._queue.put_nowait(job)

    async def _recover_position(self):
        """Goal anims physically DRIVE (sad ones back away) — if the anim
        displaced the robot off his post, drive home nose-first NOW while
        we still own the goal pause. Returns True if a recovery ran."""
        pose = self.pose_getter() if self.pose_getter else None
        if pose is None:
            return False
        dx = config.GOALIE_X - pose[0]
        dy = 0.0 - pose[1]
        # even if position is fine, we were turned to face the player —
        # always fall through to the axis-settle at the end
        need_drive = abs(dx) >= 55.0 or abs(pose[1]) >= 130.0  # only real displacement; a normal save on the line resumes in place
        if need_drive:
            dist = math.hypot(dx, dy)
            bearing = math.degrees(math.atan2(dy, dx))
            logger.info(f"POST-ANIM RECOVER: from ({pose[0]:.0f},"
                        f"{pose[1]:.0f}) driving {dist:.0f}mm home")
            await self._turn_to(bearing, timeout=1.4)
            robot = self._link.robot
            try:
                from anki_vector.util import distance_mm, speed_mmps
                fut = robot.behavior.drive_straight(
                    distance_mm(dist), speed_mmps(160), should_play_anim=False)
                await asyncio.wait_for(
                    asyncio.to_thread(fut.result, timeout=4), 4.5)
            except Exception as e:
                logger.warning(f"recover drive failed: {e}")
        # settle on the nearest side axis
        pose = self.pose_getter() if self.pose_getter else None
        target = 90.0
        if pose is not None:
            d_pos = ((90.0 - pose[2] + 540) % 360) - 180
            d_neg = ((-90.0 - pose[2] + 540) % 360) - 180
            target = 90.0 if abs(d_pos) <= abs(d_neg) else -90.0
        await self._turn_to(target, timeout=1.4)
        return True

    async def _turn_to(self, target_deg: float, timeout: float = 2.5):
        """Face an absolute field heading. Uses the SDK's robot-side
        turn_in_place (closed loop on the robot's own IMU — reliable),
        with the wheel servo as a fallback."""
        if self.pose_getter is None:
            logger.warning("TURN_TO: no pose_getter — skip")
            return
        pose = self.pose_getter()
        if pose is None:
            logger.warning("TURN_TO: pose unavailable — skip")
            return
        d = ((target_deg - pose[2] + 540) % 360) - 180
        logger.info(f"TURN_TO {target_deg:.0f} from {pose[2]:.0f} (d={d:.0f})")
        if abs(d) < 10.0:
            return
        robot = self._link.robot
        try:
            from anki_vector.util import degrees as _deg
            fut = robot.behavior.turn_in_place(_deg(d))
            await asyncio.wait_for(
                asyncio.to_thread(fut.result, timeout=timeout), timeout + 0.5)
            return
        except Exception as e:
            logger.warning(f"TURN_TO sdk failed ({e}) — wheel fallback")
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            pose = self.pose_getter()
            if pose is None:
                break
            d = ((target_deg - pose[2] + 540) % 360) - 180
            if abs(d) < 7.0:
                break
            w = max(-config.MAX_TURN_WHEEL,
                    min(config.MAX_TURN_WHEEL, config.KW_TURN * d))
            self.set_wheels(-w, w)
            await asyncio.sleep(0.05)
        self.set_wheels(0.0, 0.0)

    def say_line(self, text: str):
        """Fast-path one-liner (no queue, no busy)."""
        asyncio.create_task(self._say(text))

    async def _say(self, text: str):
        if self.on_say:
            try:
                self.on_say(text)
            except Exception:
                pass
        robot = self._link.robot
        if robot is None:
            return
        try:
            fut = robot.behavior.say_text(text, use_vector_voice=True)
            await asyncio.to_thread(fut.result, timeout=6)
        except Exception as e:
            logger.debug(f"say_text failed: {e}")

    def _drain_queue(self):
        try:
            while not self._queue.empty():
                self._queue.get_nowait()
        except Exception:
            pass

    def enqueue_goal_choreo(self, scored_by_vector: bool):
        self._drain_queue()  # stale block-flashes must not bury the goal
        async def job():
            name = "?"
            try:
                self.busy = "anim"
                self.owns_motors = True  # ONE window for the whole choreo
                self.stop()
                # INSTANT reaction: eyes flip immediately, then a FAST
                # closed-loop wheel turn to face the player (~0.5s), and the
                # voice line runs IN PARALLEL with the animation — no TTS
                # dead-air before he reacts.
                if scored_by_vector:
                    await self._set_eye_color(*config.EYE_VICTORY)
                    say_line = random.choice(config.SAY_SCORE)
                    name = random.choice(config.ANIM_HAPPY)
                else:
                    await self._set_eye_color(*config.EYE_SAD)
                    say_line = random.choice(config.SAY_CONCEDE)
                    name = random.choice(config.ANIM_SAD)
                # FACE THE PLAYER: the puck is dead during GOAL_PAUSE, so
                # turning here costs no gameplay rhythm. Turn -> react to the
                # player's face -> recover back to the post (which also turns
                # him sideways again). Fast SDK turn keeps the whole beat
                # inside the ~5s pause.
                asyncio.create_task(self._say(say_line))
                await self._turn_to(180.0, timeout=1.6)
                await self._play_animation(name)
                # drive home nose-first + settle on the patrol axis
                await self._recover_position()
                await self._set_eye_color(*config.EYE_NORMAL)
            finally:
                self.owns_motors = False
                if self.on_anim_done:
                    self.on_anim_done(name)
        self._queue.put_nowait(job)

    def enqueue_greeting(self):
        async def job():
            try:
                self.busy = "anim"
                self.owns_motors = True
                self.stop()
                await self._set_eye_color(*config.EYE_NORMAL)
                await self._play_animation(random.choice(config.ANIM_GREETING))
                self.busy = "repark"
                await self._repark()
            finally:
                self.owns_motors = False
                if self.on_anim_done:
                    self.on_anim_done("greeting")
        self._queue.put_nowait(job)

    def enqueue_match_end(self, vector_won: bool):
        """Full match-end drama: win dance or loss slump, then repark."""
        self._drain_queue()
        async def job():
            name = "?"
            try:
                self.busy = "anim"
                self.owns_motors = True
                self.stop()
                if vector_won:
                    await self._set_eye_color(*config.EYE_VICTORY)
                    name = random.choice(config.ANIM_GAME_WIN)
                else:
                    await self._set_eye_color(*config.EYE_SAD)
                    name = random.choice(config.ANIM_GAME_LOSE)
                # the drama plays TO the player — eyes visible
                await self._turn_to(180.0, timeout=2.5)
                await self._play_animation(name)
                self.busy = "repark"
                await self._repark()
                await self._set_eye_color(*config.EYE_NORMAL)
            finally:
                self.owns_motors = False
                if self.on_anim_done:
                    self.on_anim_done(name)
        self._queue.put_nowait(job)

    def lift_jab(self):
        """Quick lift up-down jab — the goalie 'stick save' flourish on a
        block. Real-time motor path, fire-and-forget, skipped when busy."""
        robot = self._link.robot
        if robot is None or self.busy != "idle":
            return

        async def jab():
            try:
                robot.motors.set_lift_motor(4.0)
                await asyncio.sleep(0.18)
                robot.motors.set_lift_motor(-4.0)
                await asyncio.sleep(0.18)
                robot.motors.set_lift_motor(0.0)
            except Exception as e:
                logger.debug(f"lift_jab failed: {e}")
        asyncio.create_task(jab())

    def enqueue_repark(self):
        async def job():
            try:
                self.busy = "repark"
                self.owns_motors = True
                await self._repark()
            finally:
                self.owns_motors = False
                if self.on_anim_done:
                    self.on_anim_done("repark")
        self._queue.put_nowait(job)

    # --- SDK helpers (all awaited via to_thread on the future result) ---

    async def _await_fut(self, fut, timeout: float = 15.0):
        if fut is not None and hasattr(fut, "result"):
            await asyncio.wait_for(
                asyncio.to_thread(fut.result, timeout), timeout=timeout + 5)

    async def _set_eye_color(self, hue: float, sat: float):
        robot = self._link.robot
        if robot is None:
            return
        try:
            await self._await_fut(robot.behavior.set_eye_color(hue, sat), 5)
        except Exception as e:
            logger.warning(f"set_eye_color failed: {e}")

    async def _play_animation(self, name: str):
        """Play by TRIGGER name.

        Resolve the string to the protocol AnimationTrigger via the prewarmed
        dict — passing a str makes the SDK lazy-load the FULL anim list
        (ListAnimations), which reliably times out over the repeater.
        """
        robot = self._link.robot
        if robot is None:
            return
        logger.info(f"Playing animation trigger: {name}")
        try:
            trig = getattr(robot.anim, "_anim_trigger_dict", {}).get(name, name)
            # ignore_body_track=True: play the EMOTION (eyes/head/lift/audio)
            # but DO NOT move the treads. Full-body anims (FistBumpSuccess,
            # FrustratedByFailureMajor) drove the robot and corrupted the
            # odometry->field transform, so the goalie then oscillated
            # chasing a phantom position off the goal line. Treads still =
            # odometry stays valid.
            await self._await_fut(
                robot.anim.play_animation_trigger(
                    trig, ignore_body_track=True), config.ANIM_TIMEOUT_S)
        except Exception as e:
            logger.warning(f"play_animation_trigger {name} failed: {e}")

    async def _repark(self):
        """Return to the park pose (GOALIE_X, 0, 90 deg in field frame).

        Behavior-queue moves (slow path is fine here):
        turn toward target point -> drive straight -> turn to final heading.
        Verify within REPARK_TOL_MM, retry once.
        """
        robot = self._link.robot
        if robot is None or not self._transform.bound:
            return
        from anki_vector.util import degrees, distance_mm, speed_mmps

        for attempt in (1, 2):
            snap = dict(self._pump.snapshot)
            fx, fy, fdeg = self._transform.robot_to_field(
                snap["x"], snap["y"], snap["deg"])
            dx, dy = config.GOALIE_X - fx, 0.0 - fy
            dist = math.hypot(dx, dy)
            if dist > config.REPARK_TOL_MM:
                bearing = math.degrees(math.atan2(dy, dx))  # field frame
                turn1 = _wrap(bearing - fdeg)
                try:
                    await self._await_fut(
                        robot.behavior.turn_in_place(degrees(turn1)), 10)
                    await self._await_fut(
                        robot.behavior.drive_straight(
                            distance_mm(dist), speed_mmps(80)), 15)
                except Exception as e:
                    logger.warning(f"repark drive failed: {e}")
            # final heading: face the player in showman mode (the eyes!)
            park_deg = (config.FACE_PLAYER_DEG if config.SHOWMAN
                        else config.GOALIE_HEADING)
            snap = dict(self._pump.snapshot)
            _, _, fdeg = self._transform.robot_to_field(
                snap["x"], snap["y"], snap["deg"])
            turn2 = _wrap(park_deg - fdeg)
            if abs(turn2) > 5.0:
                try:
                    await self._await_fut(
                        robot.behavior.turn_in_place(degrees(turn2)), 10)
                except Exception as e:
                    logger.warning(f"repark turn failed: {e}")
            # verify
            await asyncio.sleep(0.3)
            snap = dict(self._pump.snapshot)
            fx, fy, _ = self._transform.robot_to_field(
                snap["x"], snap["y"], snap["deg"])
            err = math.hypot(config.GOALIE_X - fx, fy)
            if err <= config.REPARK_TOL_MM:
                logger.info(f"Reparked, error {err:.0f} mm (attempt {attempt})")
                return
            logger.warning(f"Repark error {err:.0f} mm after attempt {attempt}")
        logger.warning("Repark did not converge — continuing anyway")


def _wrap(a: float) -> float:
    a = math.fmod(a, 360.0)
    if a > 180.0:
        a -= 360.0
    elif a <= -180.0:
        a += 360.0
    return a
