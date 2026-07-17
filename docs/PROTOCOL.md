# Lens ↔ Server WebSocket Protocol (`ws://<mac>:8777`)

JSON text frames, one object per message, discriminator field `t`.
Source of truth: `server/game_bridge/protocol.py` (validating constructors) and
`lens/Assets/Scripts/WSClient.ts`.

- All coordinates are **field-frame millimeters** (origin field center,
  +X toward Vector's goal, +Y player's left). Angles in degrees CCW,
  0° = +X.
- One lens client at a time; a new connection supersedes the old
  (`close 4000 "superseded"`).
- ⚠️ **Coalescing**: Lens Studio's WebSocket merges rapid sends into ONE text
  frame. The server parses frames with `decode_many()` (repeated
  `raw_decode`); any custom client must be ready for concatenated JSON
  objects per frame.

## Lens → Server

| `t` | required fields | meaning |
|---|---|---|
| `hello` | `role`, `proto` | session start/restart. Server fully resets game state (rally off, puck cleared, motors stopped) and answers `welcome`. |
| `place_confirm` | `field {l,w}`, `robotFieldPose {x,y,deg}` | "Vector is physically standing at this field pose" — binds the odometry↔field transform. Rejected (→ `delocalized "no_fresh_pose"`) if robot telemetry isn't fresh. |
| `puck` | `x,y,vx,vy,ts` | puck state @ ~30 Hz during rallies; feeds intercept prediction. |
| `event` | `name` | game event. Names: `rally_start, goal_player, goal_vector, game_over, pause, resume, vector_block, countdown, battery_picked_player, battery_picked_vector, puck_paddle, puck_wall`. `game_over` carries `score {player, vector}`. |
| `vision_fix` | `x,y,conf,ts` | YOLO sighting of the REAL robot in field mm; server blends into the transform (`conf ≥ 0.4`). |
| `ping` | `ts` | liveness; server echoes `pong`. |
| `utter` | `text` | (voice agent) player speech transcript. |
| `llm_response` | `req` | (voice agent) Gemini's reply, carried back for the server's request id. |

## Server → Lens

| `t` | required fields | meaning |
|---|---|---|
| `welcome` | `proto`, `robot` | reply to hello; `robot` ∈ `connected / no_control / disconnected`. |
| `pose` | `x,y,deg,vy,ts,seq,head,lift,drv` | robot field pose @ 30 Hz. `head` = head angle rad, `lift` = lift height mm (drive the avatar's articulation), `drv` = 1 while driving. |
| `robot_status` | `battery,cliff,held,busy` (+`originId`) | 1 Hz robot health. `busy` = choreography state (`idle`, or the anim/say playing). `held` gates the placement UI ("put him down"). |
| `anim_done` | `name` | a queued choreography finished (lens sequences on this). |
| `delocalized` | `reason` | transform invalidated (`robot_link_lost`, `no_fresh_pose`, `escaped`, `held`) → lens must re-run robot placement. A bare `{"t":"relocalized"}` may follow if the link recovers with odometry intact. |
| `say` | `text` | text the robot is speaking right now → lens shows a speech bubble. |
| `battery` | `on,x,y` | power-up cell spawn/despawn for the goalie to hunt (game mode extra). |
| `pong` | `ts` | ping echo. |
| `llm_request` | `req` | (voice agent) prompt bundle for the lens to send to Gemini through RSG. |

## Session lifecycles

**Normal game:**
```
lens                                server
 │ hello ─────────────────────────►│  (full reset)
 │◄───────────────────── welcome   │
 │  ...player calibrates, places robot...
 │ place_confirm ──────────────────►│  (transform binds)
 │◄──────────────── pose @30Hz ... │
 │ event rally_start ─────────────►│
 │ puck @30Hz ────────────────────►│  (goalie drives)
 │ event vector_block ────────────►│  (face flash + grunt)
 │ event goal_player ─────────────►│  (sad anim + salty line)
 │ event game_over {score} ───────►│  (win/lose dance)
```

**Robot trouble mid-game:** telemetry goes stale → server freezes the rally
and stops the wheels; when telemetry returns it either resumes silently
(`relocalized`, odometry origin unchanged) or asks for re-placement
(`delocalized`, robot rebooted/escaped/was picked up).

## Testing without a lens

`python -m game_bridge.sim.fake_puck --volleys 6 --speed 200 --deg 180`
pretends to be the lens: sends `place_confirm` + scripted volleys and prints
intercept margins. Robot must physically stand at the field mark (see
GAMEPLAY.md) when you start it.
