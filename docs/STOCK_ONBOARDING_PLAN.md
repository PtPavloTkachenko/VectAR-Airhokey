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

## PROVEN 2026-07-21 (second clean test, escapepod.local always-published)

BLE connect → handshake → PIN → **Wi-Fi all succeeded** on a bit-stock robot
(`Vector-X1W8`, on Wi-Fi at 172.20.10.2). The wall is **cloud authorize only**:
`/session-certs/<esn>` stayed empty and **wire-pod logged ZERO robot traffic**
(no `:80` connCheck, no `:443` jdocs/token). So the robot never contacted
wire-pod — it talks to its `server_config` cloud (`ddl.io`) and does **not**
auto-fall-back to `escapepod.local` just because it resolves. Publishing
escapepod.local is necessary but **not sufficient**: the robot must be *directed*
to wire-pod. On pure BLE there is no server_config message to do that (RTS has
only wifi / cloud_session / sdk_proxy / status). → The repoint must happen at the
**DNS layer** (resolve `*.api.ddl.io` → Mac on a network we control) or via OSKR.
A phone hotspot can't override DNS, which is why tonight's test can't finish.

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
