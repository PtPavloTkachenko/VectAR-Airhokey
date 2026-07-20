# Plan — reliable stock-Vector onboarding (no OSKR)

Goal: a **plain, factory-stock** Vector (cloud → `ddl.io`, never logged into the
official app) pairs end-to-end through our wizard. Field state 2026-07-20: it
*partially* works (wizard reached "Credentials ready" on a bit-stock robot), but
is timing-fragile and often ends at `/session-certs/<esn>` = *cert does not
exist*. This is operational, not a protocol wall.

## How stock onboarding is supposed to work (mechanism)

DDL production firmware 2.x (ours = 2.0.1.6091) has **escape-pod support**:
1. wire-pod broadcasts **`escapepod.local` → Mac IP** over mDNS.
2. wire-pod serves the well-known **escape-pod CA cert** the firmware already
   trusts, and a `server_config` pointing token/jdocs/chipper at
   `escapepod.local:443` (`chipper/pkg/wirepod/setup/certs.go`).
3. During onboarding the robot resolves `escapepod.local`, trusts wire-pod's
   cert, and does its jdocs/token handshake **against wire-pod** — no OSKR, no
   `ddl.io`. wire-pod then holds the robot's session cert, and `cloud_auth` /
   `UserAuthentication` mint the SDK guid locally.

No new BLE "set-server-config" message is needed — escape-pod IS the repoint.

## CORRECTED root cause (2026-07-21) — the missing PROVISIONING step

Earlier this doc guessed "DNS interception or OSKR". **Wrong — retracted.**
Reading upstream wire-pod (`chipper/pkg/wirepod/setup/ble.go`, `ssh.go`,
`certs.go`) shows how it actually points a robot's cloud at wire-pod, and it is a
**one-time provisioning step our onboarding skips entirely**:

- **Stock (non-dev) robot** → put it in **recovery** (hold backpack ~15 s →
  `anki.com/v`), then wire-pod **flashes the escape-pod firmware over BLE**:
  `BleClient.OTAStart(".../api/get_ota/vicos-2.0.1.6076ep.ota")` (ble.go:343).
  The `ep` firmware has `server_config` baked to `escapepod.local:443` and trusts
  wire-pod's cert.
- **Dev / OSKR robot** (`ankidev`, = our unit `in_firmware_dev`) → wire-pod uses
  the **SSH path** (`ssh.go`): SCP `server_config → escapepod.local` +
  `wirepod-cert.crt` to `/data/data/`, run `pod-bot-install.sh`. No EP flash.
- `RobotStatus()` (ble.go:203) branches on exactly this: `in_recovery_prod` /
  `in_firmware_nonep` (stock) vs `in_recovery_dev` / `in_firmware_dev` (OSKR).

Our Python `ble/session.py` does status → wifi → `cloud_auth` and **neither**
provisioning step, so `server_config` stays `ddl.io`, the robot never contacts
wire-pod (`/session-certs/<esn>` empty; wire-pod logged ZERO robot traffic in the
2026-07-21 test on `Vector-X1W8`), and authorize hangs at "No credentials yet".

**After provisioning it is network-agnostic** — `escapepod.local` resolves via
mDNS on any LAN the Mac/wire-pod is on (already required for gameplay). **No DNS
override needed.** That earlier claim was the mistake.

## What to add to our onboarding (the real fix)

1. **Detect robot state** over BLE (`GetStatus` → firmware string): stock vs
   OSKR/dev, in-recovery vs in-firmware, already-`ep`.
2. **Stock path**: guide the user to recovery mode, then implement `OTAStart`
   over BLE pointing at wire-pod's `get_ota/…ep.ota` and poll OTA progress
   (mirror ble.go:340-377). One-time; then normal wifi+cloud_auth pairs.
3. **OSKR path** (our unit): SSH `server_config`+cert install (mirror ssh.go) —
   simpler, no flash. Our unit lost its SSH key to Clear User Data; re-add via
   the OSKR setup to use this path.
4. Serve `get_ota/vicos-2.0.1.6076ep.ota` from `vectar-onboard` (confirm the
   route exists in the trimmed build; add if missing).

## Why it's fragile tonight (root causes)

1. **mDNS is conditional.** `mdnshandler.PostmDNSWhenNewVector()` browses
   `_ankivector._tcp` and only starts broadcasting `escapepod.local` once it
   *sees* a Vector. When the robot drops off Wi-Fi (bit-stock robots bounce
   through onboarding), broadcasting stops and the window closes. Verified:
   with the robot offline, `escapepod.local` does not resolve.
2. **wire-pod wasn't reliably up.** The game server never guards it; restarts
   drop the in-memory session cert → `cert does not exist`.
3. **Ordering.** The wizard's gRPC authorize can fire before wire-pod holds the
   cert (robot handshake not yet landed).
4. **Post-reset churn.** Right after a factory reset the robot rotates name +
   cert and hops IPs, so any saved identity is stale for the first attempts.

## Work items (in priority order)

1. **Guarantee wire-pod is up + broadcasting before pairing.** The game server
   should start/adopt `vectar-onboard` and confirm `escapepod.local` resolves
   before the wizard's cloud steps; surface "wire-pod not ready" explicitly.
2. **Force escape-pod mDNS unconditionally during a pairing session** (don't
   wait for `PostmDNSWhenNewVector`) so the record is live the moment the robot
   handshakes. Small change in the vendored `initwirepod` / a pairing-scoped
   `PostmDNSNow()` call.
3. **Gate the wizard's authorize on `/session-certs/<esn>` returning a real
   PEM** (poll until the robot's handshake lands, with a clear timeout message)
   instead of failing fast on the first miss.
4. **Persist wire-pod's session certs to disk** so a wire-pod restart mid-flow
   doesn't lose the cert.
5. **Re-test the full path** on a stock robot kept in a re-flashable state.

## The blocker to finishing this

It needs a **stock Vector on the network to iterate against** — and the only
unit (ESN `0dd1dfd4`) was factory-reset **to sell**. Decide before it ships:
keep it (or another Vector) as a test target, or this stays "designed + partially
proven" until a robot is available. Everything above is code we can write now;
only step 5 (verification) needs the hardware.
