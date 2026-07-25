# Dev note — setting up an OSKR (dev) robot

An OSKR robot is the easy case, not the hard one. He runs `ankidev` firmware,
so he needs no firmware install at all: we write two files over SSH and he
points at the pairing engine. The whole thing is one command, and the wizard
runs the same code.

```
python -m onboarding.oskr_provision --ip <robot-ip> --key ~/.vectar/id_rsa_robot
```

## The one thing you need: his SSH key

That's what makes a unit OSKR — the owner has a key. It comes from the robot's
own log archive: he generates a keypair in `/data/ssh` and ships the private
half inside his logs. Three ways to get it, best first:

| Route | Cost | Notes |
|---|---|---|
| Paste the key you already have | seconds | An OSKR owner has one |
| Official log archive | a minute | Vector's setup web app → Save Logs → drop the `.tar.bz2` into the wizard |
| Our BLE log download | slow, flaky | Kept as a fallback; long transfers stall |

A Clear User Data wipe does not lock you out — it just regenerates the pair, so
pull a fresh archive and you have the new key. The robot's name changes at the
same time, which is why an older key stops working: it belongs to the old name.

## What provisioning writes

| On the robot | Why |
|---|---|
| `/anki/data/.../config/server_config.json` | jdocs / tms / chipper / check → the pairing engine |
| `/anki/etc/wirepod-cert.crt` | the CA he must trust to accept the engine's TLS |
| `/etc/hosts` | any pinned entry for our names is REMOVED |

The rootfs is read-only, so this opens one rw window for both writes and closes
it again. The original `server_config.json` is kept as `.bak`, so it is
reversible. Then he reboots — never a live service restart, which races
vic-engine.

## The two identities, and why they must match

wire-pod serves one of two identities on `:443`, decided by the mode it runs in:

| Engine mode | Name | Certificate |
|---|---|---|
| escape-pod (`server.epconfig: true`) | `escapepod.local` | Digital Dream Labs, `CN=escapepod.local` |
| plain | this Mac's IP | wire-pod's self-signed, `CN=wirepod.local` |

A stock robot can only ever use the first, so that is the mode we run — and a
dev robot must then be handed the DDL certificate too, or he refuses the TLS
and his cloud handshake never completes. `--host-mode auto` reads what the
engine is actually serving and picks both together. One engine, both robots.

Prefer the escape-pod name over pinning an IP. mDNS re-answers with the current
address; a pin rots the day the Mac takes a new DHCP lease, and it fails
silently, because `/etc/hosts` is consulted before mDNS so resolution still
"succeeds". This cost us weeks on the dev unit.

## After provisioning: the mint

Repointing only tells the robot where his cloud is. He still never contacts it
on his own — the trigger is a BLE `RtsCloudSessionRequest`, the same message
the stock path needs (see `mint_guid_ble.py`). Once he has handshaked, wire-pod
holds a session certificate for his serial and pairing mints the SDK guid.

If wire-pod already holds a certificate for that serial from an earlier setup,
the BLE step can be skipped and pairing goes straight through — which is what
`oskr_setup` tries first.

**He answers the network authentication call with an empty guid.** The call
itself succeeds, so this is easy to mistake for a completed pairing; every
later connection then fails with a bare 401. The engine minted a real guid and
its hash is already in his token store, so pairing reads it back from the
engine (`/api-sdk/get_sdk_info`) rather than trusting the robot's empty answer.

A successful run ends by connecting, so it says what it proved:

```
paired Vector-XXXX (0dd1dfd4) at 192.168.0.194
SDK control confirmed: firmware 2.0.1.6091oskr#f61178e, battery 4.12 V
```

## Signing your own OTA: no Anki key required

Not needed to get a robot working — everything above is enough — but worth
recording, because we spent a long time believing this was blocked.

`/anki/bin/update-engine` is a readable Python script on the robot, and it
accepts **user-supplied signing keys**:

```python
pub_key_paths = [OTA_PUB_KEY]                     # /anki/etc/ota.pub
if os.path.isdir("/data/etc/ota_keys"):
    for user_key in glob.glob("/data/etc/ota_keys/*.pub"):
        pub_key_paths.append(user_key)
```

So the hunt for a private `ota_prod.key` was chasing the wrong thing. Generate
a keypair, drop the public half into `/data/etc/ota_keys/` (one SSH write),
sign your `manifest.ini` with the private half, and the robot installs the
image. Boot and recovery partitions stay off limits to user keys (die 217);
ordinary system updates do not.

The rest of what the script settles:

| Rule | Detail |
|---|---|
| Build type | `ankidev` OS installs only `ankidev` images, and vice versa (die 214) — symmetric, and about the manifest field, not the version string |
| Version suffixes | the accepted set is `d`, `ud`, `oskr`, `ep`, `epdev` — which is why classification keys off `oskr`, not `ankidev` |
| Encryption | fixed passphrase file `/anki/etc/ota.pas`; images are `aes-256-ctr` |
| Downgrade | allowed on a dev robot via `UPDATE_ENGINE_ALLOW_DOWNGRADE` |

## When he will not mint: fault 923

Seen live, and it feeds itself:

1. a queued report in `/data/fault-reports/` gets picked up for upload;
2. the log collector asks vic-cloud for STS credentials;
3. vic-cloud cannot resolve its token server for a moment — at boot the name
   is not answerable until avahi is up;
4. the failed lookup returns nil, vic-cloud dereferences it and dies
   (`internal/token/sts.go:71`, SIGSEGV);
5. the robot raises fault 923 and queues another report.

With vic-cloud dead the gateway still accepts TCP and still answers
unauthenticated calls, but never answers an authentication call — so minting
hangs rather than failing, which is what made this so hard to see. Setup now
pins the name in `/etc/hosts` so the lookup cannot fail at boot, masks the two
uploaders (they ship to an Anki bucket that has been gone for years), clears
the queue, and pairing carries a deadline so a dead cloud reports itself.
