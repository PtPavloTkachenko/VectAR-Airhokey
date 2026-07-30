# The 5.23 Lens (`lens-523/`)

The same air-hockey Lens as [`lens/`](LENS.md), carried forward to **Lens Studio
5.23** and the current SPECS platform. `lens/` stays exactly where it is — it is
the version proven on Spectacles (2024), and nothing here changes it.

Two folders instead of one because a Lens Studio project can only move forward:
once 5.23 upgrades a project it will not open in 5.15 again. Keeping the 5.15
project untouched is what lets the Spectacles (2024) build stay playable while
the newer one moves.

| | `lens/` | `lens-523/` |
|---|---|---|
| Lens Studio | 5.15.4 | 5.23.0 |
| Target | Spectacles (2024) | current SPECS |
| Detector | `best.onnx` | `best.onnx` + `vector_yolo_qnn.dlc` |
| Hardware-tested | yes | **no — see below** |

Everything else — the server, the protocol, the wizard, the gameplay — is
shared. The 5.23 Lens dials the same `ws://vectar.local:8777` and speaks the
same protocol, so one server plays with either.

## What the migration actually changed

The Lens code needed **no API migration**. A scan for every deprecated
Spectacles (2024) API — `RemoteServiceModule`, the `loadAs*` remote-media
calls, `StereoCameraModule`, the depth-texture providers, `VoiceMLModule`,
`LeaderboardModule`, SyncKit's old `StorageProperty` generics — came back
empty. This Lens was already on `InternetModule` and the unified
`CameraModule`, which is what SPECS 27 wants.

What did change, all of it done by Lens Studio during the upgrade:

- **Packages moved to 2.0.0** — SpectaclesInteractionKit (0.17.2 → 2.0.0, SIK
  runtime 0.18.0), SpectaclesUIKit (0.1.5 → 2.0.0), SurfacePlacement (0.5.0 →
  2.0.0), Spectacles3DHandHints (1.2.0 → 2.0.0); SnapDecorators, Utilities and
  RemoteServiceGateway came across as 2.0.0 with the project upgrade. Our
  imports (`Interactable`, `SIK`, `WorldCameraFinderProvider`, `OneEuroFilter`,
  `NativeLogger`, `Event`) survived the major-version bump unchanged.
- **Shaders converted** — all eleven `.ss_graph` graphs became `.graphShader`,
  the 5.23 format. One-for-one, done by the editor.
- **Packages are archives now**, not unpacked folders, so the project tree is
  much smaller than the 5.15 one for the same content.

## The quantised detector

`Assets/ML/vector_yolo_qnn.dlc` is the same YOLO detector as `best.onnx`,
a quantised export. Both exports have identical shapes —
512×512×3 in, three heads of 64/32/16 × 18 out — so `CoffeeDetector` decodes
either one without knowing which it got.

Their **input normalisation must match too**, and that is easy to miss: the
importer defaults a fresh model to `scale = 1.0`, while this detector was
trained on pixels scaled to 0..1, which is what `best.onnx` carries
(`scale = 0.0039`, i.e. 1/255). A model fed 0..255 does not fail loudly — it
just detects nothing, or detects nonsense. Both assets now carry 0.0039 on all
three channels; if you ever re-import the `.dlc`, check that field first.

They are both shipped because neither covers both places:

- The **.dlc runs on the glasses** (device) and does not load on the editor's CPU
  backend.
- The **.onnx runs everywhere**, including the Preview panel, which is where
  you develop.

`CoffeeMLController` picks between them: on-device it takes `modelQuantized`
when one is wired, and the preview always falls back to `model`. Wiring is
already done in the shipped scene (GameController → `mlModel` = `best`,
`mlModelQuantized` = `vector_yolo_qnn`). Unwire `mlModelQuantized` and you are
back to the float model everywhere; unwire both and the game still plays on
odometry alone.

## Honest status

**This project has not been run on SPECS hardware.** What is verified is the
editor side, in Lens Studio 5.23: the project upgrades, all packages pull to
2.0.0, TypeScript compiles clean, and the Lens boots in the SPECS 27 preview
with no runtime errors — it reaches the hand-calibration screen and arms the
vision pipeline.

What that does not prove: that the quantised model loads and infers on the
actual hardware, that its detections land where the float model's did, or that the
converted shaders look identical on a real display. The 5.15 Lens is the one
with hardware behind it. Treat this as the migrated project, ready for a device
run — not as a tested build.

## Setup

Same as [docs/LENS.md](LENS.md), with two differences: open
`lens-523/robo-hockey-523.esproj` in **Lens Studio 5.23**, and set the Preview
panel device to **SPECS 27**. Experimental APIs still need enabling — the Lens
speaks plain `ws://`, which keeps it a dev lens rather than a store one. The
voice agent and its Remote Service Gateway token work exactly as described
there.
