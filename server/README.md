# VectAR Air-Hockey — Game Server

WebSocket bridge (**:8777**) between the Spectacles lens (game authority:
puck physics + score) and the Vector robot (goalie), plus a web console
(**:8780**) with a robot pairing wizard and live dashboard.

```
Spectacles lens  <-- ws://mac:8777 -->  game_bridge  <-- gRPC :443 -->  Vector (stock)
(puck, events, vision_fix)             (goalie AI,       anki_vector SDK
                                        safety, voice)   (wirepod-vector-sdk)
```

## Quick start

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python
python -m game_bridge.main
# then open http://localhost:8780 and pair your robot
```

Full documentation: [../docs/SERVER.md](../docs/SERVER.md) ·
pairing: [../docs/PAIRING.md](../docs/PAIRING.md) ·
protocol: [../docs/PROTOCOL.md](../docs/PROTOCOL.md)

## Useful commands

```bash
python -m pytest tests -q                          # unit tests (no hardware)
python -m game_bridge.main --no-robot              # lens dev without a robot
python -m game_bridge.main --mock-pose             # simulated goalie
python sdk_smoke.py                                # live robot smoke test
python -m game_bridge.sim.fake_puck --volleys 6    # robot-only volleys (no lens)
```
