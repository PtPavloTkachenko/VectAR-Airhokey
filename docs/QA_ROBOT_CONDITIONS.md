# QA — pairing across Vector conditions

> ⚠️ **Historical (2026-07-20). The gap this page describes has since been
> closed** — a bit-stock Vector was taken from the box to SDK control through
> the wizard alone on 2026-07-25, and a factory-reset OSKR unit on 2026-07-26.
> The wizard now repoints a stock robot's cloud by installing the escape-pod
> firmware over Bluetooth, and a dev robot's over SSH; the missing trigger was
> a BLE `RtsCloudSessionRequest`, not a network state. Read
> [SETUP_ROBOT.md](SETUP_ROBOT.md) for what happens today, and
> [PAIRING_86_DEEPDIVE.md](PAIRING_86_DEEPDIVE.md) for how it was solved. This
> page is kept for the condition matrix and the reasoning that got us there —
> **its "to do" items are done.**

What actually happens when you point the wizard at a Vector in each real-world
state. Field-verified 2026-07-20 on ESN `0dd1dfd4`. The headline **at the time**:
our wire-pod pairing needs the robot's cloud pointed at wire-pod, and a
bit-stock robot points at Anki's cloud (ddl.io), so our pairing could not mint a
GUID. Pointing him at wire-pod is now part of the wizard.

## The trust chain (why the condition matters)

Pairing mints an SDK GUID two ways, both ending in the robot validating a
session token against **its own cloud endpoint** (`server_config.json`):

- BLE path — `RtsCloudSessionRequest` during onboarding (`ble/session.py::cloud_auth`).
- gRPC path — `UserAuthentication` to `:443` during the wizard's authorize
  (`web/pairing.py::mint_guid`), answered *through* the robot by its token server.

Either way the **robot's cloud must be a token server we control (wire-pod)**.
A stock robot's cloud is Anki/DDL (`ddl.io`), which only honours a real token
from a logged-in official-app account — our dummy token is rejected.

## Condition matrix

| Robot condition | `server_config` cloud → | Our wire-pod pairing | What you see |
|---|---|---|---|
| **OSKR + wire-pod provisioned** (cert + `server_config→wirepod.local`) | wire-pod | ✅ **works** | cert fetched, GUID minted, ROBOT LINK CONNECTED. This is the "it worked on Jul 17" state. |
| **Bit-stock** (factory reset, never logged in) | `ddl.io` (Anki) | ❌ **blocked** | BLE `cloud auth failed`; or wizard "Credentials"/authorize error; wire-pod `/session-certs/<esn>` = *cert does not exist*. |
| **Stock, logged into official Vector app** | `ddl.io` (Anki) | ⚠️ only via the **real** account token | The official app's own SDK-auth works; our dummy-token path does not. Would need the account's token, not wire-pod. |
| Any of the above, **robot on a different subnet than the Mac** | — | ❌ never reachable | dashboard OFFLINE / "not found via mDNS"; put all devices on one network. |

## Identity facts (verified across a factory reset)

- **ESN / serial is fused and stable** — stayed `0dd1dfd4`.
- **The `Vector-XXXX` name ROTATES on factory reset** — was `Vector-X6X8`, became
  `Vector-B2G5`. Do not treat the name as identity; key off the ESN. The TLS
  **cert rotates too** (self-signed, CN = the new name), which is why a reset
  robot always fails the old cert with `CERTIFICATE_VERIFY_FAILED`.
- The saved `~/.anki_vector/sdk_config.ini` after a reset is triple-stale (name,
  cert, and often ip) — a full re-pair is required, not a tweak.

## Stock support IS designed to work — via escape-pod (correcting an earlier call)

A stock DDL robot does **not** need OSKR to reach wire-pod. DDL production
firmware (2.x, ours = 2.0.1.6091) ships **escape-pod support**: during onboarding
the robot resolves **`escapepod.local`** over mDNS and trusts the well-known
escape-pod CA cert. wire-pod's own onboarding (`chipper/pkg/wirepod/setup/
certs.go`) writes `server_config → escapepod.local:443` and `mdnshandler`
broadcasts `escapepod.local` at the robot. That is the no-OSKR path, and it was
observed working tonight: the wizard reached *"Vector on Wi-Fi ✓ / Credentials
ready"* on this bit-stock robot (BLE `cloud_auth` succeeded).

So the bit-stock row above is **operationally**, not fundamentally, blocked.
Tonight's failures were: wire-pod not reliably running (restarts lose the
in-memory session cert → `/session-certs/<esn>` = *cert does not exist*), the
robot dropping on/off Wi-Fi mid-flow, IP + cert churn right after the reset, and
the gRPC authorize step firing before wire-pod held the cert.

## The real gap to close for reliable stock pairing

The one thing to verify/fix (needs a robot on the network to test):
**does our trimmed `vectar-onboard` actually broadcast `escapepod.local` and hold
the session cert through the whole wizard?** Right now `cert does not exist`
persists, which means the robot→wire-pod jdocs/token handshake isn't landing (or
its result isn't retained). Candidate causes: (a) `vectar-onboard` doesn't post
the escape-pod mDNS the way full wire-pod does (no "Posting mDNS" in its log);
(b) the Python BLE `cloud_auth` mints the guid but never drives the robot to
pull its cert into wire-pod's store; (c) wire-pod restarts drop the cert. Fixing
this is what makes a plain stock Vector pair end-to-end — NOT a new BLE
server_config message (the escape-pod path already handles the repoint).

## To pair a bit-stock robot with our flow — options

1. **Re-provision the cloud to wire-pod** (what OSKR/escapepod does): install
   wire-pod's cert into the robot's trust store and set
   `server_config→wirepod.local`. On OSKR this is an ssh edit; over pure BLE it
   needs a cloud-override message our onboarding does not yet send → **the real
   work item** if we want true stock-robot support.
2. **Use the official account token**: log the robot into the official Vector app
   once, capture that session token, and feed it to `cloud_auth`/`UserAuthentication`
   instead of the dummy. Then Anki's cloud authorizes and the GUID mints.
3. **Keep the robot OSKR + wire-pod provisioned** and never bit-stock it — the
   supported path today. (Tonight's factory reset removed exactly this.)

## Server resilience already in place (2026-07-20)

Independent of the cloud gap, the server no longer *breaks* on these — it
explains itself on the dashboard instead of a bare OFFLINE:

- **IP moved** (DHCP / phone-hotspot hop): failed connect → mDNS re-resolve
  (`_ankivector._tcp.local.`) → rewrites `sdk_config.ini` → retries.
- **Cert rotated / credential rejected**: classified as `cert_rotated`; dashboard
  shows a yellow "re-onboarded — re-run PAIR ROBOT" hint + a RE-PAIR button.
- **Unreachable**: clear "same Wi-Fi as the Mac? robot awake?" hint.
- **Mac IP change**: the LENS WS_URL always reflects the Mac's current IP.
