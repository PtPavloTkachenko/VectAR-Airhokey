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
4. **One SDK client** per robot. The web `/api/test` already refuses while
   the Bridge holds the connection — keep that discipline.
5. **Lens logging**: SIK `NativeLogger` with a module TAG, never `print()`.
   Lens WebSocket coalesces rapid sends — server must keep `decode_many()`.
6. **5.15 material gotcha**: `Material.clone()` resets graph values to
   defaults — set blend/depth/texture/color explicitly on every clone
   (GlowKit does; follow its pattern).
7. Pairing (`web/pairing.py`) mirrors `anki_vector.configure`: cert from
   wire-pod `/session-certs/<serial>`, guid minted via `UserAuthentication`
   gRPC to the robot (dummy session token — wire-pod ignores it), written to
   `~/.anki_vector/sdk_config.ini`. Token mint is append-only (safe to
   re-pair). wire-pod is needed only during pairing.
8. **No secrets in the repo** — no RSG tokens, no home IPs/serials, no
   certs/guids. `GameConfig.ts` ships with an empty `RSG_GOOGLE_TOKEN` and a
   placeholder `WS_URL`; keep it that way in commits.

## Dev workflows

- Server tests: `cd server && .venv/bin/python -m pytest tests -q`
  (47 tests, no hardware). Env: Python 3.12,
  `PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python`.
- Lens dev without hardware: server `--mock-pose` + GameController's
  *Skip Calibration* checkbox → full simulated match in LS Preview.
- Robot-only test (no lens): `python -m game_bridge.sim.fake_puck`.
- Careful live smoke: `python sdk_smoke.py` (robot moves — keep table clear).

## Where things are decided

- Game rules/tunables: `lens/Assets/Scripts/GameConfig.ts`
- Goalie behavior/safety: `server/game_bridge/config.py`
- WS message shapes: `server/game_bridge/protocol.py` (validating — update
  `_REQUIRED` + both endpoints together)
