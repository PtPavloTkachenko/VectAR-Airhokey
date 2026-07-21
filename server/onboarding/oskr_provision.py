"""OSKR / dev-robot provisioning — point the robot's cloud at wire-pod over SSH.

The counterpart to the stock path (escape-pod firmware flash over BLE). An OSKR
robot (`ankidev` firmware) doesn't need a flash: we can just write the two files
that make it trust and talk to wire-pod, exactly what upstream wire-pod's
`setup/ssh.go` does:

  1. `server_config.json` -> jdocs/tms/chipper/check at wire-pod
  2. `wirepod-cert.crt`   -> the TLS cert wire-pod serves

After this the robot reaches wire-pod on ANY Wi-Fi (escapepod.local is resolved
over mDNS), so `cloud_auth` / `UserAuthentication` mint the SDK guid locally and
the pairing wizard completes.

Both files live on the read-only rootfs, so we remount rw, write, remount ro,
and reboot (never a live service restart — that races vic-engine, see the
project's 915-fault lesson).

Usage:
    python -m onboarding.oskr_provision --ip 172.20.10.2 --key /tmp/vector_key
    python -m onboarding.oskr_provision --ip 172.20.10.2 --host-mode ip   # direct Mac IP

`--host-mode escapepod` (default) is network-agnostic: it survives the Mac
changing IP as long as wire-pod publishes escapepod.local. `--host-mode ip`
pins the current LAN IP — more reliable on networks with flaky mDNS.
"""
from __future__ import annotations

import argparse
import json
import shlex
import socket
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
WIREPOD_CERT = REPO / "wire-pod" / "certs" / "cert.crt"

# Paths on the robot (verified on a live 2.0.1.6091 unit)
ROBOT_SERVER_CONFIG = (
    "/anki/data/assets/cozmo_resources/config/server_config.json")
ROBOT_CERT = "/anki/etc/wirepod-cert.crt"

SSH_OPTS = [
    "-o", "ConnectTimeout=25",
    "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
    "-o", "HostkeyAlgorithms=+ssh-rsa",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
]


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def server_config(host_mode: str) -> str:
    """The jdoc wire-pod expects. `check` is http (no :443), the rest are TLS."""
    host = "escapepod.local" if host_mode == "escapepod" else lan_ip()
    return json.dumps({
        "jdocs": f"{host}:443",
        "tms": f"{host}:443",
        "chipper": f"{host}:443",
        "check": f"{host}/ok",
        "logfiles": "s3://anki-device-logs-prod/victor",
        "appkey": "oDoa0quieSeir6goowai7f",
    })


def extract_ssh_key(bundle: bytes) -> str | None:
    """Pull the robot's OWN SSH private key out of its log bundle.

    An OSKR robot generates a keypair in /data/ssh and ships it inside the logs
    — this is the documented way owners get shell access, and where our original
    key came from. Handles the bundle being a plain tar or gz/bz2/xz-compressed.
    """
    import io
    import tarfile

    for opener in ("r:*", "r"):
        try:
            with tarfile.open(fileobj=io.BytesIO(bundle), mode=opener) as tf:
                for member in tf.getmembers():
                    name = member.name.replace("\\", "/")
                    if "/ssh/" not in f"/{name}" and not name.startswith("ssh/"):
                        continue
                    base = name.rsplit("/", 1)[-1]
                    if not base.startswith("id_") or base.endswith(".pub"):
                        continue
                    f = tf.extractfile(member)
                    if not f:
                        continue
                    data = f.read().decode("utf-8", "replace")
                    if "PRIVATE KEY" in data:
                        return data
        except tarfile.TarError:
            continue
    return None


