"""Wait for the game-server WS (:8777 = robot connected + control), then run a
short fake_puck volley over SDK. Robot must be on a free surface (it WILL drive)."""
import asyncio, socket, sys, subprocess, os

async def wait_port(host, port, timeout=50):
    for _ in range(int(timeout * 2)):
        try:
            socket.create_connection((host, port), timeout=1).close()
            return True
        except OSError:
            await asyncio.sleep(0.5)
    return False

async def main():
    print("[volley] waiting for game-server WS :8777 (robot connect+control) ...")
    if not await wait_port("localhost", 8777, 55):
        print("[volley] WS never came up — server failed to connect?")
        return 1
    print("[volley] WS up. giving the goalie 2s to settle, then volleys ...")
    await asyncio.sleep(2)
    r = subprocess.run(
        [sys.executable, "-m", "game_bridge.sim.fake_puck",
         "--volleys", "6", "--speed", "200", "--deg", "180"],
        env=os.environ)
    print(f"[volley] fake_puck exited rc={r.returncode}")
    return r.returncode

sys.exit(asyncio.run(main()))
