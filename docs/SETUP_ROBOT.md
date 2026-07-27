# Setting up your Vector

The pairing wizard (**PAIR ROBOT** in the console at `http://localhost:8780`)
walks you through everything. This page explains what it's doing and what — if
anything — you need to do, because a Vector needs a one-time setup before the
game can control it.

## Why any setup is needed

Anki's cloud is gone, so a Vector out of the box can't be authorized by anyone —
it's still trying to talk to servers that no longer answer. The one-time setup
points your robot at **wire-pod** (the community server this app bundles and runs
for you). After that he works on **any Wi-Fi**, as long as this Mac is on the
same network — which it already has to be to play.

You do this **once**. It sticks across reboots and network changes.

## The wizard, step by step

1. Put Vector **on the charger**.
2. **PAIR ROBOT → CONNECT VECTOR.**
3. **Double-press** the button on his back. (Nothing found? Double-press again —
   his advertising window is short.)
4. Type the **PIN** shown on his face.
5. **Set up Vector's connection** — the wizard detects which kind of robot you
   have and shows the right option (see below).
6. Pick Wi-Fi, then **Authorize**. Done — open the lens and play.

The wizard skips any step that's already done, so a robot you've set up before
goes straight to playing.

## Two kinds of Vector

The wizard tells you which one you have on the **Set up** step. You don't have to
know in advance.

### Stock Vector (most people)

A normal, never-modified Vector. The wizard offers **INSTALL FIRMWARE** — a
one-time install of the community "escape-pod" firmware over Bluetooth that
points him at wire-pod for good.

- Keep him **on the charger** and **don't touch him** — it takes a few minutes.
- If the install is refused, put him in **recovery mode** first: on the charger,
  **hold the back button ~15 seconds** until his face shows `anki.com/v`, then
  start over. Recovery accepts the install.

