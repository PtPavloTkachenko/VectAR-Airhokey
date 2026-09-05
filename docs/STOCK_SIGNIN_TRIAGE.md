# "He signed in, but no certificate appeared"

The wall a stock robot lands on after everything else is green: BLE pairs, the
escape-pod firmware installs, Wi-Fi joins, the sign-in reports success — and
`/session-certs/<esn>` stays **404**, so Authorize fails after a 60 s wait with
*"wire-pod has no certificate for serial …"*.

That message names the symptom and points at the wrong component. **The engine
is almost never the problem.** This page is the mechanism and the decision
tree; work it in order and stop at the first branch that answers.

## The mechanism (why nothing on the Mac can fix it)

The certificate is not written by the Bluetooth step. It arrives because the
**robot** makes two calls of his own, to the Mac, on `:443`:

1. **`AssociatePrimaryUser`** (token server) — he hands over his own
   certificate. wire-pod keeps it in memory, keyed by **his IP address**
   (`pkg/servers/token/token.go`, `SessionWriteStore*`).
2. **jdocs `ReadDocs`** — on this connection wire-pod matches that stored entry
   by IP and only then writes the files
   (`pkg/servers/jdocs/server.go` → `session-certs/<esn>` and
   `~/.anki_vector/<name>-<esn>.cert`).

So the Bluetooth message is a *request* to go and do that, not the act itself.
If neither call happens, no amount of restarting wire-pod, re-flashing, or
waiting will produce a certificate — there is nothing to produce it from.

The match is **by IP**. If his address changes between the sign-in and the
jdocs call, wire-pod holds a certificate it can no longer match, and the result
looks identical to never having signed in.

## Two things that look like evidence and are not

Both were measured on a run that **finished successfully**, so neither can
tell you anything about a run that failed. Establishing this cost a day.

- **"netstat shows no robot→Mac `:443` connections."** A `netstat` loop
  sampling every 0.25 s caught **nothing** on `:443` during a completely
  successful pairing — the exchange is too brief to be caught by polling. The
  robot had in fact connected: the engine's own log recorded the association a
  second later. Absence here means nothing at all.
- **"the engine's log shows no token or jdocs requests."** The engine prints
  to stdout only when started with `DEBUG_LOGGING=true` (`logger.Println` is a
  no-op otherwise, keeping everything in memory for its web UI). A stdout
  capture of a successful run contains the startup banner and nothing else.
  The server now sets that flag when it starts the engine — but a copy someone
  starts by hand still prints nothing.

**Ask the engine instead.** It keeps its own log and serves it:

```bash
curl -s localhost:8080/api/get_logs | tail -20
```

The line that settles it is written at the moment the certificate is:

```
New bot being associated with wire-pod. ESN: 0dd1f6df, IP: 192.168.0.205
```

`RUN DIAGNOSTICS` reads this too, as **robots seen by the engine**.

## Step 1 — did he answer with an empty token?

Since `4b9497b` the server says this outright. In the server log, at the moment
of Authorize:

```
robot answered the cloud session (attempt 1) but handed back an EMPTY token —
he did not complete the sign-in, so no certificate will be written
```

An empty token means vic-cloud replied to us **without** completing the
sign-in: it never called the engine, nothing was associated. The status byte
says success; the token is the part that tells the truth. (Older builds logged
this as `robot cloud-authed against wire-pod` — if that is what you see, pull
first, because that line was printed for both outcomes.)

**If the token is empty** → the robot is the one to act on, not the Mac:

1. Full restart: hold the backpack button ~5 s until he switches off, put him
   back on the charger.
2. **Let him wake fully** and keep him awake — pick him up, pet him, take him
   off the charger. A Vector asleep on the charger does not sync, and the
   window right after boot is easy to sleep through.
3. Run the setup again over Bluetooth (PAIR ROBOT → SET UP THIS ROBOT).

## Step 2 — did he reach the engine at all?

```bash
cd server && python -m game_bridge.doctor      # "robots seen by the engine"
curl -s localhost:8080/api/get_logs | tail -20 # the same thing, raw
```

- **His ESN is listed** → he reached the engine and the certificate was
  written. If Authorize still fails, the problem is after this point (a stale
  certificate for an older name, or an address that changed between his two
  calls — the match is by IP).
- **Nothing listed after a full wizard run** → he never got there. This is the
  robot's own state, not the network's: back to step 1, and keep him awake.

Do not measure this with `netstat`, and do not read anything into an empty
stdout log — see the section above for why both mislead.

Reaching the Mac's connCheck on **`:80` by name** is a separate call from the
sign-in: it proves DNS and reachability, and says nothing about whether he
signed in.

## Step 3 — rule the Mac out in one line

```bash
cd server && python -m game_bridge.doctor
```

Everything about the engine, the mode, the certificate and the ports is in
there. If `escape-pod mode` is `ok`, the Mac side is done — no amount of
further work there will move this.

Two Mac-side traps that look like robot problems, both covered in
[OPERATIONS.md](OPERATIONS.md#5--troubleshooting--symptom--cause--fix):

- an engine left running from before a config change (killing the server does
  not kill it, and the next start reuses it),
- the Mac's address changing since the engine started.

## The reference run (what success looks like)

Captured 2026-09-06 on a robot **reset to factory** and taken through the whole
wizard, with the engine holding no certificate and no record of him — the same
starting state as a robot that has never been set up:

| | |
|---|---|
| Server log | `robot cloud-authed against wire-pod (attempt 1)` — a **non-empty** token |
| Engine's own log | `New bot being associated with wire-pod. ESN: …, IP: …` |
| `session-certs/<esn>` | written, same second |
| `~/.anki_vector/<name>-<esn>.cert` | written, same second |
| Doctor afterwards | robot paired, control token present, link connected |
| netstat on `:443` | **nothing** — and it succeeded anyway |

Whole thing takes about a second once the wizard reaches Authorize. If a run
takes 60 s and ends at the 404, it did not fail slowly — it never started.

## What is genuinely unknown

If the token comes back non-empty **and** the engine's log still never records
the association, that is past what the project has seen. Capture, in one run:
the token line from the server log, `/api/get_logs` from the engine, and the
robot's name and IP at that moment. That combination is what the next fix will
be built from.

Background on the older, pre-escape-pod form of this wall — including a manual
token-injection attempt that reaches a 401 — is in
[PAIRING_86_DEEPDIVE.md](PAIRING_86_DEEPDIVE.md).
