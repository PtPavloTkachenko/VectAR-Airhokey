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
- **If not** — paste his **SSH private key** (the `data/ssh/id_rsa_Vector-XXXX`
  file from the log bundle you downloaded when you unlocked him). ~27 lines of
  copy-paste. It stays on this Mac.
- **No key handy?** — "TRY HIS LOGS" pulls it off the robot over Bluetooth. It
  works without a key but is **slow** (the log bundle is large), so use it only
  as a last resort.

> Lost your OSKR key after a **Clear User Data** wipe? The wipe makes the robot
> generate a *new* key, so any key you saved before the wipe no longer matches —
> and his name changes too (e.g. `Vector-X6X8` → `Vector-X1W8`). Download a fresh
> log bundle (via the wizard's "TRY HIS LOGS", or the Vector app's *Send Logs*)
> to get the new one.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| "No credentials yet" / can't authorize | The robot isn't pointed at wire-pod yet | Finish the **Set up** step (flash or SSH) — that's what this whole page is about |
| Firmware install fails, cloud shows an error icon, code **214** | An OSKR/dev robot can't install the production escape-pod image | Use the **SSH** route instead (it's the OSKR path; the wizard offers it) |
| Firmware install refused on a **stock** robot | Version gate | Put him in **recovery** (hold back button ~15 s → `anki.com/v`), start over |
| "Vector refused that key" | Key is from before a factory reset, or a different robot | Use the current key — download a fresh log bundle to get it |
| Dashboard shows **OFFLINE** after setup | Robot and Mac on different networks | Put both on the **same Wi-Fi**; the dashboard's *LENS WS_URL* shows the Mac's current address |
| Setup sits silent for minutes | The log download / firmware install is genuinely slow over Bluetooth | Leave him on the charger; progress is shown; don't unplug |

## What's verified vs. still being proven

Honest status, so you know what to expect:

- **OSKR with working SSH** — the common OSKR case; auto-detects and provisions.
- **OSKR, paste-a-key** — built; the full chain (key → SSH → config → reboot →
  pair) still wants one clean end-to-end run to be called battle-tested.
- **Stock firmware install** — built and matches how upstream wire-pod does it,
  but not yet verified end-to-end on our side; a stock test unit is the next
  step. If you hit a snag on a stock robot, please open an issue with the exact
  wizard message.

Nothing here needs a terminal. If a step ever tells you to run a command, that's
a bug — please report it.
