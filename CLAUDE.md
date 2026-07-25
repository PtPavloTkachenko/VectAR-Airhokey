# VectAR Air-Hockey — agent guide

AR air hockey: Spectacles (2024) lens (game authority) ↔ Mac Python server
(goalie AI) ↔ physical Anki Vector robot (SDK/gRPC). Read
`docs/ARCHITECTURE.md` first; it has the component maps for both sides.

## Repo map

- `lens/` — Lens Studio **5.15** project (TypeScript, Spectacles 2024).
  NEVER open it with Lens Studio 5.22+ (one-way format upgrade). Scene is
  built in code: `GameController.ts` (state machine) + `FieldBuilder.ts` +
  `GlowKit.ts` (docs/GLOWKIT.md).
- `server/` — Python 3.12 asyncio. `game_bridge/main.py` = Bridge; WS :8777
  to the lens (`docs/PROTOCOL.md`), gRPC :443 to the robot, web console
  :8780 (`game_bridge/web/` — pairing wizard + dashboard, aiohttp).
- `docs/` — human docs; keep them in sync with code changes.

## Ground rules

1. **Field frame**: all game coordinates are field-mm — origin center,
   +X toward Vector's goal, +Y player's left. Lens world units are cm
   (`FieldMath.ts` converts); robot odometry maps via `transform.py`.
   `FIELD_L/FIELD_W` must stay identical in `GameConfig.ts` and `config.py`.
2. **Robot safety is sacred.** `set_wheel_motors` persists robot-side; the
   deadman (goalie loop stops on stale pose; reconnect sends stop first) and
   `SafetyGate` bounds must survive any refactor. Never drive on stale pose.
   A physical robot drives off a table when you get this wrong.
3. **Animations vs odometry**: SDK animations play with
   `ignore_body_track=True` — full-body anims move the treads and corrupt
   the odometry→field transform. Don't "fix" that. Play triggers via the
   prewarmed `_anim_trigger_dict` (string names lazy-load the full anim list,
   which times out on weak Wi-Fi).
4. **Play outranks the show.** Choreography owns the motors, and while it
   runs `goalie_task` skips — so a goal reaction (10-18 s: turn, animation,
   drive home) freezes the goalie for longer than the pause it was budgeted
   against. `rally_start` therefore calls `commander.preempt()`: motors
   stopped FIRST (cancelling the task only ends our await; a behaviour the
   robot already accepted keeps running and fights the goalie), then the job
   cancelled and the queue drained. Keep that order.
5. **Behaviour timeouts scale with the work.** A flat budget for
   `turn_in_place` is wrong by construction — 20° takes ~1 s, 180° cannot fit
   in 1.6 s. `_turn_to` uses `0.8 + |d|/45`. An empty exception string from
   the SDK is `concurrent.futures.TimeoutError`, i.e. OUR budget was short,
   not a robot fault.
6. **`.result` differs by client**: an attribute (`ActionResult`/int) on the
   sync `Robot`, a future on `AsyncRobot`. Calling it on the sync one raises
   `'int' object is not callable` — which looks exactly like a broken robot
   and isn't. Probe with the same client the code uses.
7. **One SDK client** per robot — Vector grants behaviour control to one
   holder. `/api/test` refuses while the Bridge holds it (kept as API; no UI
   calls it), and RELEASE CONTROL is the way to hand him to another tool.
   Whatever you add, keep that discipline.
8. **Lens logging**: SIK `NativeLogger` with a module TAG, never `print()`.
   Lens WebSocket coalesces rapid sends — server must keep `decode_many()`.
9. **5.15 material gotcha**: `Material.clone()` resets graph values to
   defaults — set blend/depth/texture/color explicitly on every clone
   (GlowKit does; follow its pattern).
10. Pairing (`web/pairing.py`) mirrors `anki_vector.configure`: cert from
   wire-pod `/session-certs/<serial>`, guid minted via `UserAuthentication`
   gRPC to the robot (dummy session token — wire-pod ignores it), written to
   `~/.anki_vector/sdk_config.ini`. Token mint is append-only (safe to
   re-pair). wire-pod is needed only during pairing.
11. **No secrets in the repo** — no RSG tokens, no home IPs/serials, no
   certs/guids. `GameConfig.ts` ships with an empty `RSG_GOOGLE_TOKEN`; keep it that way
   in commits. Its `WS_URL` is `ws://vectar.local:8777` — a NAME the server
   publishes over mDNS (`game_bridge/mdns.py`), not an address. Never commit
   a literal IP there; it goes stale with the next DHCP lease and the glasses
   then fail silently.

## Dev workflows

- **Diagnose first**: `cd server && python -m game_bridge.doctor` walks the
  whole chain (pairing engine, escape-pod mode, firmware image, credentials,
  robot reachability, sockets, link) and prints the fix for anything red.
  Same thing at `/api/doctor` and behind RUN DIAGNOSTICS. Use it before
  reading logs — most "the robot is broken" reports are one red line here.
- **`--reload`** restarts the bridge when its sources change. Never leave it
  on while someone is testing on hardware: each save drops the robot AND the
  lens and invalidates the field transform, which is indistinguishable from a
  broken robot. (It happened; six restarts landed inside one calibration.)
- Server tests: `cd server && .venv/bin/python -m pytest tests -q`
  (47 tests, no hardware). Env: Python 3.12,
  `PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python`.
- Lens dev without hardware: server `--mock-pose` + GameController's
  *Skip Calibration* checkbox → full simulated match in LS Preview.
- Robot-only test (no lens): `python -m game_bridge.sim.fake_puck`.
- Careful live smoke: `python sdk_smoke.py` (robot moves — keep table clear).

## Protocol invariant: when a rally starts

`rally_start` means **the puck is moving now** — it arms the goalie. Send
`countdown` for the count before it. Both clients must obey: screen play once
announced the rally at the top of its 4 s countdown and then streamed nothing,
so the bridge's 1.5 s silence guard disarmed the goalie before play began and
the robot never defended. The lens has always had this right; copy it.

Screen play also pauses on `visibilitychange` — its loop is
`requestAnimationFrame`, which browsers stop for a background tab, and you
watch the robot rather than the screen.

## Where things are decided

- Game rules/tunables: `lens/Assets/Scripts/GameConfig.ts`
- Goalie behavior/safety: `server/game_bridge/config.py`
- WS message shapes: `server/game_bridge/protocol.py` (validating — update
  `_REQUIRED` + both endpoints together)
