# Stock-Vector onboarding (no OSKR) — mechanism + state

Goal: a **plain, factory-stock** Vector (cloud → `ddl.io`, never logged into the
official app) pairs end-to-end through our wizard.

## How stock onboarding works (mechanism)

DDL production firmware 2.x has **escape-pod support**:

1. wire-pod broadcasts **`escapepod.local` → the Mac's IP** over mDNS.
2. wire-pod serves the well-known **escape-pod certificate** the firmware
   already trusts (`CN=escapepod.local`, valid to 2220) on **:443**, and a
   `server_config` pointing jdocs/token/chipper at `escapepod.local:443`
   (`chipper/pkg/wirepod/setup/certs.go`).
3. The robot resolves `escapepod.local`, trusts that cert, and does its
   jdocs/token handshake **against wire-pod** — no OSKR, no `ddl.io`. wire-pod
   then holds the robot's session cert, and `UserAuthentication` mints the SDK
   guid locally.

A stock robot can't be *told* to do this over BLE — the repoint comes from the
firmware itself, so the robot must first be flashed with the **escape-pod
(`ep`) image**. That flash is the one-time provisioning step:

- **Stock (non-dev)** → put in **recovery** (on the charger, hold the backpack
  button ~15 s → face shows `anki.com/v`), then flash
  `vicos-2.0.1.6076ep.ota` over BLE (`RtsOtaUpdateRequest`).
- **Dev / OSKR** (`ankidev`) → **SSH path** instead: write `server_config` +
  cert to `/data/data/`. No flash — and the ep image would be *rejected*
  anyway (`update-engine` die 214: an ankidev OS can't install a non-ankidev
  OTA, and recovery does not relax that).

After provisioning it is **network-agnostic**: `escapepod.local` resolves via
mDNS on any LAN the Mac is on. No DNS override is needed.

### Step order matters: Wi-Fi BEFORE the flash

The robot downloads the 180 MB image **himself, over Wi-Fi**, from
`http://<mac>:8780/api/get_ota/…`. So the wizard runs
**pair → PIN → Wi-Fi → provisioning**, and a robot with no network cannot be
flashed at all. Upstream wire-pod orders it the same way (its `whatToDo()` —
and therefore `doOTA()` — is called from the Wi-Fi success callback).

Entering recovery reboots the robot, which drops both BLE and Wi-Fi, so the
recovery run is a full second pass: pair again → PIN → Wi-Fi again → flash.

## ⚠️ THE prerequisite everyone misses: wire-pod must run in ESCAPE-POD MODE

`chipper/apiConfig.json` → `server.epconfig`:

| `epconfig` | :443 serves | mDNS `escapepod.local` | works for |
|---|---|---|---|
| `true` | `epod/ep.crt` — **CN=escapepod.local** | **broadcast** | **stock robot after the ep flash** |
| `false` | `../certs/cert.crt` — self-signed, IP-only | never broadcast | OSKR robot pointed at the Mac's IP over SSH |

With `epconfig:false` the stock path **cannot work**: the flashed robot looks
for a name nobody publishes, and pairing dies much later at the misleading
`/session-certs/<esn>` → *cert does not exist*. (Found 2026-07-25 — the config
was left in OSKR mode from the previous robot.)

Flip it and **restart the binary**:

```bash
# in server/onboarding/wire-pod/chipper
python3 - <<'PY'
import json; p='apiConfig.json'; d=json.load(open(p))
d['server']['epconfig']=True; d['server']['port']='443'
json.dump(d, open(p,'w'))
PY
./vectar-onboard
```

⚠️ Do **not** use wire-pod's own `POST /api-chipper/use_ep` on a running
non-EP instance: its `RestartServer()` → `StopServer()` closes `serverTwo`,
which is `nil` outside EP mode → nil-pointer panic that takes :443 down (the
config on disk is still written correctly, so just restart the process).

Verify (all three must hold):

```bash
ping -c1 escapepod.local                     # -> the Mac's LAN IP
echo | openssl s_client -connect escapepod.local:443 2>/dev/null \
  | openssl x509 -noout -subject               # -> CN=escapepod.local
curl -s localhost:8780/api/wirepod_status      # -> "ready": true
```

The server does this check for you — see below.

## What the code does now (all built)

- `onboarding/ble/` — RTS v5 over bleak: scan → connect → PIN handshake →
  encrypted channel → status/wifi-scan/wifi-connect/cloud-auth, plus
  `classify_robot()` (stock / dev / ep / recovery) and `ota_flash()` with
  progress + the die-214 explanation.
- `web/server.py` — `/api/ble/state`, `/api/ble/flash_ep` (+ `/flash_status`),
  `/api/get_ota/{name}` (serves `~/.vectar/ota/` if cached, else streams from
  the Internet Archive), `/api/ble/provision_oskr`, `/api/wirepod_status`.
- **Readiness gate**: `/api/ble/flash_ep` refuses to start unless
  `wirepod_status()` reports escape-pod mode live (probed: name resolves +
  :443 presents `CN=escapepod.local`), so a 180 MB install can't strand the
  robot. Override with `{"force": true}`.
- **Cert polling**: `authorize` polls `/session-certs/<esn>` for 60 s
  (`cert_wait`) instead of failing on the first miss — the robot's handshake
  trails the Wi-Fi step, and failing fast was the classic dead end.
- The wizard shows the pairing-engine state on the provisioning step.

Keep the OTA cached at `~/.vectar/ota/vicos-2.0.1.6076ep.ota` (179,763,200 B):
the robot then pulls it from the Mac over LAN instead of the Internet Archive.

## Proven, twice

Run 1 (2026-07-25, a brand-new stock unit) and run 2 (the same robot after
**Clear User Data**, i.e. from zero again) both went the whole way:
pair → PIN → Wi-Fi → escape-pod flash → reboot → pair → Wi-Fi → cloud sign-in
→ onboarding complete → token mint → control acquired.

Two things worth knowing from those runs:

- **The robot's name and TLS certificate rotate on every wipe** (the same ESN came back under a different `Vector-XXXX` name), which is why pairing keys off the ESN
  and reads the name back from the certificate.
- **A clean run needs no extra robot reboot.** The stall that made one
  necessary in run 1 came from minting tokens repeatedly at a robot that had
  never been asked to sign in — the missing `cloud_auth`. With that step in
  place, control was acquired on the first attempt.
