# Gameplay & Session Flow

## Setup ritual (~30 seconds)

1. **Table** — clear ~1 m² of flat surface. Good Wi-Fi at the table matters
   more than anything else (see SERVER.md troubleshooting).
2. **Server up**, robot connected (dashboard green), lens started on
   Spectacles.
3. **Calibrate** — the lens asks you to place your hand flat on the table
   (SurfacePlacement hand calibration, progress ring). This anchors the AR
   field to the physical surface.
4. **Place Vector** — a glowing pad appears at the field's far side with a
   nose arrow: put the physical robot on it **facing you**. The START button
   stays dim while the robot is held; set him down and it lights up.
5. **START** (press the arcade button with your palm) — the robot drives to
   his goal line while the circuit board assembles around him: tubes drop,
   capacitors pop in, traces energize. A lightning storm reveal, then
   countdown.

Facing-the-player placement is deliberate: from 180° he makes symmetric ~90°
turns to either patrol side (no 180° flips), and his eyes — the show — stay
on you.

## Rules

- Classic air-hockey: score by getting the puck past Vector into his goal
  (the pink tube absorbs it); he scores by getting it past you.
- **First to 5** wins the match (`WIN_SCORE`).
- Serve: the capacitors "summon" the puck to center with lightning after
  every goal.
- Field 400×300 mm; puck serves at 135 mm/s, accelerates on hits up to
  235 mm/s.

## Your mallet

No grabbing: reach your hand **over the field** and the mallet materializes
under your palm (lightning flash + SFX); it follows your hand, clamped inside
the walls. Pull your hand away and it vanishes. Right hand by default
(`useLeftHand` flag in HandPaddle for lefties).

## Vector, the goalie

- Patrols his goal line standing sideways, strafing to the predicted
  intercept (wall bounces included in the prediction).
- **Blocks** with his body — a real save: the puck bounces off his physical
  footprint, he flashes a face reaction, jabs his lift, grunts ("Hah!",
  "Nope!").
- **Conceding** → salty voice line + sad eyes + a frustrated animation.
  **Scoring** → cocky line, green victory eyes.
- **Match end** → a full win dance or a lose sulk, then the button relights
  for a rematch.
- His head tracks the puck the whole rally; between plays he looks at you.

## The AR world

Cyber-arcade circuit board: neon tube borders (green sides, pink goals),
PCB traces with traveling energy pulses feeding real 3D components (glass
capacitors with tesla arcs, resistors, an LED score chip with CRT-green
digits), ambient dust motes, comet puck trail, volumetric goal shockwaves.
The real robot occludes AR correctly (his own mesh renders depth-only), and
an articulated AR ghost mirrors his head/lift live.

## While you play (dashboard)

http://localhost:8780 shows robot battery, field pose, lens link and rally
state — useful on a phone during table-side debugging.

## If things drift

Long sessions accumulate odometry drift (tread slip). The included YOLO
vision correction absorbs most of it; if the physical robot visibly disagrees
with his AR ghost, just finish the rally — a goal reset re-parks him — or
re-place him on the pad (the lens will prompt if the server declares
`delocalized`).
