# Operations — run & control everything

The one page to operate VectAR Air-Hockey after you clone the repo: bring the
server up, pair a **stock** Vector, and fix it when the robot link goes down.
For the deeper pairing internals see [PAIRING.md](PAIRING.md); for the wire
protocol see [PROTOCOL.md](PROTOCOL.md).

```
Spectacles lens ──ws://<mac>:8777──▶ Mac game server ──gRPC :443──▶ Vector
(puck/score/AR field)                (goalie AI, web console :8780)   (drives/saves)
                                        └─ wire-pod :8080 (pairing only)
```

## 0 · Prerequisites (once)

- **macOS**, Python **3.12**, Go **1.2x** (only to build wire-pod once).
- Mac + Vector + Spectacles **on the same Wi-Fi / subnet** (a phone hotspot is
  fine — just put all three on it; see *Networking* below).
- Build the pairing server (no vosk, no sudo):
  ```bash
  cd server/onboarding/wire-pod/chipper
  CGO_ENABLED=1 go build -tags inbuiltble -o vectar-onboard ./cmd/vectar-onboard
  ```

## 1 · Start the game server

```bash
cd server
python3.12 -m venv .venv && source .venv/bin/activate   # first time
pip install -r requirements.txt                          # first time
export PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python
python -m game_bridge.main
```
Open **http://localhost:8780** — DASHBOARD (status) + PAIR ROBOT (wizard).
The server runs fine with no robot: it stays up and waits for pairing.

## 2 · Start wire-pod (needed ONLY while pairing)

```bash
cd server/onboarding/wire-pod/chipper && ./vectar-onboard
```
Serves cert-gen + `/session-certs` + jdocs + token on `:8080` / `:443` / `:80`.
Leave it running through the whole pairing; gameplay afterwards does not need it.

**For a stock robot it must run in escape-pod mode** (`apiConfig.json` →
`server.epconfig: true`, port 443). Only then does it answer to
`escapepod.local` with the certificate the escape-pod firmware trusts — the
one address such a robot ever calls. Check in one line:

```bash
curl -s localhost:8780/api/wirepod_status     # -> "ready": true
```

The wizard shows the same state and refuses to flash firmware without it. See
[STOCK_ONBOARDING_PLAN.md](STOCK_ONBOARDING_PLAN.md) for how to flip the mode
(and why wire-pod's own `use_ep` endpoint panics instead of doing it).

## 3 · Pair a stock Vector (the wizard)

1. Dashboard → **PAIR ROBOT → CONNECT VECTOR**.
2. Vector **on the charger** → **double-press** the backpack button (BLE advert).
   Window is short — if not caught, double-press again (the scanner loops).
3. The wizard, over Bluetooth: finds him → joins him to your Wi-Fi → authorizes
   the Mac. A **PIN** appears on his face at the *Nonce* step — the wizard asks
   for it. It writes `~/.anki_vector/sdk_config.ini` (serial, ip, cert, guid).
4. Back on DASHBOARD, **ROBOT LINK** flips to CONNECTED.

Pairing keys off the **serial (ESN)** and the **certificate CommonName**, not
the name shown on the robot's face. The serial (ESN) is fused and never changes.
The displayed `Vector-XXXX` name and the TLS **cert both rotate on a factory
reset** — so a re-onboarded robot always needs the wizard run again, and the
wizard takes the current name from the fresh cert's CN (don't rely on a
previously saved name). If the on-screen name differs from what's in
`sdk_config.ini`, that's expected after a reset — re-pair to refresh it.

## 3.5 · When something is off: ask the doctor

One pass over the whole chain — pairing engine, escape-pod mode, firmware
image, credentials, the robot himself, the sockets — with the fix printed
under anything red:

```bash
cd server && python -m game_bridge.doctor     # exit code 1 if anything failed
```

