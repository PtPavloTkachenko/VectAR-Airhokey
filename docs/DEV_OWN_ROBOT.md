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
the BLE step can be skipped and pairing goes straight through.

## Not needed for any of this: signing an OTA

There is a separate, unfinished ambition — building a custom OSKR OS and
installing it over BLE `OTAStart`. It is blocked on a usable `ota_prod.key`
(the published copy is passphrase-encrypted; the host that served an
unencrypted one is down). None of that is on the path to a working robot, and
nothing above depends on it. What was verified, for whoever picks it up:

- the community `ota_prod.pub` verifies a known-good `oskr` OTA, so an OTA
  signed with that key would be accepted;
- an `ankidev` robot rejects a production image on the build type (die 214),
  not on the transport — `OTAStart` itself works;
- wire-os authorizes a key we hold, so its `dev.ota` only needs its
  `manifest.ini` signed, not re-encrypted.
