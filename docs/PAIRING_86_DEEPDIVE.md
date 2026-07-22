# #86 deep-dive — stock robot → local SDK auth (session log 2026-07-21)

Hours of RE getting a factory-firmware Vector (ESN `0dd1dfd4`, name rotates —
now `Vector-X1W8`) to accept a locally-minted SDK guid so the game bridge can
connect. This records exactly what's proven, fixed, and still open, so it's
never re-derived.

## The goal chain (dashboard "sees" the robot)
`archive → SSH key → provision cloud→wire-pod → wire-pod has session-cert →
fetch_cert → mint_guid → robot has vic.AppTokens → SDK connects`.

## PROVEN + FIXED this session
1. **Archive-upload path WORKS** (`/api/provision_oskr_archive`): official Save
   Logs `.tar.bz2` → `extract_key_and_name` detects the key + robot code →
   `find_robot_ip` (ping-sweep + ssh-probe, no mDNS) → SSH provision. Validated
   live end-to-end. **host_mode defaults to `ip`** (repeater eats mDNS →
   escapepod.local won't resolve; pin the Mac IP).
2. **wire-pod session-cert gap (the first #86 wall) — FIXED.** wire-pod serves
   the robot's cert from `chipper/session-certs/<esn>` (webserver.go:617); it's
   only populated during a JDOCS handshake the robot never did → HTTP 404 →
   `fetch_cert` fails. **Fix:** grab the robot's live gateway cert straight off
   its `:443` (`openssl s_client`) and drop it at
   `chipper/session-certs/0dd1dfd4`. Then `fetch_cert`→200 and
   `pairing.pair` runs → robot shows **PAIRED** on the dashboard.
3. **gRPC channel only comes up after a full REBOOT.** Restarting vic-gateway
   leaves `:443` doing TLS (openssl sees the cert) but the gRPC channel never
   becomes ready (`FutureTimeoutError`). A clean reboot fixes it. So: never
   iterate with `systemctl restart vic-gateway` — reboot.
4. **The guid is empty because the robot has no `vic.AppTokens` jdoc.** Its
   jdocs live at `/data/data/com.anki.victor/persistent/jdocs/` (RobotSettings,
   AccountSettings, UserEntitlements…) — **no `vic.AppTokens.json`**. Nothing to
   validate an SDK guid against.
5. **The hardcoded-Anki-hostname redirect (the second #86 wall) — root cause
   FOUND + partially fixed.** The CloudSession / accounts+token flow does NOT
   use the server_config endpoints — it hits **hardcoded** `token.api.anki.com`
   / `accounts.api.anki.com` / `jdocs.api.anki.com` / `chipper.api.anki.com` /
   `session-certs.token.global.anki-services.com`, which still **resolve to a
   dead Anki server `52.152.249.185`**. **Fix applied:** appended those hosts →
   `192.168.0.118` in the robot's `/etc/hosts` (survives reboot). Confirmed
   effective at BOTH glibc (`ping`) AND connmand DNS (`nslookup`) → `.118`.
6. **wire-pod cert lacked the Anki hostnames in SAN — FIXED.** Regenerated
   `certs/cert.crt` (same key, self-signed) with SAN = wirepod.local,
   escapepod.local, all five Anki hostnames, + IPs; restarted `./vectar-onboard`
   so it serves it; re-pushed to the robot's trust `/anki/etc/wirepod-cert.crt`.

## Two auth paths, both tried
- **Network `UserAuthentication` (pairing.mint_guid, no BLE):** returns
  **AUTHORIZED + empty guid** and **never contacts wire-pod's token server** (no
  log). After the hosts-redirect it *hangs* instead of returning empty (so it
  now tries) but still no token request lands. Conclusion: `UserAuthentication`
  is NOT the primary-association trigger.
- **BLE `RtsCloudSession` (session.cloud_auth, `mint_guid_ble.py`):** the real
  primary-association trigger (`client.Auth("2vMhFgktH3Jrbemm2WHkfGN")`, the
  fixed session token wire-pod accepts). Handshake succeeds (robot shows the PIN
  live during the handshake — you can't read it beforehand). **cloud_auth
  returns status 1** ("stock robot validates the session token against Anki's
  cloud, which is gone") — EVEN with the hosts-redirect + cert-SAN fixes, and
  **still without any request reaching wire-pod**. So the CloudSession fails
  *locally inside vic-cloud* before the network call.

## Manual token-injection (no BLE) — got to 401
Replicated wire-pod's `CreateTokenAndHashedToken` in Python (guid=base64(16B),
hash=base64(SHA256(token‖salt)[32B]‖salt[16B]); self-validates), wrote a
`vic.AppTokens.json` in the robot's on-disk jdoc shape (`{client_metadata,
doc_version:1, fmt_version:1, jdoc:{client_tokens:[{hash,client_name,app_id,
issued_at}]}}`), rebooted. Result: gRPC ready, robot **reads the token store and
validates → HTTP 401** (not "no connection"). So the robot DOES read the local
jdoc for guid validation, but rejects our hash. Remaining unknown: exact
fmt_version / whether vic-gateway validates against the local file vs a
vic-cloud in-memory copy the raw file-write didn't populate. The SDK sends the
guid as a Bearer access token (`connection.py:509
access_token_call_credentials`).

## THE remaining wall (both paths converge here)
The robot will not complete the **primary-user association**:
- BLE CloudSession → **status 1, fails locally in vic-cloud** (not DNS — redirect
  proven working; not cert — SAN fixed; no request reaches wire-pod).
- Manual jdoc injection → **401** (hash/format the closed vic-gateway rejects).

## Next moves (fresh-session, not "one more click")
1. **vic-cloud `-verbose`** — the binary takes `-verbose` (`/anki/bin/vic-cloud
   --help`). Run it verbose and trigger one CloudSession to see the EXACT reason
   for status 1 (endpoint it hits, TLS result, precondition). This is the
   decisive diagnostic and it's cheap.
2. Suspect the CloudSession needs a prior established **jdocs** connection to
   wire-pod (the robot never registered → wire-pod botInfo empty). Check whether
   forcing a jdocs sync first unblocks it.
3. Confirm wire-pod actually serves the **accounts** endpoint the session
   validation calls (vs only token/jdocs/chipper).
4. For the injection path: get a REFERENCE `vic.AppTokens` (fmt_version) from a
   properly-onboarded wire-pod robot and match it byte-for-byte.

## BLE handshake reliability (operational)
Handshake is flaky: `FirstFrameTimeout` / `expected Nonce, got 0x11` =
stale/half-open switchboard from a prior failed attempt. **Only a full reboot
clears it** (switchboard restart does NOT). Recipe that works: full reboot →
wait `systemctl is-active vic-switchboard` → launch the BLE script → user does
ONE double-press during the scan → PIN appears live → read it then. The robot
also began power-cycling under the load of many reboots — let it charge.

## Key facts
- ESN `0dd1dfd4`; SSH key `~/.vectar/keys/id_rsa_Vector-X1W8`; robot `.194`.
- Robot :443 gateway cert fingerprint `63:EE:1E:81:DA:C8:E6:45:61:B1:5F:8B:9F:6C:1F:27:ED:60:00:FF` (CN=Vector-X1W8, self-signed, valid to 2125).
- SESSION_TOKEN wire-pod accepts: `2vMhFgktH3Jrbemm2WHkfGN`.
- `session.cloud_auth()` is the guid-mint that the wizard's `api_ble_authorize`
  does NOT call (it drops BLE + does the network mint instead — that's why the
  network path is what everyone hits).

---

# BREAKTHROUGH session-2 (2026-07-21 pm) — the DOCUMENTED method + why the reset broke it

Pavlo: "we set up Vector for wire-pod, built tons on top — why can't we repeat it??"
Answer: it IS documented — `docs/vector-provisioning.md` (Vector project), LIVE-VERIFIED
2026-07-11 against X6X8. I'd been doing it WRONG.

## The real mechanism (vector-provisioning.md, verified)
**"The robot never gets its token WRITTEN; it PULLS `vic.AppTokens` from whatever
`server_config` names, over TLS it already trusts."** So provisioning = BE that server.

My three errors (all now understood):
1. **Provisioned to an IP** (`host_mode=ip` → 192.168.0.118). The robot trusts
   `CN=wirepod.local` and server_config must name **`wirepod.local`** (an mDNS
   NAME) — with an IP the TLS/name check never matches.
2. **Hand-WROTE `vic.AppTokens` to the robot's local file** → the robot doesn't
   validate against a hand-written file; it validates what vic-cloud PULLED.
3. **Chased BLE CloudSession** (status 1) — not the mechanism at all.

## Applied the correct config (all verified working)
- Robot `server_config` → `wirepod.local:443` (jdocs/tms/chipper).
- Robot `/etc/hosts`: `192.168.0.118 wirepod.local` (survives reboot; resolves at
  glibc AND connmand).
- Robot trusts wire-pod cert (`CN=wirepod.local`, pushed to `/anki/etc/wirepod-cert.crt`).
- **Robot→wire-pod TLS VERIFIED**: `openssl s_client` from the robot → `Verify
  return code: 0 (ok)`. (Earlier "TLS fails" was a false alarm — busybox `timeout`
  syntax is `timeout -t N`, so my tests never ran openssl.)
- wire-pod jdocs store = `chipper/jdocs/jdocs.json`, format =
  `[{"thing":"vic:<esn>","name":"vic.AppTokens","jdoc":{doc_version,fmt_version,
  client_metadata,json_doc:"<STRING of {client_tokens:[...]}>"}}]`.

## ⭐ The backup HAS the working auth (data.tar.gz)
`~/vector_factory_backup/2026-07-20/data.tar.gz` (the /data partition, dumped
BEFORE the Clear-User-Data wipe) contains the X6X8-era WORKING files:
- `…/persistent/jdocs/vic.AppTokens.json` — **`"cloud_accessed": true`** (I'd
  written `false` — a real key difference), real `cloud_get_time`, hash =
  `base64(SHA-256(token‖salt)‖salt)`, `client_name:"wirepod"`, `app_id:"SDK"`,
  microsecond+tz `issued_at`.
- `…/persistent/token/token.jwt` (519 B, RS512) — **valid until 2026-08-02** (not
  expired). This is vic-cloud's local session token (the piece I'd missed).
- NOTE: the backup `.anki_vector` guid `YUc3nn3dmV4F+TTZOYrpdA==` does NOT match
  the backup vic.AppTokens hash `lsrj4+YE…` (captured at different moments) — so
  there's no ready reuse-guid pair; must regenerate a guid+hash together.

## The remaining wall (precisely located)
Restored the EXACT backup-format `vic.AppTokens` (cloud_accessed:true) + the
token.jwt + a matching fresh guid, rebooted → **still 401**. The robot kept MY
file (didn't overwrite) yet rejected the guid. Conclusion: **vic-gateway trusts
`vic.AppTokens` only when vic-cloud actually PULLED it** (real cloud round-trip),
not a hand-placed file — even byte-identical in format. And **vic-cloud never
connects to wire-pod to pull** (no `.194→118:443` socket; wire-pod jdocs log
silent) despite correct config + verified TLS. The pull needs a bootstrapped
vic-cloud cloud-session, which the factory reset wiped and which the BLE
CloudSession (status 1) would normally re-establish.

## Next moves (fresh session)
1. **vic-cloud verbose the RIGHT way** — its unit runs via `logwrapper`; appending
   `-verbose` broke it (`logwrapper: invalid option -- v`). Instead run vic-cloud
   by hand: stop the unit, `LD_LIBRARY_PATH=… /anki/bin/vic-cloud -verbose` in an
   SSH shell, watch it try (or not) to reach wirepod.local — that reveals why it
   won't pull.
2. **Consider restoring the FULL X6X8 `/data`** (data.tar.gz) to reinstate
   vic-cloud's pulled/session state, then mint a fresh guid through the now-live
   cloud path. Risk: it also reverts WiFi/SSH state — snapshot current `/data`
   first.
3. The token.jwt signature: wire-pod's `CreateJWT` signs with a fresh random RSA
   key each call → the signature can't be validated against a fixed key, so
   vic-gateway must not check it. Confirm what vic-cloud actually requires of
   token.jwt to consider a cloud-session valid.
