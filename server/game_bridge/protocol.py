"""WS protocol: JSON text frames with discriminator `t`.

Lens -> Mac : hello, place_confirm, puck, event, vision_fix, ping
Mac  -> Lens: welcome, pose, robot_status, anim_done, delocalized, pong

All coordinates are field-frame mm (see config.py docstring).
Kept as plain dicts + validating constructors — no external deps.
"""
from __future__ import annotations

import json
from typing import Any

# Message types
LENS_TYPES = {"hello", "place_confirm", "puck", "event", "vision_fix", "ping",
              "utter", "llm_response"}   # utter/llm_response = in-game Gemini voice agent
MAC_TYPES = {"welcome", "pose", "robot_status", "anim_done", "delocalized", "pong",
             "llm_request"}              # llm_request -> lens carries it to Gemini via RSG

EVENT_NAMES = {
    "rally_start", "goal_player", "goal_vector",
    "game_over", "pause", "resume",
    "vector_block",   # puck bounced off Vector -> eyes-only celebration
    "countdown",      # pre-serve -> taunt choreography
    "battery_picked_player", "battery_picked_vector",
    "puck_paddle",    # player hit the puck -> robot plays the hit blip
    "puck_wall",      # wall bounce -> robot plays the bounce blip
}

_REQUIRED: dict[str, tuple[str, ...]] = {
    "hello": ("role", "proto"),
    "place_confirm": ("field", "robotFieldPose"),
    "puck": ("x", "y", "vx", "vy", "ts"),
    "event": ("name",),
    "vision_fix": ("x", "y", "conf", "ts"),
    "ping": ("ts",),
    "utter": ("text",),
    "llm_request": ("req",),
    "llm_response": ("req",),
    "welcome": ("proto", "robot"),
    "pose": ("x", "y", "deg", "vy", "ts", "seq", "head", "lift", "drv"),
    "say": ("text",),
    "battery": ("on", "x", "y"),
    "robot_status": ("battery", "cliff", "held", "busy"),
    "anim_done": ("name",),
    "delocalized": ("reason",),
    "pong": ("ts",),
}


class ProtocolError(ValueError):
    pass


def _validate(msg: Any) -> dict[str, Any]:
    if not isinstance(msg, dict) or "t" not in msg:
        raise ProtocolError("missing discriminator 't'")
    t = msg["t"]
    required = _REQUIRED.get(t)
    if required is None:
        raise ProtocolError(f"unknown message type {t!r}")
    missing = [k for k in required if k not in msg]
    if missing:
        raise ProtocolError(f"{t}: missing fields {missing}")
    if t == "event" and msg["name"] not in EVENT_NAMES:
        raise ProtocolError(f"unknown event name {msg['name']!r}")
    return msg


def decode(text: str) -> dict[str, Any]:
    """Parse + validate a single JSON message. Raises ProtocolError."""
    try:
        msg = json.loads(text)
    except json.JSONDecodeError as e:
        raise ProtocolError(f"bad json: {e}") from e
    return _validate(msg)


def decode_many(text: str) -> list[dict[str, Any]]:
    """Parse one WS text frame that may contain SEVERAL concatenated JSON
    objects (the Lens Studio WebSocket coalesces rapid sends into one frame).
    Invalid segments raise ProtocolError; valid prefix messages are returned.
    """
    decoder = json.JSONDecoder()
    out: list[dict[str, Any]] = []
    idx = 0
    n = len(text)
    while idx < n:
        while idx < n and text[idx] in " \t\r\n":
            idx += 1
        if idx >= n:
            break
        try:
            obj, end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError as e:
            raise ProtocolError(f"bad json at {idx}: {e}") from e
        out.append(_validate(obj))
        idx = end
    return out


def encode(msg: dict[str, Any]) -> str:
    """Validate + serialize an outgoing message."""
    t = msg.get("t")
    required = _REQUIRED.get(t or "")
    if required is None:
        raise ProtocolError(f"unknown message type {t!r}")
    missing = [k for k in required if k not in msg]
    if missing:
        raise ProtocolError(f"{t}: missing fields {missing}")
    return json.dumps(msg, separators=(",", ":"))


# --- Builders (Mac -> Lens) ---

def welcome(robot_state: str) -> dict:
    return {"t": "welcome", "proto": 1, "robot": robot_state}


def pose(x: float, y: float, deg: float, vy: float, ts: float, seq: int,
         head: float = 0.0, lift: float = 32.0, drv: int = 0) -> dict:
    return {
        "t": "pose",
        "x": round(x, 1), "y": round(y, 1), "deg": round(deg, 1),
        "vy": round(vy, 1), "ts": ts, "seq": seq,
        "head": round(head, 3), "lift": round(lift, 1), "drv": drv,
    }


def robot_status(battery: int, cliff: bool, held: bool, busy: str,
                 origin_id: int = 0) -> dict:
    return {
        "t": "robot_status", "battery": battery, "cliff": cliff,
        "held": held, "busy": busy, "originId": origin_id,
    }


def say(text: str) -> dict:
    return {"t": "say", "text": text}


def anim_done(name: str) -> dict:
    return {"t": "anim_done", "name": name}


def delocalized(reason: str) -> dict:
    return {"t": "delocalized", "reason": reason}


def pong(ts: float) -> dict:
    return {"t": "pong", "ts": ts}
