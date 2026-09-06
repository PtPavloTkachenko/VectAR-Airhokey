# The official route — no firmware, no pairing engine

Two ways to get a robot under SDK control. This is the short one.

|  | official (this page) | wire-pod ([SETUP_ROBOT](SETUP_ROBOT.md)) |
|---|---|---|
| Firmware flash | **none** | escape-pod image, ~180 MB, from recovery |
| Running on your Mac | nothing | the pairing engine, while pairing |
| Depends on | DDL's cloud staying up | nobody |
| Account needed | yes | no |
| Robot's cloud afterwards | DDL's | yours |

Everything after pairing is identical — the same `sdk_config.ini`, the same
game, the same dashboard. Only the source of the credentials differs.

## Why there are two at all

The SDK needs two things: the robot's **certificate**, and a **token** he
accepts. Neither can be read off the robot; both are issued by his cloud.
Anki's is gone, so wire-pod stands in as a local replacement — and a stock
robot only trusts a local pod after the escape-pod firmware, which is where
the flash comes from.

DDL runs a cloud that still issues both. If you are willing to depend on it,
the firmware step is not needed at all.

## Step 1 — set the robot up their way (in a browser)

Go to **[vector-setup.ddl.io](https://vector-setup.ddl.io/)** (also served as
`vector-web-setup.anki.bot`) in Chrome or Edge — it pairs over Web Bluetooth,
so Safari and Firefox will not do.

It walks the same ground our wizard does: connect over Bluetooth, join him to
Wi-Fi, sign in. **Use the account you want to keep** — the certificate is
issued against it, and step 2 signs in as the same account.

At the end he is a normal, working Vector, associated with that account. It
also has a **download-logs** button, which is the only way to see inside a
stock robot without SSH — worth knowing when something goes wrong.

## Step 2 — take the credentials (here)

```bash
curl -sX POST localhost:8780/api/official/pair \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"…"}'
```

The serial, name and address are filled in from what the server already knows;
press FIND ROBOT first if it does not. What happens, in order:

1. **POST** `accounts.api.ddl.io/1/sessions` — sign in, get a session token.
   The password is sent to them and stored nowhere.
2. **GET** `device-cert.api.ddl.io/vic/<esn>` — his certificate. A **404** here
   means step 1 was never done for this robot: nothing is registered.
3. **UserAuthentication** over gRPC to the **robot**, carrying that session
   token, which returns the **guid** — the thing the SDK actually
   authenticates with. This one goes to him over Wi-Fi, not to the internet.
4. Both are written to `~/.anki_vector/`.

From here `RUN DIAGNOSTICS` should show him paired, and CONNECT ROBOT works.

## When to prefer the other route

- **You want no dependency.** DDL's servers have gone quiet before; this robot
  outlived one cloud already. wire-pod needs nobody.
- **No account, or the robot was never registered.** Step 2 returns a 404 and
  there is nothing to fetch.
- **You want the robot's own voice/AI going through your machine**, not theirs.

The two are peers, and switching is not one-way: the escape-pod firmware
installs later if you change your mind, and
[recovery](OPERATIONS.md#5--troubleshooting--symptom--cause--fix) puts official
firmware back if you change it again.