This install changes his everyday life in ways worth knowing before you start —
see [What the firmware install changes](#what-the-firmware-install-changes).

### OSKR / dev Vector

An OSKR (developer-unlocked) robot. These can't take the escape-pod firmware, so
the wizard uses **SSH** instead — no flashing. **SET UP THIS ROBOT** then:

- **Normally there is nothing to do.** His own SSH key lives inside his logs,
  and the wizard downloads them over Bluetooth and takes it out by itself —
  measured on a live robot at 55 KB in 26 s. **Verified end-to-end from a
  factory reset.**
- **Only if that comes back empty, drop his log archive** — the wizard's *set up
  from archive* screen. Get it from Anki's own setup app
  ([vector-web-setup.anki.bot](https://vector-web-setup.anki.bot/#) in Chrome →
  **Save Logs**, downloads a `vector-logs-….tar.bz2`), then drop that file in.
- **Already extracted the key?** Paste it instead (the
  `data/ssh/id_rsa_Vector-XXXX` file from that same archive). It stays on this Mac.

> **The log archive contains your robot's private SSH key.** It never leaves this
> Mac — but don't post the archive publicly or attach it to a bug report.

> **Don't set him up from recovery mode.** Holding the back button ~15 s enters
> recovery; ~5 s is the plain power-off. Recovery is a separate minimal system:
> he reports neither his build type nor his serial there, has no `/data/ssh` and
> none of his services, and refuses the escape-pod image on his own build-type
> gate (error 214). The Wi-Fi you give him in recovery does NOT carry over
> either — so take him out first, then run the wizard once, start to finish.

> A **Clear User Data** wipe regenerates his SSH key and changes his name, so a
> key saved before the wipe no longer matches. That is fine: the wizard fetches
> the new one the same way. His control token goes too, and gets re-minted
> during Authorize.

## What the firmware install changes

Only stock robots are flashed. On an OSKR / dev robot nothing here applies — the
wizard edits two files over SSH and both are trivially reversible.

### What stays exactly the same

The escape-pod image is **Digital Dream Labs' own production 2.x firmware with
one setting changed**, not custom software. Everything he does by himself is the
same code it always was: roaming your desk, his eyes and animations, mapping and
navigation, finding his charger, recognising faces, petting, the cube, the
timer, edge detection. Nobody replaces his personality.

### What changes: his cloud is now your Mac

The one changed setting points his cloud — sign-in, settings sync, and voice
requests — at `escapepod.local` instead of Anki's servers. In practice:

- **Cloud voice stops answering unless something is serving it.** "Hey Vector,
  what's the weather" is a cloud request, and it now arrives at your Mac. With
  the pairing engine not running, those requests simply time out. Everything
  local — the back button, picking him up, the cube, his own behaviours —
  is unaffected.
- **This project's pairing engine does not do speech at all.** It is built
  deliberately without the voice models so it starts in seconds instead of
  pulling hundreds of megabytes you don't need to play air hockey. So while
  *only* our server is running, cloud voice commands will not answer. If you
  want them back, run [full wire-pod](https://github.com/kercre123/wire-pod) —
  the same engine with speech recognition included, pointed at the same name.
- **The official Vector app can no longer sign him in.** It can still find and
  pair with him over Bluetooth, but the sign-in it triggers goes wherever his
  firmware says, and his firmware now says `escapepod.local`.
- **He stops getting firmware updates from Digital Dream Labs.** He stays on the
  escape-pod build until you install something else yourself.

### A factory reset does not undo it

**Clear User Data** wipes `/data` — his Wi-Fi, faces, tokens and name. The cloud
setting is not in `/data`; it lives in the read-only system partition that the
firmware image owns (`/anki/data/assets/cozmo_resources/config/server_config.json`).
So a wiped robot comes back as a *factory-fresh escape-pod robot*: the wizard
sees he is already flashed and skips straight past that step.

Neither the official app nor a reset is a way back. Only another firmware
install is.

### Going back to stock

The same route in reverse — recovery mode, then install a stock image over
Bluetooth instead of the escape-pod one.

1. **Get a stock image for his hardware.** Digital Dream Labs' own firmware
   mirror serves them: `vectorfirmware.ddlbot.ai/vicos/`. Take the **plain**
   name, e.g. `vicos-2.0.1.6091.ota` — not the `oskr` or `d` variant.
2. **Put it where the server serves OTAs from:** `~/.vectar/ota/`.
3. **Put him in recovery** — on the charger, hold the back button ~15 s until
   his face shows `anki.com/v`.
4. **Pair and give him Wi-Fi in the wizard** (he downloads the image himself, so
   he needs a network), then trigger the install with that filename:

   ```bash
   curl -sX POST localhost:8780/api/ble/flash_ep \
     -H 'content-type: application/json' \
     -d '{"ota": "vicos-2.0.1.6091.ota", "force": true}'
   ```

   `force` is required: the wizard normally refuses to flash unless the pairing
   engine is in escape-pod mode, which is a guard on the way *in* and meaningless
   on the way out.
5. **Keep him on the charger until he reboots.** He then comes up as an ordinary
   Vector again, pointed at Anki's cloud, and you set him up with the official
   Vector app.

> **Honest status: we have not run this.** The install machinery is the same one
> proven on hardware in both directions of the setup, and the robot keeps his
> recovery mode and his A/B slots throughout — a failed install is a retry, not
> a brick. But the specific case of installing a stock image *over* the
> escape-pod one is untested here, and firmware refuses installs on its own
> build-type checks in ways that are not always obvious. Treat it as a
> documented route, not a guarantee.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| "No credentials yet" / can't authorize | The robot isn't pointed at wire-pod yet | Finish the **Set up** step (flash or SSH) — that's what this whole page is about |
| Firmware install fails, cloud shows an error icon, code **214** | An OSKR/dev robot can't install the production escape-pod image | Use the **SSH** route instead (it's the OSKR path; the wizard offers it) |
| Firmware install refused on a **stock** robot | Version gate | Put him in **recovery** (hold back button ~15 s → `anki.com/v`), start over |
| "Vector refused that key" | Key is from before a factory reset, or a different robot | Use the current key — download a fresh log bundle to get it |
| Dashboard shows **OFFLINE** after setup | Robot and Mac on different networks | Put both on the **same Wi-Fi**; the dashboard's *LENS WS_URL* shows the Mac's current address |
| Setup sits silent for minutes | The log download / firmware install is genuinely slow over Bluetooth | Leave him on the charger; progress is shown; don't unplug |

## Status & risks (read before you start)

Straight status per robot type, so nothing surprises you. **The two tracks are
independent** — if you have a stock Vector, the OSKR notes below don't apply to
you, and vice versa.

### Stock (consumer) Vector — the normal case

**Verified end-to-end on a brand-new stock robot, 2026-07-25** — a unit that had
never been signed into the official app.

| Step | State |
|---|---|
| Find + pair over Bluetooth, PIN handshake | **verified on hardware** |
| Join him to your Wi-Fi | **verified on hardware** |
| Install the escape-pod firmware (he downloads it from your Mac) | **verified on hardware** |
| His sign-in to the pairing engine → session certificate | **verified on hardware** |
| Mint this Mac's SDK control token | **verified on hardware** |

**What the run actually looks like:** pair → Wi-Fi → firmware install (~180 MB,
a few minutes) → he reboots into his own first-time setup screen → pair again →
Wi-Fi again (the install wipes it) → authorize. About 10 minutes, mostly
waiting. You never need the Vector app.

**Risks worth knowing:**

- The firmware install is a real **OTA that rewrites his system partition**. It's
  the same image and the same route upstream wire-pod uses, and the robot keeps a
  recovery mode — but treat it like any firmware flash: **keep him on the charger,
  don't unplug, don't interrupt it.**
- The robot must be **in recovery mode** to accept it (on the charger, hold the
  backpack button ~15 s until his face shows `anki.com/v`). The wizard detects
  this and tells you; production firmware simply refuses the install otherwise.
- A `Wi-Fi connect failed (result 255)` on the first try right after a reboot is
  usually his network stack still coming up — press CONNECT again with the same
  password before suspecting it.
- **If the link won't come up after authorizing**, restart Vector once (hold the
  backpack button ~5 s until he switches off, then back on the charger). A
  gateway that answers the network but stalls on every authenticated call is
  stuck in that state and only a power cycle clears it. A clean run does **not**
  need this — it showed up when the same robot had tokens minted at it
  repeatedly, so treat it as a recovery step, not part of the procedure.

### OSKR / dev Vector

**Verified end-to-end from a factory reset, 2026-07-26.**

| Step | State |
|---|---|
| His SSH key taken off him over Bluetooth (55 KB in 26 s) | **verified on hardware** |
| Cloud repointed over SSH, one reboot | **verified on hardware** |
| His sign-in to the pairing engine → session certificate | **verified on hardware** |
| Mint this Mac's SDK control token | **verified on hardware** |
| Mac already has SSH access → auto-provision | **verified** |
| Log-archive drop → key detected, robot found on the LAN, provisioned | **verified end-to-end** |
| Paste-the-key route | **verified** |
| A robot with **no token at all** (factory-reset / brand new) | **solved** — see below |

**The old "open item" is closed.** A wipe clears the robot's **SDK control token
store** (`vic.AppTokens`), and the long-standing puzzle was that a robot never
re-populates it on its own: the robot only trusts a token its cloud client
actually *pulled*, and `vic-cloud` does not do that unprompted. Sitting on Wi-Fi
next to a running wire-pod changes nothing — which is exactly why
`/session-certs/<esn>` stayed empty and pairing looked broken.

**The trigger is a Bluetooth message**, not a network condition:
`RtsCloudSessionRequest` (wire-pod's `do_auth`) tells `vic-cloud` to perform
primary auth *now*, against whatever its `server_config` points at. Send that
over the live BLE session and the pairing engine gets the robot's session
certificate a second later; the SDK token mint then just works. The wizard does
this automatically inside **Authorize**.

Proven on a from-zero stock robot (2026-07-25), and on a factory-reset OSKR
unit the next day (2026-07-26) — RTS is present on every firmware, so the same
message rescues both. Background:
[PAIRING_86_DEEPDIVE.md](PAIRING_86_DEEPDIVE.md).
- The wizard **rewrites the robot's cloud config** (`server_config.json`) and
  installs a CA cert. The original is backed up on the robot (`.bak`) so it's
  reversible — but if your robot is already pointed at *your own* wire-pod, this
  repoints it at this Mac.
- An **ankidev/OSKR robot refuses the escape-pod image** (error **214**) — that's
  expected, use the SSH/archive route, not the firmware install.

### How this was built (context)

This was developed against a **single OSKR Vector that was already connected and
already running on wire-pod** — the robot came into the project set up, and the
game, the lens and the bridge were built on top of that. **The full chain
(Spectacles → server → a real Vector driving) has been demonstrated end-to-end in
two earlier builds — this air-hockey game, and the first version of VectAR OS**
(the wider robot + AR + AI system it grew alongside). The goalie drove, blocked
and talked. The Spectacles side is verified live on device, not just in the
console.

That history is why the "robot is already provisioned" paths are the well-trodden
ones — and why the from-scratch path needed deliberate attention. So the test
robots were **factory-reset on purpose**, to build the *out-of-the-box*
experience a new owner actually gets instead of assuming it.

**The point of that work was automation.** Getting a robot online used to mean a
day of manual SSH, cert juggling, cloud-config edits and token wrangling. It is
now a few clicks in the wizard — both robot types, from a factory reset — so
this project, and the next robot project after it, starts with a Vector online
in minutes.

Nothing here needs a terminal. If a step ever tells you to run a command, that's
a bug — please report it.

## More than one robot

Run the wizard again and the second Vector joins the first — setting one up
never disturbs another. The dashboard's **Your robots** card is where you say
which of them plays; the checked robot is the one the goalie logic drives and
the one the Lens plays against. Switching is a click, not another setup, and it
hands the previous robot back to himself first (Vector answers to one
controlling client at a time, so a robot nobody releases just stands there).
**✕** forgets a robot: it drops his certificate and token from this Mac only —
he still points at the pairing engine, so adding him back is the Authorize step
alone. Details in [SERVER → More than one robot](SERVER.md#more-than-one-robot).
