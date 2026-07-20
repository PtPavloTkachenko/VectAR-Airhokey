# QA — pairing across Vector conditions

What actually happens when you point the wizard at a Vector in each real-world
state. Field-verified 2026-07-20 on ESN `0dd1dfd4`. The headline: **our wire-pod
pairing needs the robot's cloud pointed at wire-pod. A bit-stock robot points at
Anki's cloud (ddl.io) and our pairing cannot mint a GUID.**

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

## The gap (what our BLE onboarding does NOT do)

`ble/session.py` does: handshake → wifi_scan → wifi_connect → wifi_ip →
`cloud_auth`. It **never repoints the robot's cloud to wire-pod** (no
`server_config` / cloud-override push, no wire-pod trust-cert install). So on a
bit-stock robot the robot still trusts `ddl.io`, `cloud_auth` is validated there,
and it fails. On the Jul-17 robot this step was unnecessary because the robot was
*already* wire-pod-provisioned (OSKR ssh had written `server_config`).

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
