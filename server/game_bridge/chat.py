"""GameChat — in-game Gemini voice agent, THROUGH THE LENS (RSG / Bring-Alive
token, NO Mac API key) — the same mechanic as the VectAR brain + vector-sense-515:

    lens ASR --utter--> [GameChat builds the prompt] --llm_request--> lens
    lens RSG Gemini --llm_response--> GameChat --> commander.say (robot onboard TTS)

Vector talks with his OWN voice; all the Gemini access rides the lens's Remote
Service Gateway. Gated behind config.VECTAR_CHAT — OFF = zero change to the game.
"""
from __future__ import annotations

import logging
import re
import time

log = logging.getLogger("game-bridge.chat")

# AI-meta / refusal / system text Vector must NEVER speak aloud (Bring-Alive
# discipline: strong persona + strip + cap, plus this belt-and-suspenders drop).
_META = (
    "as an ai", "as a language model", "language model", "i am an ai",
    "i'm just an ai", "as an assistant", "as a helpful", "cannot fulfill",
    "can't fulfill", "cannot assist", "i cannot help", "i can't help",
    "i'm sorry, but", "i am sorry, but",
)


def _clean_say(text: str) -> str:
    """Scrub a Gemini line into a speakable spoken phrase: strip a leading role
    label ('Vector:'), (stage directions)/[brackets], markdown, quotes; collapse
    whitespace; DROP AI-meta/refusals (-> ''); cap length so onboard TTS is snappy."""
    if not text:
        return ""
    t = re.sub(r"^\s*[A-Za-z ]{1,16}:\s*", "", text.strip())   # "Vector:" label
    t = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", t)                # (stage) / [dir]
    t = re.sub(r"[*_`#>]", "", t)                             # markdown
    t = re.sub(r"\s+", " ", t).strip().strip('"').strip("'").strip()
    if any(m in t.lower() for m in _META):
        return ""
    return t[:80]

# Persona = just "the small robot Vector" (per Pavlo). Short spoken lines only.
SYSTEM = (
    "You are Vector, a small curious table robot with a BIG cocky personality, "
    "playing air hockey as the goalie against a human and trash-talking. "
    "Reply IN CHARACTER as Vector: ONE very short spoken line, AT MOST 8 words. "
    "No emojis, no markdown, no stage directions -- only what you say aloud. "
    "ALWAYS reply in ENGLISH ONLY, even if the person speaks another language -- "
    "your robot voice can only speak English."
)

# Proactive reactions: Vector comments on the game himself (score/boosts/state).
REACT = {
    "goal_player":            "The human just SCORED a goal past you. React -- salty but sporty.",
    "goal_vector":            "You just scored / the human failed to score. Gloat a little.",
    "battery_picked_player":  "The human grabbed the power-up boost before you. Complain.",
    "battery_picked_vector":  "YOU grabbed the power-up boost. Show off.",
    "game_over_win":          "The match just ENDED and YOU WON. Celebrate, cocky.",
    "game_over_lose":         "The match just ended and you LOST. Sore but cute loser.",
    "countdown":              "A new round is about to start. Taunt the human.",
}


class GameChat:
    def __init__(self, send_to_lens, commander):
        self._send = send_to_lens          # async callable(dict) -> ws.send to lens
        self.commander = commander
        self._n = 0
        self._pending: set[str] = set()
        self._last_auto = 0.0              # proactive-line cooldown clock
        self.auto_cooldown_s = 6.0         # min gap between self-initiated lines
        self._intro_done = False           # first-time greeting + how-to-play

    async def on_utter(self, msg: dict):
        """Lens ASR gave us the person's words -> ask Gemini (through the lens)."""
        text = (msg.get("text") or "").strip()
        if not text or self.commander is None:
            return
        self._n += 1
        req = f"chat{self._n}"
        self._pending.add(req)
        await self._send({
            "t": "llm_request",
            "req": req,
            "system": SYSTEM,
            "contents": [{"role": "user", "text": text}],
            "temperature": 0.85,
            "maxTokens": 25,
        })
        log.info(f"utter -> llm_request {req}: {text!r}")

    async def intro(self) -> bool:
        """First-time greeting + how-to-play, said in 2 SHORT parts (so the text
        isn't one long blast). Returns True only the first time (caller then skips
        its normal taunt). Robot's own onboard TTS; say_line queues -> 2 steps."""
        if self._intro_done or self.commander is None:
            return False
        self._intro_done = True
        self.commander.say_line("Hey! I'm Vector, I'm alive and I can talk.")
        self.commander.say_line("Put your hand on the table to hit the puck. Ask me anything!")
        return True

    async def proactive(self, kind: str, score=None) -> bool:
        """Vector reacts to a GAME EVENT on his own (score/boost/win). Cooldown-gated
        so it never spams or piles up latency. Returns True if it fired (the caller
        then skips its canned line). Reply flows back through on_llm_response -> say."""
        if self.commander is None or kind not in REACT:
            return False
        now = time.monotonic()
        if now - self._last_auto < self.auto_cooldown_s:
            return False
        self._last_auto = now
        self._n += 1
        req = f"auto{self._n}"
        self._pending.add(req)
        sc = ""
        if score and len(score) >= 2:
            sc = f" Score right now -- human {score[0]}, you {score[1]}."
        await self._send({
            "t": "llm_request", "req": req, "system": SYSTEM,
            "contents": [{"role": "user", "text": f"{REACT[kind]}{sc} Say ONE short line:"}],
            "temperature": 0.9, "maxTokens": 20,
        })
        log.info(f"proactive {kind} -> llm_request {req} (score={score})")
        return True

    def on_llm_response(self, msg: dict):
        """Gemini's reply came back through the lens -> Vector says it (onboard TTS)."""
        req = msg.get("req", "")
        if req not in self._pending:
            return
        self._pending.discard(req)
        if msg.get("error"):
            log.warning(f"chat {req} gemini error: {msg['error']}")
            return
        raw = msg.get("text") or ""
        reply = _clean_say(raw)
        if reply:
            log.info(f"chat {req} -> say: {reply!r}")
            self.commander.say_async(reply)
        else:
            log.info(f"chat {req} -> DROPPED (empty/meta/refusal): {raw!r}")