def save_ssh_key(key_text: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not key_text.endswith("\n"):
        key_text += "\n"
    dest.write_text(key_text)
    dest.chmod(0o600)
    return dest


def ssh_reachable(ip: str, key: str) -> bool:
    """True if this key already opens a root shell on the robot."""
    p = subprocess.run(
        ["ssh", "-i", key, *SSH_OPTS, "-o", "BatchMode=yes",
         f"root@{ip}", "echo ok"],
        capture_output=True, text=True)
    return p.returncode == 0 and "ok" in p.stdout


def ssh(ip: str, key: str, cmd: str, timeout: int = 60) -> tuple[int, str]:
    p = subprocess.run(
        ["ssh", "-i", key, *SSH_OPTS, f"root@{ip}", cmd],
        capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


def put(ip: str, key: str, content: str, dest: str, mode: str = "0644") -> None:
    """Write a file on the robot via stdin (scp is unreliable on this unit)."""
    p = subprocess.run(
        ["ssh", "-i", key, *SSH_OPTS, f"root@{ip}",
         f"cat > {shlex.quote(dest)} && chmod {mode} {shlex.quote(dest)}"],
        input=content, capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise RuntimeError(f"write {dest} failed: {p.stderr.strip()}")


def provision(ip: str, key: str, host_mode: str, reboot: bool = True) -> None:
    rc, out = ssh(ip, key, "cat /anki/etc/version; cat /proc/cmdline | tr ' ' '\\n' | grep -c anki.dev")
    if rc != 0:
        raise SystemExit(
            f"SSH to {ip} failed: {out}\n"
            "If the key was wiped by Clear User Data, restore it first "
            "(OSKR units expose adbd: adb connect <ip>:5555, then write the "
            "pubkey into /data/ssh/authorized_keys).")
    print(f"robot: {out.splitlines()[0]}  (anki.dev markers: {out.splitlines()[-1]})")
    if not WIREPOD_CERT.is_file():
        raise SystemExit(f"wire-pod cert not found at {WIREPOD_CERT} — start "
                         "vectar-onboard once so it generates certs/cert.crt")
    cfg = server_config(host_mode)
    print(f"server_config -> {json.loads(cfg)['chipper']}")

    # rootfs is ro; open one rw window for both writes.
    rc, out = ssh(ip, key, "mount -o remount,rw / && echo RW_OK")
    if "RW_OK" not in out:
        raise SystemExit(f"could not remount rootfs rw: {out}")
    try:
        # keep the factory original once, so this stays reversible
        ssh(ip, key,
            f"[ -f {ROBOT_SERVER_CONFIG}.bak ] || cp {ROBOT_SERVER_CONFIG} "
            f"{ROBOT_SERVER_CONFIG}.bak")
        put(ip, key, cfg, ROBOT_SERVER_CONFIG, "0644")
        put(ip, key, WIREPOD_CERT.read_text(), ROBOT_CERT, "0644")
        rc, out = ssh(ip, key,
                      f"cat {ROBOT_SERVER_CONFIG} | head -c 120; echo; "
                      f"wc -c < {ROBOT_CERT}")
        print(f"verify on-robot:\n{out}")
    finally:
        ssh(ip, key, "mount -o remount,ro /")
        print("rootfs back to ro")

    if reboot:
        print("rebooting the robot to pick up the new cloud config…")
        ssh(ip, key, "sync; (sleep 1; reboot) &", timeout=15)
        print("done — wait ~40 s, then run the pairing wizard "
              "(wire-pod must be running).")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ip", required=True, help="robot LAN IP")
    ap.add_argument("--key", default="/tmp/vector_key", help="ssh private key")
    ap.add_argument("--host-mode", choices=("escapepod", "ip"),
                    default="escapepod",
                    help="point the robot at escapepod.local (mDNS, portable) "
                         "or this Mac's current LAN IP (pinned)")
    ap.add_argument("--no-reboot", action="store_true")
    a = ap.parse_args()
    provision(a.ip, a.key, a.host_mode, reboot=not a.no_reboot)
    return 0


if __name__ == "__main__":
    sys.exit(main())
