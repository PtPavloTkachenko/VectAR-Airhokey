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

Two consequences worth internalising:

- **Zero robot→Mac `:443` connections means the robot never tried.** Look there
  first; it splits the whole problem in half.
- The match is **by IP**. If his address changes between the sign-in and the
  jdocs call, wire-pod holds a certificate it can no longer match, and the
  result looks identical to never having signed in.

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

## Step 2 — is he reaching the Mac at all?

Watch for his connections while the wizard runs (replace the IPs):

```bash
end=$((SECONDS+300))
while [ $SECONDS -lt $end ]; do
  netstat -an 2>/dev/null | grep -E "192.168.1.33" | grep -E "\.443|\.8080|\.80 " \
    && echo "seen at $(date +%H:%M:%S)"
  sleep 0.3
done
```

- **Nothing on `:443`** → he never made either call. Go back to step 1; this is
  the robot's own state, not the network's. Note that reaching the Mac's
  connCheck on **`:80` by name** proves DNS and reachability are fine and says
  nothing about whether he signed in — the two are separate calls.
- **Connections appear, still no certificate** → he is talking and the write is
  failing. Read the engine's log (start it with its output captured, not
  discarded) and check whether his IP changed between the two calls.

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

## What is genuinely unknown

If the token comes back non-empty and he still never opens `:443`, this is past
what the project has seen. Capture, in one run: the guid value, the engine log
with output preserved, and the netstat watch above. That combination is what
the next fix will be built from — nothing in the current code can distinguish
the remaining cases without it.

Background on the older, pre-escape-pod form of this wall — including a manual
token-injection attempt that reaches a 401 — is in
[PAIRING_86_DEEPDIVE.md](PAIRING_86_DEEPDIVE.md).
