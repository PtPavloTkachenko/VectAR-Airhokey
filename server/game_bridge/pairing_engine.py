"""Run the bundled pairing engine, so nobody has to remember to.

wire-pod is what issues a robot his token. It ships in this repo and needs no
arguments — and yet starting it was a manual step in a second terminal that the
wizard only mentioned in a red box *after* letting you walk past it. Skipping it
does not fail loudly: BLE pairing succeeds, Wi-Fi succeeds, and then the robot
asks for his token at a door nobody is standing behind. The error surfaces one
step later as something about Anki's cloud, which is not what went wrong.

Its config is NOT configured for us, either — `chipper/apiConfig.json` is in
wire-pod's own `.gitignore`, so it never ships. A fresh clone gets whatever the
engine writes on first run, and that default is not escape-pod mode, which is
the one mode a stock robot can use. So we set it before every start.

So the server starts it, waits until it is actually serving the escape-pod
identity, and stops it on the way out. If the binary was never built we say
the one command that builds it, rather than leaving a dead end.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
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
API_CONFIG = CHIPPER_DIR / "apiConfig.json"


def ensure_escape_pod_config() -> bool:
    """Put the engine in escape-pod mode before it starts. True if changed.

    A stock robot reaches its cloud at the fixed name `escapepod.local:443` —
    his firmware hard-codes it — and wire-pod only answers to that name, with
    the certificate he trusts, in escape-pod mode. In its other mode it serves
    a self-signed IP certificate and never broadcasts the name, so the robot
    talks to nobody and the failure lands minutes later, on a different screen,
    as `no certificate for serial <esn> (404)` — which reads as a broken
    pairing engine rather than a mode that was never on.

    This is not hypothetical for anyone but us: the config lives in wire-pod's
    `.gitignore`, so it never ships, and what the engine writes for itself on a
    first run is the wrong mode. Every fresh clone hits it. We re-apply on each
    start rather than once, because the engine rewrites this file itself.
    """
    try:
        data = json.loads(API_CONFIG.read_text()) if API_CONFIG.is_file() else {}
        if not isinstance(data, dict):
            return False
    except Exception as e:
        # Corrupt or unreadable: wire-pod will rewrite it, and guessing at the
        # contents here would throw away settings we cannot see.
        logger.debug(f"apiConfig.json unreadable ({e}) — leaving it alone")
        return False
    server = data.get("server")
    if not isinstance(server, dict):
        server = {}
    if server.get("epconfig") is True and str(server.get("port")) == "443":
        return False
    server["epconfig"] = True
    server["port"] = "443"
    data["server"] = server
    try:
        API_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        API_CONFIG.write_text(json.dumps(data, indent=2) + "\n")
    except Exception as e:
        logger.warning(
            f"could not enable escape-pod mode in {API_CONFIG.name}: {e} — a "
            f"stock robot will not find the pairing engine until it is set")
        return False
    logger.info("escape-pod mode enabled in apiConfig.json")
    return True


class PairingEngine:
    """Owns the wire-pod process for as long as the server runs."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.note = ""          # why it is not running, if it is not

    def _stop_stale(self) -> bool:
        """Stop an engine we did not start. True if none is left running.

        Only ever called when the one already up is serving a mode nobody can
        use. It is matched by the binary's full path, so this cannot reach a
        wire-pod someone runs from their own checkout — only the copy in this
        repo, which is the copy the server would have started itself.
        """
        try:
            # Match the NAME, then confirm each hit really is our copy by its
            # full command line. Searching for the path directly does not work:
            # pgrep treats the pattern as a regex, and a checkout under a
            # directory like "Dropbox (Personal)" then silently matches nothing.
            out = subprocess.run(["pgrep", "-f", BINARY.name],
                                 capture_output=True, text=True, timeout=5)
            pids = [int(p) for p in out.stdout.split() if p.strip().isdigit()]
        except Exception as e:
            logger.debug(f"could not look for a stale engine: {e}")
            return False
        ours = []
        for pid in pids:
            if pid == os.getpid():
                continue
            try:
                cmd = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                                     capture_output=True, text=True,
                                     timeout=5).stdout
            except Exception:
                continue
            if str(BINARY) in cmd:
                ours.append(pid)
        pids = ours
        if not pids:
            return False        # answering on :8080, but not this binary
        for pid in pids:
            try:
                os.kill(pid, signal.SIGTERM)
                logger.info(f"stopped the stale pairing engine (pid {pid})")
            except Exception as e:
                logger.debug(f"could not stop pid {pid}: {e}")
                return False
        return True

    def _already_up(self) -> bool:
        from .web import pairing
        from . import config
        try:
            return bool(pairing.wirepod_status(config.WIREPOD_URL)["up"])
        except Exception:
            return False

    async def start(self, wait_s: float = 20.0) -> bool:
        """Start it unless something already answers. Never fatal."""
        changed = await asyncio.to_thread(ensure_escape_pod_config)
        if await asyncio.to_thread(self._already_up):
            if changed:
                # It read the config at ITS start, so it is serving the mode we
                # just replaced — the one no stock robot can use. Leaving it is
                # not politeness, it is a wizard that cannot work: the engine
                # answers on :8080, so the next start says "already running" and
                # reuses it forever. Nothing tells it to re-read, so replace it.
                logger.warning(
                    "a pairing engine is running with escape-pod mode off — "
                    "replacing it, since it can never serve a stock robot")
                if await asyncio.to_thread(self._stop_stale):
                    await asyncio.sleep(1.0)
                else:
                    logger.warning(
                        "could not stop it — run `pkill -f vectar-onboard` and "
                        "start the server again")
                    return True
            else:
                # Someone is running their own copy in the right mode — leave
                # it alone. A second one would fight for :443 and :8080 and
                # take both down.
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
