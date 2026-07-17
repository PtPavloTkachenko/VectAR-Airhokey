# The Lens (`lens/`)

Lens Studio **5.15** project for **Spectacles (2024)**. The whole scene —
field, props, VFX, UI — is built in code at runtime (GlowKit +
FieldBuilder), so the project itself is mostly scripts + a few assets.

## Setup

1. Install [Lens Studio 5.15.x](https://ar.snap.com/download) and open
   `lens/robo-hockey-515.esproj`.
2. `Assets/Scripts/GameConfig.ts` → set `WS_URL` to your Mac's LAN IP
   (`ipconfig getifaddr en0`), keep port `8777`.
3. Project Settings → enable **Experimental APIs** (required for `ws://` —
   plain, non-TLS WebSocket). This also means the lens can't be published to
   the public store; you run it as your own dev lens.
4. Preview panel → device = **Spectacles (2024)**.
5. Wait for *"TypeScript compilation succeeded"*, then **Send to Spectacles**
   (pair your glasses to Lens Studio first, same Wi-Fi).

⚠️ Do not open the project in a newer Lens Studio — 5.22+ silently upgrades
the project format and it won't open in 5.15 again. Copy first if you want to
experiment.

## Editor development without hardware

`GameController` has editor conveniences:

- **Skip Calibration** checkbox (GameController inputs) — field appears at
  world origin, no hand calibration.
- With the server on `--mock-pose` (or `OFFLINE` in GameConfig) you get a
  full simulated match in the Preview panel — scripted goalie included.
- In-editor, placement/start steps auto-advance after a few seconds so you
  can watch a whole match hands-off.

The Preview logs `WebSocketService for Wearable platform only` spam — that's
Lens Studio simulating the Spectacles socket; it means the connection code is
running.

## Vision positioning (included, optional at heart)

The lens can watch the REAL robot through the Spectacles camera and send
drift corrections to the server:

- Model: `Assets/ML/best.onnx` — a YOLOv7-tiny trained on Vector himself
  (included, MIT like the rest).
- Wiring (already done in the shipped scene): GameController inputs
  `mlModel` → best.onnx, `camModule` → a CameraModule asset,
  `screenCropTexture` → `Assets/ML/Screen Crop Texture` (square crop the
  model sees).
- Runs ~15 fps on-device, sends `vision_fix` only when the robot is slow
  (sharp frames, settled odometry), confidence ≥ 0.6.
- It's fully optional: unwire `mlModel` and the game still plays; odometry
  alone is fine for casual matches (expect slow drift over long sessions —
  re-place the robot between games).

Swapping in your own model: keep the YOLOv7-tiny head layout (3 heads ×
18 ch, 1 class), replace the onnx bytes, set the meta Shape to your training
resolution, and match the anchors in `ML/MLController`.

## Voice agent (optional)

Talk to Vector mid-game; a Gemini persona replies through the robot's own
TTS ("Too easy!", tactical trash-talk, rules explanations).

The AI call goes **through the lens** via Snap's Remote Service Gateway — the
Mac server holds no API key; it only builds prompts.

1. Lens Studio → install the **Remote Service Gateway** plugin/token
   generator (Asset Library) → menu bar → **Remote Service Gateway →
   Generate Token** → copy YOUR token.
2. Select the **GameController** in the Scene Hierarchy → in the Inspector,
   paste the token into the **Rsg Token** field. That's it — voice turns on
   automatically when a token is present. (Code alternative: set
   `GameConfig.RSG_GOOGLE_TOKEN`.)
3. Start the server with `VECTAR_CHAT=1`.
4. In-game: just speak — on-device ASR transcribes, Vector answers out loud
   (English only — his TTS voice is English).

Leave the **Rsg Token** field empty to play without voice — everything else
works. The token is per-developer and must **not** be committed publicly.

## Project layout

```
lens/
  robo-hockey-515.esproj
  Assets/
    Scripts/        all game code (see ARCHITECTURE.md for the script map)
    Scripts/ML*/    YOLO controller + tracking
    ML/best.onnx    Vector-detector model + Screen Crop Texture
    Models/         GLB props (tubes, capacitors, resistors, chip, puck,
                    mallet, arcade button) + vector.obj (the robot's own mesh,
                    used as occluder + articulated avatar)
    Textures/       procedural glow sprites (GlowKit)
    GeneratedSFX/   synthesized SFX + music loop (WAV)
    Shaders*/       rim-light + flat materials
  Packages/         SIK 0.17.2, SpectaclesUIKit, SurfacePlacement,
                    Spectacles3DHandHints, RemoteServiceGateway, LSTween,
                    SnapDecorators, Utilities
```

Conventions: TypeScript everywhere, SIK `NativeLogger` for logs (one global
level via `SIKLogLevelConfiguration`), no `print()`.
