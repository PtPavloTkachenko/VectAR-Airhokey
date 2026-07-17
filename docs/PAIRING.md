# Pairing your Vector

Two stages. Stage 1 is the community-standard one-time robot setup
(wire-pod). Stage 2 is this project's web wizard, which authorizes the game
server with your robot. After both, **wire-pod does not need to run for
games** — control is direct Mac→robot.

## Why wire-pod at all?

Anki (and later DDL) shut their cloud down. A Vector without a server can't
finish onboarding, and — the part we care about — nothing can issue the
**SDK auth token** the game server logs in with.
[wire-pod](https://github.com/kercre123/wire-pod) is the open-source
replacement "cloud" the community runs at home: it onboards the robot,
handles his voice commands, and can mint SDK tokens. Thousands of Vectors run
on it; ours does too.

## Stage 1 — one-time robot onboarding (upstream wire-pod)

Skip this if your Vector already runs on a wire-pod instance.

1. Install & start wire-pod on any machine on your network (the Mac is fine):
   follow the official guide — https://github.com/kercre123/wire-pod/wiki .
2. Put Vector on the charger, **double-press his backpack button**, and open
   wire-pod's web page → it walks you through Bluetooth pairing (a PIN shown
   on Vector's face), Wi-Fi credentials, and — for robots on old firmware —
   an OTA update it serves itself.
3. Done when Vector responds to "Hey Vector".

## Stage 2 — authorize the game server (our web wizard)

With wire-pod still running:

```bash
cd server && source .venv/bin/activate
export PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python
python -m game_bridge.main
```

Open **http://localhost:8780** → **PAIR ROBOT**:

1. **Find robot** — scans mDNS for `_ankivector._tcp`. On repeater-heavy
   networks mDNS often fails; that's normal — enter details manually.
2. **Details** — robot name (`Vector-XXXX`, on his screen after a backpack
   double-press on the charger), serial (sticker on his underside, e.g.
   `00e20145`), robot IP (double-press backpack, then raise+lower his arms —
   the IP shows on his face), and your wire-pod address (default
   `escapepod.local:8080`; use the host machine's IP if `.local` doesn't
   resolve).
3. **Pair** — the wizard then:
   - downloads the robot's TLS certificate from wire-pod
     (`/session-certs/<serial>`),
   - opens a pinned TLS channel to the **robot** on port 443 and calls
     `UserAuthentication` — the robot forwards it to its trusted server
     (your wire-pod), which mints a fresh **guid** token,
   - writes `~/.anki_vector/sdk_config.ini` + the cert file — the standard
     `anki_vector` SDK location, so any other SDK tool you own works too.
4. **Test** — a short connection check (battery/firmware readout), then
   CONNECT to hand the robot to the game loop.

Token minting is **append-only** on the robot: re-pairing (new Mac, new IP,
re-install) never invalidates previously issued tokens.

### After pairing

You can stop wire-pod. Gameplay authenticates directly against the robot
(vic-gateway checks the guid locally). Keep wire-pod around for voice
commands and future re-pairings.

## Failure messages decoded

| Wizard error at… | Likely cause |
|---|---|
| *certificate* — can't reach wire-pod | wire-pod not running / wrong address; try `<host-ip>:8080` instead of `escapepod.local` |
| *certificate* — no cert for serial | typo in serial, or the robot was onboarded by a DIFFERENT wire-pod instance |
| *certificate* — name mismatch | name/serial belong to different robots |
| *secure channel* — 15 s timeout | robot off / asleep off-charger, wrong IP (DHCP moved him — recheck on his face), different network |
| *secure channel* — TLS failure after re-onboarding | cert rotated: re-run the wizard from step 1 |
| *mint* — refused / not authorized | robot can't reach ITS wire-pod right now, or trusts a different one — restart wire-pod and retry |

## CLI alternative

The SDK's own interactive tool does the same thing in a terminal:

```bash
python -m anki_vector.configure
```

Our wizard exists so you don't have to babysit prompts — and it doubles as a
live dashboard (robot link, battery, field pose, lens connection, game state)
during play.
