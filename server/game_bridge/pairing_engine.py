"""Run the bundled pairing engine, so nobody has to remember to.

wire-pod is what issues a robot his token. It ships in this repo, it is
configured for escape-pod mode already, and it needs no arguments — and yet
starting it was a manual step in a second terminal that the wizard only
mentioned in a red box *after* letting you walk past it. Skipping it does not
fail loudly: BLE pairing succeeds, Wi-Fi succeeds, and then the robot asks for
his token at a door nobody is standing behind. The error surfaces one step
later as something about Anki's cloud, which is not what went wrong.

So the server starts it, waits until it is actually serving the escape-pod
identity, and stops it on the way out. If the binary was never built we say
the one command that builds it, rather than leaving a dead end.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger("game-bridge.pairing-engine")

# server/onboarding/wire-pod/chipper — the working directory matters: the
# engine loads its certificate and config by relative path.
CHIPPER_DIR = (Path(__file__).resolve().parent.parent
               / "onboarding" / "wire-pod" / "chipper")
BINARY = CHIPPER_DIR / "vectar-onboard"
BUILD_HINT = ("cd server/onboarding/wire-pod/chipper && "
              "go build -tags inbuiltble -o vectar-onboard ./cmd/vectar-onboard")


class PairingEngine:
    """Owns the wire-pod process for as long as the server runs."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.note = ""          # why it is not running, if it is not

    def _already_up(self) -> bool:
        from .web import pairing
        from . import config
        try:
            return bool(pairing.wirepod_status(config.WIREPOD_URL)["up"])
        except Exception:
            return False

    async def start(self, wait_s: float = 20.0) -> bool:
        """Start it unless something already answers. Never fatal."""
        if await asyncio.to_thread(self._already_up):
            # Someone is running their own copy — leave it alone. Starting a
            # second one would fight for :443 and :8080 and take both down.
            logger.info("pairing engine already running — leaving it alone")
            return True
        if not BINARY.is_file():
            self.note = (f"the pairing engine is not built. Build it once: "
                         f"{BUILD_HINT}")
            logger.warning(self.note)
            return False
        try:
            self.proc = subprocess.Popen(
                [str(BINARY)], cwd=str(CHIPPER_DIR),
                stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                start_new_session=True)
        except Exception as e:
            self.note = f"could not start the pairing engine: {e}"
            logger.warning(self.note)
            return False

        # Wait for it to serve, not merely to exist: a robot that asks a second
        # too early gets the same silence as if we had never started it.
        deadline = asyncio.get_event_loop().time() + wait_s
        while asyncio.get_event_loop().time() < deadline:
            if await asyncio.to_thread(self._already_up):
                logger.info("pairing engine started")
                return True
            if self.proc.poll() is not None:
                self.note = ("the pairing engine exited immediately — port 443 "
                             "or 8080 may already be in use")
                logger.warning(self.note)
                return False
            await asyncio.sleep(0.5)
        self.note = "the pairing engine did not come up in time"
        logger.warning(self.note)
        return False

    def stop(self) -> None:
        if not self.proc or self.proc.poll() is not None:
            return
        try:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            logger.info("pairing engine stopped")
        except Exception as e:
            logger.debug(f"pairing engine stop: {e}")
        finally:
            self.proc = None

    async def restart(self) -> bool:
        """After a network change: its mDNS name carries the old address.

        Same trap as our own published name, with one difference — this one is
        another process, so it cannot be re-announced from here. Restarting is
        the whole cure, and it costs about a second.
        """
        if self.proc is None:
            return False        # not ours to restart
        await asyncio.to_thread(self.stop)
        return await self.start()