The dashboard has the same thing behind **RUN DIAGNOSTICS**, and it is also
served as JSON at `/api/doctor`. Reach for it before reading logs; it answers
in one line the questions that otherwise cost a round of manual probing
("is wire-pod in escape-pod mode?", "does he answer at all?", "is the
certificate still his?").

Note the robot-reachability check probes **three times**: Vector's Wi-Fi radio
power-saves, and the first packet after an idle spell is spent waking it. A
single-shot probe reports a wide-awake robot as missing.

## 3.6 · Developing on it

```bash
python -m game_bridge.main --reload
```

The server watches its own sources (and the console page) and restarts itself
on any change; the page notices the new build and reloads. The robot link
comes back on its own afterwards, so an edit costs about a second.

## 3.7 · Let the Lens find the Mac by name

The server publishes itself over mDNS as **`vectar.local`**, so a Lens can be
built once with

```ts
WS_URL: "ws://vectar.local:8777",
```

and keep working after the Mac's address changes, on any network. That beats
an IP, which goes stale the moment DHCP moves you and then fails silently —
the glasses simply never connect and nothing says why.

Rename it with `VECTAR_MDNS_NAME=whatever`. If your headset turns out not to
resolve `.local` names, fall back to the Mac's IP and give the Mac a DHCP
reservation in your router so it stops moving.

## 4 · Networking (the #1 gotcha)

The Mac reaches the robot by **IP on the same subnet**. If the robot joins one
network (e.g. a phone hotspot `172.20.10.x`) and the Mac is on another
(`192.168.0.x`), the dashboard shows OFFLINE no matter what. Put **all three
devices on one network**. The dashboard's *LENS WS_URL* always reflects the
Mac's current IP — paste that exact string into the lens' `GameConfig.WS_URL`.

The server self-heals a **changed robot IP** (DHCP lease / hotspot hop): on a
failed connect it re-resolves the robot via mDNS (`_ankivector._tcp.local.`)
and rewrites `sdk_config.ini`. You do **not** hand-edit the IP.

## 5 · Troubleshooting — symptom → cause → fix

| Dashboard / log | Cause | Fix |
|---|---|---|
| ROBOT LINK **OFFLINE**, hint *"rejected the saved credential — re-onboarded"* | Robot was factory-reset → **TLS cert rotated**; saved cert is stale | Click **RE-PAIR ROBOT** (wire-pod must be up). The wizard refreshes cert+guid. |
| Hint *"not found at <ip> and not on the LAN via mDNS"* | Robot off, asleep, or on a **different network** than the Mac | Same Wi-Fi as the Mac; robot on charger & awake; then CONNECT ROBOT. |
| Log spams `CERTIFICATE_VERIFY_FAILED: self signed certificate` | Same as cert-rotated above (grpc C-core log line) | Re-pair. The dashboard already classifies this as cert_rotated. |
| Wizard step 3 *"Wi-Fi connect failed (result 255)"* | Wrong Wi-Fi password, or a flaky/hidden network | Retype the password; prefer a normal 2.4/5GHz SSID or a phone hotspot. |
| Wizard *"Authorize"* errors on credentials | **wire-pod not running** (fetch cert / mint guid need it) | Start `vectar-onboard` (step 2), retry authorize. |
| Wizard *"wire-pod has no certificate for serial"* | This wire-pod didn't onboard the robot | Do the full wizard (BLE join repoints the robot's cloud at this wire-pod). |
| `Behavior control FAILED — another SDK client?` | A second SDK client (another server, `anki_vector` shell) holds the robot | Vector allows one client — stop the other, restart the server. |
| Robot drives then freezes mid-rally | Pose went stale (Wi-Fi drop) — deadman stopped it (by design) | Restore Wi-Fi; the link + rally resume. Do not disable the deadman. |

## 6 · Files & ports

- `~/.anki_vector/sdk_config.ini` — robot identity (serial/ip/cert/guid). The
  wizard and the auto-IP healer own it; safe to delete to force a clean re-pair.
- Ports: **8777** lens WS · **8780** web console · **8080/443/80** wire-pod (pairing).
- Logs: game server stdout; wire-pod stdout. `--no-robot` runs the WS/console
  with a simulated goalie for lens-only work.
