# Architecture

Three machines, one game. The design principle: **the lens is the game
authority, the server is the robot's brainstem, the robot is a physical
peripheral with a personality.**

```
┌─────────────────────┐   ws://mac:8777    ┌──────────────────────┐  gRPC :443 (TLS)  ┌─────────────┐
│  Spectacles lens    │ ◄────────────────► │  Mac game server     │ ◄───────────────► │   Vector    │
│                     │                    │  (game_bridge)       │                   │             │
│ · 60 fps puck       │  puck @30Hz  ──►   │ · goalie AI          │  wheel motors ──► │ · drives    │
│   physics + score   │  events      ──►   │   (SideGoalie)       │  head/anims  ──►  │ · saves     │
│ · AR field render   │  vision_fix  ──►   │ · robot↔field        │  say_text    ──►  │ · talks     │
│ · hand input (SIK)  │  utter       ──►   │   transform          │  ◄── pose @~17Hz  │ · emotes    │
│ · YOLO robot detect │  ◄── pose @30Hz    │ · safety gate        │  ◄── battery,     │             │
│ · Gemini via RSG    │  ◄── robot_status  │ · choreography       │      cliff, held  │             │
│                     │  ◄── llm_request   │ · voice lines        │                   │             │
└─────────────────────┘                    └──────────────────────┘                   └─────────────┘
```

## Authority split

- **Lens = game authority.** Puck physics run at render rate on the glasses
  (zero-latency bounce off your mallet), score is decided there, and every
  game event (`goal_*`, `vector_block`, `game_over`…) is *announced* to the
  server, never negotiated. If the server dies mid-rally the game pauses; the
  robot never decides game outcomes.
- **Server = robot control.** The only thing that ever commands the robot.
  Goalie AI, motion safety, animation/voice choreography, and the coordinate
  transform all live here, in Python, at ~33 Hz.
- **Robot = stock Vector.** No custom firmware. The server drives it through
  the `anki_vector` SDK (wirepod-vector-sdk fork) over vic-gateway's gRPC
  port 443, holding behavior control at OVERRIDE priority so its idle
  personality can't grab the wheels mid-rally.

## The field frame

Everything game-related is expressed in **field millimeters**:

- Origin = field center. **+X** points at Vector's goal, **+Y** = player's
  left. The field is 400×300 mm (`FIELD_L`/`FIELD_W` in both configs — they
  must match).
- Vector patrols the line `x = GOALIE_X` (140 mm), `y ∈ [−110, +110]`.
- The lens works in world **cm** (Lens Studio units); `FieldMath.ts` converts.
  The server works in robot odometry mm; `transform.py` converts.

**Binding**: when you place Vector on the glowing pad and press START, the
lens sends `place_confirm` with the robot's field pose `{x:140, y:0, deg:180}`
(placed facing the player). The server binds its odometry frame to the field
frame at that instant (`RobotFieldTransform`). From then on every odometry
update maps to field coordinates.

**Drift correction**: tread slip (especially on turns) slowly corrupts
odometry. Two mitigations:
1. The goalie is designed to *avoid turning* — `SideGoalie` strafes fore/aft
   along the goal line standing sideways; turns are choreography-only.
2. Optional **vision fixes**: the lens runs YOLO on the Spectacles camera,
   projects the robot's bounding box onto the calibrated surface, and sends
   `vision_fix {x, y, conf}`. The server blends them into the transform
   (complementary filter, `ALPHA_VISION`) and re-anchors on confident
   clusters.

## Server internals (`server/game_bridge/`)

| Module | Role |
|---|---|
| `main.py` | `Bridge` — owns everything; async tasks: `pose_task` (30 Hz pose → lens), `goalie_task` (33 Hz control loop), `status_task` (1 Hz robot_status), `health_task` (stale-telemetry watchdog), `control_watchdog` (behavior-control keepalive) |
| `ws_server.py` | WebSocket :8777, single lens client (new connection supersedes old) |
| `protocol.py` | message schema + validation; handles Lens Studio's frame coalescing (`decode_many`) |
| `transform.py` | robot↔field rigid transform + vision-fix filtering |
| `robot/goalie.py` | intercept prediction (wall-fold geometry) + `SideGoalie` controller |
| `robot/safety.py` | `SafetyGate` — field bounds corridor, cliff/held freeze, escape latch |
| `robot/sdk/` | SDK transport: `connection.py` (connect + behavior control), `pose_pump.py` (telemetry snapshot), `commander.py` (wheels/head/anims/TTS + choreography queue) |
| `web/` | web console :8780 — pairing wizard + dashboard (see PAIRING.md) |
| `chat.py` | optional in-game Gemini voice agent (rides the lens's RSG — the server holds **no** API key) |
| `sim/fake_puck.py` | fake lens: scripted volleys for robot-only testing |

### Safety design (learned the hard way)

- `set_wheel_motors` **persists robot-side** until overwritten. A dead
  connection mid-drive = runaway robot. Therefore: the goalie loop has a
  **deadman** — pose telemetry stale >0.5 s → spam best-effort STOP; never
  drive on stale pose. Reconnects force-send a stop as the first action.
- `SafetyGate` clamps commands to an X-corridor around the goal line and
  soft Y-bounds, projecting velocity through the robot's heading; a pose far
  outside the arena latches an emergency stop (`escaped`) until re-placement.
- Cliff/held sensors freeze motion instantly; sustained held →
  `delocalized` → the lens asks you to re-place the robot.

## Lens internals (`lens/Assets/Scripts/`)

| Script | Role |
|---|---|
| `GameController.ts` | state machine: CALIBRATE → PLACE_VECTOR → ROBOT_TO_POST → START → COUNTDOWN → RALLY → GOAL_PAUSE → GAME_OVER |
| `GameConfig.ts` | all tunables incl. `WS_URL` (your Mac) |
| `PuckPhysics.ts` | 60 fps puck integration, wall/mallet/robot collision |
| `HandPaddle.ts` | the mallet: materializes under your hand over the field (SIK hand tracking) |
| `FieldBuilder.ts` + `GlowKit.ts` | the whole neon circuit-board world, built in code (see GLOWKIT.md) |
| `VectorAvatar.ts` | the robot's AR ghost: occluder mesh + articulated head/lift mirroring telemetry |
| `GoaliePredictor.ts` | zero-lag predictive occluder (mirrors the server's controller locally) |
| `VisionFix.ts` + `ML/` | YOLO robot detection → `vision_fix` corrections |
| `WSClient.ts` | :8777 client, reconnect, ping/pong |
| `ScoreUI.ts`, `VFXBursts.ts`, `FXController.ts`, `DecoAnimator.ts`, `IntroAssembler.ts` | score chip, lightning/shockwaves, SFX/music, ambient animation, board assembly intro |
| `VoiceTalk.ts` + `LLMProxy.ts` | optional voice agent (ASR → server → Gemini via RSG → robot TTS) |

## Latency budget

Wheel-command round trip (lens event → robot motion) measured p50 ≈ 30 ms,
p95 ≈ 62 ms on a normal home network — comfortably inside the ~350 mm/s puck's
travel time across the defense zone. The predictive occluder hides the
remaining visual echo (~200 ms) by rendering *intent* instead of measured pose.
