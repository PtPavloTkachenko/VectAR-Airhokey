# The Game Server (`server/`)

Headless-capable Python 3.12 asyncio app: WebSocket `:8777` for the lens,
gRPC to the robot, web console `:8780` for humans.

## Install

```bash
cd server
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Two environment facts the SDK needs:

- `PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python` — **required** every run
  (the C++ protobuf backend chokes on the SDK's old generated code).
- Python **3.12** specifically — `wirepod-vector-sdk` is the community
  `anki_vector` fork patched for it.

## Run

```bash
export PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python
python -m game_bridge.main                 # normal: robot + lens + web UI
python -m game_bridge.main --no-robot      # lens development, no robot
python -m game_bridge.main --mock-pose     # simulated goalie (lens dev)
python -m game_bridge.main --no-web        # headless (no :8780 console)
python -m game_bridge.main --log-level DEBUG
```

If no robot is paired yet the server does NOT exit — it serves the web
console so you can pair, then press CONNECT (see
[PAIRING.md](PAIRING.md)).

## Configuration

Everything lives in `game_bridge/config.py` with env-var overrides — see
`.env.example` for the useful ones. Robot identity (serial/IP/name +
credentials) comes from `~/.anki_vector/sdk_config.ini`, written by the
pairing wizard.

### Goalie tuning knobs

| Env | Default | Meaning |
|---|---|---|
| `GOALIE_KP` | 3.8 | mm/s of wheel speed per mm of intercept error — the aggression dial |
| `GOALIE_MAX_WHEEL` | 218 | wheel speed cap (SDK max 220) |
| `GOALIE_DEADBAND` | 8 | mm of error ignored (kills idle jitter) |
| `GOALIE_SHOWMAN` | 1 | 1 = side-strafe patrol (recommended; turns are choreography-only), 0 = plain heading-servo controller |
| `GOALIE_KW_TURN` | 1.6 | wheel mm/s per deg during choreography turns |
| `GOALIE_HEAD_TRACKING` | 1 | head follows the puck |
| `ALPHA_VISION` | 0.14 | vision-fix blend strength (0 = ignore vision) |

Design note: the controller deliberately avoids mid-game turns — in-place
spins slip the treads and corrupt odometry (the robot walks off the field
while his coordinates look perfect). Fore/aft strafing keeps odometry honest;
YOLO vision fixes (from the lens) absorb what's left.

## Web console (`:8780`)

![Dashboard](images/dashboard.png)

- **Dashboard** — robot link/battery/field pose, lens connection, game state,
  1 Hz refresh. Also shows the exact `ws://<mac-ip>:8777` string to paste into
  the lens' `GameConfig.WS_URL`, plus a **screen game** you can play with the
  mouse when no Spectacles are connected (leave "drive the real Vector"
  unchecked for a pure on-screen match).
- **Your robots** — the fleet, when this Mac has been set up with more than
  one Vector (see below).
- **Pair robot** — the wizard ([PAIRING.md](PAIRING.md)).
- JSON API: `GET /api/status`, `GET /api/robots`, `POST /api/robots/select`,
  `POST /api/robots/forget`, `POST /api/discover`, `POST /api/pair`,
  `POST /api/test`, `POST /api/connect` — all trivial to script against.

## More than one robot

Run the wizard again and the second Vector joins the first — credentials live
side by side in `~/.anki_vector/sdk_config.ini`, one section per robot, and
setting one up never disturbs another.

The **Your robots** card on the dashboard is where you say which of them
plays. The checked robot is the one the goalie logic drives and the one the
Lens plays against; switching is a click, and it hands the previous robot back
to himself first (Vector grants behavior control to a single client, so a
robot nobody releases just stands there). A robot that is already set up is
never sent through onboarding again to be used — switching is bookkeeping plus
a connect.

**The Lens never picks a robot.** It takes whoever the server hands it, which
is what keeps it a display-and-input bridge with no decisions of its own — the
same reason it holds no game state. Air-hockey has exactly one goalie, so the
checkbox behaves as a switch; when a two-robot experience arrives, the same
checkbox marks several and the Lens protocol starts carrying a robot id.

**✕ forgets a robot** — it drops his certificate and control token *from this
Mac*. The robot himself is untouched and still points at the pairing engine,
so adding him back is the wizard's Authorize step, not the whole setup again.

Which robot is "first" in the ini is the whole mechanism: everything that asks
"which robot?" without naming one resolves to the first section. Selecting a
robot moves him there.

## Tests & robot-only testing

```bash
python -m pytest tests -q                  # 77 unit tests, no hardware needed
python sdk_smoke.py                        # careful live check: connect, say, small moves
python -m game_bridge.sim.fake_puck --volleys 6 --speed 200   # scripted volleys, no lens
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `VectorNotFoundException` on connect | Robot IP changed (DHCP). Re-run pairing (updates the ini), or set `VECTOR_IP=<new>,<old>`. We intentionally never pass `name=` to the SDK — its mDNS resolution is unreliable. |
| Connect OK but "Behavior control FAILED" | Another SDK client is attached (only one allowed). Stop it; the server retries 3×. |
| Robot freezes mid-rally, resumes after a beat | Wi-Fi blip — the deadman froze him (correct behavior: never drive on stale pose). If frequent: your robot's spot has weak signal; move the AP/repeater closer. −65 dBm at the table is the comfort line. |
| `delocalized reason=escaped` | Odometry drifted him out of the arena (usually after physical interference). Pick him up, re-place on the pad, press START. |
| Robot drives while being picked up | It shouldn't — cliff/held freeze is instant. If you ever see it: power-cycle; then file an issue with logs. |
| Sounds/anims but no motion | He's on the charger — animations play but he must be OFF the dock to drive. The game flow starts him off-dock anyway. |
| Lens can't connect to `:8777` | Mac firewall prompt not accepted, or wrong `WS_URL` IP in the lens, or glasses on a different network/subnet. |

### The one hard-learned rule

`set_wheel_motors` **persists on the robot** until overwritten. Anything you
build on top of this server must preserve the deadman logic (stop-spam on
stale telemetry, stop-first on reconnect) — a half-open TCP connection
mid-drive otherwise means a robot driving off the table. Supervise physically
during development.
