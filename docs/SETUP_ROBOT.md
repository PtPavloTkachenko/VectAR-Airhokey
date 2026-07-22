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

### OSKR / dev Vector

An OSKR (developer-unlocked) robot. These can't take the escape-pod firmware, so
the wizard uses **SSH** instead — no flashing. **SET UP THIS ROBOT** then:

- **If this Mac already has SSH access** (most OSKR owners) — it just works, no
  input from you.
- **Otherwise, drop his log archive** — the wizard's *OSKR — set up from archive*
  screen. Get the archive from Anki's own setup app
  ([vector-web-setup.anki.bot](https://vector-web-setup.anki.bot/#) in Chrome →
  **Save Logs**, downloads a `vector-logs-….tar.bz2`), then drop that file in.
  The wizard finds the SSH key inside it, locates the robot on your Wi-Fi by
  itself, and provisions him. **Verified end-to-end.**
- **Already extracted the key?** Paste it instead (the
  `data/ssh/id_rsa_Vector-XXXX` file from that same archive). It stays on this Mac.

> **The log archive contains your robot's private SSH key.** It never leaves this
> Mac — but don't post the archive publicly or attach it to a bug report.

> Lost your OSKR key after a **Clear User Data** wipe? The wipe makes the robot
> generate a *new* key, so any key you saved before the wipe no longer matches —
> and his name changes too (e.g. `Vector-X6X8` → `Vector-X1W8`). Download a fresh
> log bundle (Anki's setup app → *Save Logs*) to get the new one. Note that a
> wiped robot also loses its control token — see
> [Status & risks](#status--risks-read-before-you-start) below.

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

| Step | State |
|---|---|
| Find + pair over Bluetooth, PIN handshake | **verified on hardware** |
| Join him to your Wi-Fi | **verified on hardware** |
| Install the escape-pod firmware over Bluetooth | **built, not yet verified by us on a stock unit** |
| Cloud → wire-pod, then SDK control | follows from the firmware install; **unproven end-to-end on our side** |

**Risks worth knowing:**

- The firmware install is a real **OTA that rewrites his system partition**. It's
  the same image and the same route upstream wire-pod uses, and the robot keeps a
  recovery mode — but treat it like any firmware flash: **keep him on the charger,
  don't unplug, don't interrupt it.**
- We have not yet run this on a stock test unit. If you're early here, please open
  an issue with the exact wizard message — that's the fastest way to get it proven.

### OSKR / dev Vector

| Step | State |
|---|---|
| Mac already has SSH access → auto-provision | **verified** |
| Log-archive drop → key detected, robot found on the LAN, provisioned | **verified end-to-end** |
| Paste-the-key route | **verified** |
| A robot that was **factory-reset / Clear User Data** | ⚠️ **open item — see below** |

**The one open item.** A wipe clears not just the SSH key but the robot's **SDK
control token store** (`vic.AppTokens`). Re-establishing that token locally is the
piece still being worked on: the robot only trusts a token its cloud client
actually *pulled*, and getting a freshly-wiped robot to perform that pull is not
solved yet. Full diagnosis, everything already proven, and the concrete next
steps are in [PAIRING_86_DEEPDIVE.md](PAIRING_86_DEEPDIVE.md).

**This does not affect a normal OSKR robot** that has been running with wire-pod —
it already holds its token, so setup and play work today. It only bites if you
wipe the robot and expect to re-pair from zero.

- **Don't factory-reset / Clear User Data** on a robot you want to keep playing
  with until that item is closed.
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
two earlier builds** — the goalie drove, blocked and talked. The Spectacles side
is verified live on device, not just in the console.

That history is why the "robot is already provisioned" paths are the well-trodden
ones — and why the from-scratch path needed deliberate attention. So the test
robot was **factory-reset on purpose**, to build the *out-of-the-box* experience
a new owner actually gets instead of assuming it.

**The point of the current work is automation.** Getting that robot online used
to mean a day of manual SSH, cert juggling, cloud-config edits and token
wrangling. The goal is to compress that into a few clicks in the wizard, so this
project — and the next robot project after it — starts with a Vector online in
minutes. The wipe is what exposes the last rough edge (re-establishing the SDK
control token), and that's what's being finished in the open rather than claimed
done.

Nothing here needs a terminal. If a step ever tells you to run a command, that's
a bug — please report it.
