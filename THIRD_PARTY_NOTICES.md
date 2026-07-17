# Third-Party Notices

Everything authored for this project (game code, GlowKit, the server, the
GLB props, the trained YOLO model, SFX/music) is MIT — see [LICENSE](LICENSE).
The following third-party components are included or depended on under their
own terms:

## Bundled in `lens/Packages/` — Snap Inc. / Specs Inc. packages (MIT)

`SpectaclesInteractionKit.lspkg` (SIK 0.17.2), `SpectaclesUIKit.lspkg`,
`SurfacePlacement.lspkg`, `Spectacles3DHandHints.lspkg`,
`RemoteServiceGateway.lspkg`, `SnapDecorators.lspkg`, `Utilities.lspkg`

> Copyright (c) Specs Inc. — MIT License, from the official
> [specs-devs/packages](https://github.com/specs-devs/packages) distribution.
> Use of Snap developer products is additionally subject to the
> [Snap Developer Terms](https://snap.com/en-US/terms/developer) and the Lens
> Studio License Agreement. (SurfacePlacement here carries a small local
> patch: recolored placement visuals.)

## `lens/Assets/Models/vector.obj` + `vector.mtl` — Vector robot mesh

From the official Anki `anki_vector` Python SDK (`opengl/assets`),
© Anki, Inc., Apache License 2.0. Used as the AR occluder/avatar of the
physical robot. Vector® and related marks belong to their respective owner
(Digital Dream Labs); this project is unaffiliated and requires you to own a
real robot.

## Vendored in `server/onboarding/wire-pod/` — wire-pod (MIT)

A trimmed copy of [wire-pod](https://github.com/kercre123/wire-pod) (STT models,
voice, and unrelated backends removed) is bundled so the pairing wizard can
onboard a stock robot without a separate install.

> MIT License — **Copyright (c) 2022 Kerigan Creighton** (`kercre123`).
> Full text at [`server/onboarding/wire-pod/LICENSE`](server/onboarding/wire-pod/LICENSE).

This project is built on and deeply grateful to wire-pod. If you can, star the
upstream project.

## `server` dependency: `wirepod-vector-sdk` (PyPI)

Community-maintained fork of the official `anki_vector` SDK.
© Anki, Inc. + wire-pod contributors — Apache License 2.0.
Installed from PyPI, not vendored.

## `lens/Assets/Fonts/VT323.ttf`

VT323 by Peter Hull — [SIL Open Font License 1.1](https://scripts.sil.org/OFL).

## Other server dependencies (PyPI, not vendored)

`websockets` (BSD-3), `aiohttp` (Apache-2.0), `protobuf` (BSD-3),
`grpcio` (Apache-2.0), `requests` (Apache-2.0), `cryptography`
(Apache-2.0/BSD), `zeroconf` (LGPL-2.1 — used unmodified as a library),
`pytest` (MIT, dev only).
