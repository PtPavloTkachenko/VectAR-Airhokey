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
    python -m onboarding.oskr_provision --ip <robot-ip> --key ~/.vectar/id_rsa_robot
    python -m onboarding.oskr_provision --ip <robot-ip> --host-mode ip   # direct Mac IP

`--host-mode auto` (default) matches whatever the pairing engine is actually
serving, so the robot is pointed at a name he can reach AND handed the
certificate he will be shown. `escapepod` and `ip` force one or the other.

Prefer the escape-pod identity: it is network-agnostic and survives the Mac
taking a new DHCP lease, because the name is answered live over mDNS. Pinning
an IP looks simpler and then quietly rots the day the lease changes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import socket
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent

# The two identities wire-pod can serve on :443. WHICH one it serves depends on
# the mode it runs in, and the robot only trusts the CA we install here — so
# picking the wrong file points him at a server whose certificate he refuses.
# Escape-pod mode (what a stock robot needs, so what we run) serves the
# well-known Digital Dream Labs certificate; upstream's own SSH provisioning
# makes the same choice (chipper/pkg/wirepod/setup/ssh.go, `if EPConfig`).
WIREPOD_CERT = REPO / "wire-pod" / "certs" / "cert.crt"       # CN=wirepod.local
EP_CERT = REPO / "wire-pod" / "chipper" / "epod" / "ep.crt"   # CN=escapepod.local

# Paths on the robot (verified on a live 2.0.1.6091 unit)
ROBOT_SERVER_CONFIG = (
    "/anki/data/assets/cozmo_resources/config/server_config.json")
ROBOT_CERT = "/anki/etc/wirepod-cert.crt"

SSH_OPTS = [
    # Without this, ssh's "Permanently added ... to the list of known hosts"
    # lands in the same stream as the robot's answer and gets parsed as data.
    "-o", "LogLevel=ERROR",
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


def engine_mode(pod: str = "") -> str:
    """Which identity wire-pod is serving right now: 'escapepod' or 'ip'.

    Probed, not read from config — the mode only counts if it's actually live on
    :443, and that's exactly what the robot will meet.
    """
    try:
        from game_bridge import config as gconfig
        from game_bridge.web import pairing
    except Exception:
        return "ip"
    try:
        st = pairing.wirepod_status(pod or gconfig.WIREPOD_URL)
    except Exception:
        return "ip"
    return "escapepod" if st.get("ready") else "ip"


def trust_anchor(host_mode: str) -> tuple[str, Path]:
    """(name to point the robot at, CA file to install on him).

    These two travel together. Escape-pod mode answers to `escapepod.local` with
    the DDL certificate; the other mode answers on this Mac's IP with wire-pod's
    self-signed one. Mixing them — the old behaviour, which always installed the
    self-signed cert — hands the robot a name he can reach and a certificate he
    refuses, so his cloud handshake never completes and no token is ever minted.
    """
    if host_mode == "escapepod":
        return "escapepod.local", EP_CERT
    return lan_ip(), WIREPOD_CERT


def server_config(host_mode: str) -> str:
    """The jdoc wire-pod expects. `check` is http (no :443), the rest are TLS."""
    host, _ = trust_anchor(host_mode)
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


def extract_key_and_name(bundle: bytes) -> tuple[str | None, str | None]:
    """Pull the private key AND the robot's short code out of a log bundle.

    The key lives at `data/ssh/id_rsa_Vector-XXXX`; the `XXXX` identifies the
    robot, which lets us find him on the LAN by mDNS (`discovery.discover`)
    without a BLE session — the whole point of the archive-upload path. Returns
    (key_text, robot_code) with robot_code like "A1B2" (or None if not parseable).
    """
    import io
    import re
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
                    if "PRIVATE KEY" not in data:
                        continue
                    mm = re.search(r"Vector[-_ ]?([A-Za-z0-9]{4})", base)
                    return data, (mm.group(1) if mm else None)
        except tarfile.TarError:
            continue
    return None, None


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


def _ssh_probe(ip: str, key: str, connect_timeout: int = 3) -> bool:
    """Fast, quiet 'does this host accept our key?' probe for subnet scanning.
    Uses a short ConnectTimeout (the normal 25 s is far too slow for a /24)."""
    p = subprocess.run(
        ["ssh", "-i", key,
         "-o", f"ConnectTimeout={connect_timeout}",
         "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
         "-o", "HostkeyAlgorithms=+ssh-rsa",
         "-o", "StrictHostKeyChecking=no",
         "-o", "UserKnownHostsFile=/dev/null",
         "-o", "BatchMode=yes",
         f"root@{ip}", "echo ok"],
        capture_output=True, text=True)
    return p.returncode == 0 and "ok" in p.stdout


def find_robot_ip(key: str) -> str | None:
    """Auto-locate the robot on the LAN with NO mDNS: the robot is simply the
    host that accepts our SSH key. Ping-sweep this Mac's /24, then SSH-probe the
    live hosts in parallel and return the first that authenticates. This is the
    fallback for repeater/mesh Wi-Fi where mDNS multicast is dropped.
    """
    import concurrent.futures
    import ipaddress

    base = lan_ip()
    if not base:
        return None
    try:
        net = ipaddress.ip_network(f"{base}/24", strict=False)
    except ValueError:
        return None
    hosts = [str(h) for h in net.hosts()]

    def ping(ip: str) -> str | None:
        r = subprocess.run(["ping", "-c", "1", "-W", "700", ip],
                           capture_output=True)
        return ip if r.returncode == 0 else None

    live: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=64) as ex:
        for res in ex.map(ping, hosts):
            if res:
                live.append(res)
    # Probe the Mac's own IP last-ish is irrelevant; just scan live hosts.
    with concurrent.futures.ThreadPoolExecutor(max_workers=24) as ex:
        futs = {ex.submit(_ssh_probe, ip, key): ip for ip in live}
        for fut in concurrent.futures.as_completed(futs):
            try:
                if fut.result():
                    return futs[fut]
            except Exception:
                pass
    return None


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


def _write_host_pin(ip: str, key: str, host: str) -> None:
    """Point `host` at this Mac's current address in the robot's /etc/hosts.

    Both halves of this matter. Leaving an OLD pin is how the robot spent weeks
    talking to an address nobody answers on: the Mac took a new DHCP lease,
    /etc/hosts is consulted before mDNS, and resolution kept "succeeding". But
    having no pin is worse — for the first seconds after boot the name does not
    resolve at all while avahi comes up, and vic-cloud does not survive that: a
    failed lookup returns nil, it dereferences it, and the process dies with
    fault 923 before anything can be minted. So: strip whatever is there and
    write today's address, every run.

    Assumes the caller holds the rootfs rw.
    """
    if not host.endswith(".local"):
        # An IP target needs no name at all; just clear stale pins.
        ssh(ip, key, "grep -vE '(wirepod|escapepod)\\.local' /etc/hosts "
                     "> /tmp/h; cat /tmp/h > /etc/hosts; rm -f /tmp/h")
        return
    ssh(ip, key,
        "grep -vE '(wirepod|escapepod)\\.local' /etc/hosts > /tmp/h; "
        f"echo '{lan_ip()} {host}' >> /tmp/h; "
        "cat /tmp/h > /etc/hosts; rm -f /tmp/h")


def refresh_host_pin(ip: str, key: str, host: str) -> str:
    """_write_host_pin on a robot we are not otherwise touching. Returns note."""
    _, cur = ssh(ip, key, f"grep -E '{host}' /etc/hosts 2>/dev/null | head -1")
    want = f"{lan_ip()} {host}"
    if cur.strip() == want:
        return ""
    rc, out = ssh(ip, key, "mount -o remount,rw / && echo RW_OK")
    if "RW_OK" not in out:
        return "could not refresh the host pin (rootfs stayed read-only)"
    try:
        _write_host_pin(ip, key, host)
    finally:
        ssh(ip, key, "mount -o remount,ro /")
    return f"host pin -> {want}"


def quiet_cloud_uploaders(ip: str, key: str) -> str:
    """Stop the robot from killing his own cloud process. Returns what changed.

    Chain seen live on 2026-07-25, and it feeds itself:

      the robot queues a fault report -> something asks him to upload it ->
      the log collector asks vic-cloud for STS credentials -> vic-cloud can't
      resolve its token server for a moment -> the failed lookup returns nil
      and vic-cloud dereferences it -> SIGSEGV, vic-cloud dead -> the robot
      raises fault 923 and queues ANOTHER report.

    With vic-cloud dead the gateway still accepts connections but never answers
    an authentication call, so minting hangs with no error. The uploaders exist
    to ship logs to an Anki S3 bucket that has been gone for years, so nothing
    is lost by stopping them, and the queued reports are what keeps re-arming
    the crash.
    """
    changed = []
    _, queued = ssh(ip, key, "ls /data/fault-reports/ 2>/dev/null | wc -l")
    if (queued.strip() or "0") != "0":
        ssh(ip, key, "rm -f /data/fault-reports/*")
        changed.append(f"cleared {queued.strip()} queued fault report(s)")
    # Mask, not disable: these units are pulled in by anki-robot.target, so
    # `disable` leaves them startable.
    #
    # Masking writes a symlink into /etc/systemd/system, which lives on the
    # READ-ONLY rootfs. Without opening a write window the command reports
    # success, changes nothing, and the units come back enabled after every
    # reboot — which is exactly what we saw: "masked" printed on every run and
    # fault 923 returning anyway.
    todo = []
    for unit in ("vic-log-uploader", "vic-crashuploader"):
        _, state = ssh(ip, key, f"systemctl is-enabled {unit} 2>/dev/null")
        if "masked" not in state:
            todo.append(unit)
    if todo:
        _, out = ssh(ip, key, "mount -o remount,rw / && echo RW_OK")
        if "RW_OK" not in out:
            changed.append("could not mask the uploaders (rootfs read-only)")
        else:
            try:
                for unit in todo:
                    ssh(ip, key, f"systemctl stop {unit} 2>/dev/null; "
                                 f"systemctl mask {unit} 2>/dev/null")
                    _, state = ssh(ip, key,
                                   f"systemctl is-enabled {unit} 2>/dev/null")
                    changed.append(
                        f"masked {unit}" if "masked" in state
                        else f"FAILED to mask {unit} ({state.strip()})")
            finally:
                ssh(ip, key, "mount -o remount,ro /")
    _, alive = ssh(ip, key, "pgrep vic-cloud >/dev/null && echo UP || echo DOWN")
    if "DOWN" in alive:
        ssh(ip, key, "systemctl reset-failed vic-cloud; systemctl start vic-cloud")
        changed.append("restarted vic-cloud")
    return ", ".join(changed)


def provision(ip: str, key: str, host_mode: str, reboot: bool = True) -> None:
    rc, out = ssh(ip, key, "cat /anki/etc/version; cat /proc/cmdline | tr ' ' '\\n' | grep -c anki.dev")
    if rc != 0:
        raise SystemExit(
            f"SSH to {ip} failed: {out}\n"
            "If the key was wiped by Clear User Data, restore it first "
            "(OSKR units expose adbd: adb connect <ip>:5555, then write the "
            "pubkey into /data/ssh/authorized_keys).")
    print(f"robot: {out.splitlines()[0]}  (anki.dev markers: {out.splitlines()[-1]})")

    if host_mode == "auto":
        host_mode = engine_mode()
        print(f"pairing engine is in '{host_mode}' mode")
    host, ca = trust_anchor(host_mode)
    if not ca.is_file():
        raise SystemExit(
            f"the certificate to install is missing: {ca}\n"
            + ("Escape-pod mode serves the Digital Dream Labs certificate; it "
               "ships with wire-pod under chipper/epod/."
               if host_mode == "escapepod" else
               "Start vectar-onboard once so it generates certs/cert.crt."))
    cfg = server_config(host_mode)
    target_chipper = json.loads(cfg)["chipper"]
    print(f"server_config -> {target_chipper}   CA -> {ca.name}")

    # Idempotent: if he already points at wire-pod with the RIGHT cert in place,
    # don't rewrite + reboot — a needless ~40 s round-trip that looks like a
    # loop. This is the common case for a robot we set up earlier.
    #
    # "the right cert", not merely "a cert": a robot provisioned before the
    # engine moved to escape-pod mode carries the self-signed one, which he now
    # refuses on every handshake. Treating that as done left him permanently
    # unmintable while every check said he was set up.
    rc, cur = ssh(ip, key, f"cat {ROBOT_SERVER_CONFIG} 2>/dev/null")
    same_cloud = False
    if rc == 0 and cur.strip():
        try:
            same_cloud = json.loads(cur).get("chipper", "") == target_chipper
        except Exception:
            same_cloud = False
    want = hashlib.sha256(ca.read_bytes()).hexdigest()
    _, have = ssh(ip, key, f"sha256sum {ROBOT_CERT} 2>/dev/null | cut -d' ' -f1")
    if same_cloud and have.strip() == want:
        print("already pointed at wire-pod with the matching certificate — "
              "nothing to change, no reboot.")
        # Still worth doing: a robot who is pointed correctly can be sitting in
        # the vic-cloud crash loop, which looks identical from the outside and
        # makes minting hang rather than fail. And the Mac may have moved since
        # he was set up, which the pin has to follow.
        notes = [n for n in (refresh_host_pin(ip, key, host),
                             quiet_cloud_uploaders(ip, key)) if n]
        if notes:
            print("cloud health: " + ", ".join(notes))
        return "already"
    if same_cloud and have.strip():
        print("cloud already points at wire-pod, but the installed certificate "
              "is not the one being served — replacing it.")

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
        put(ip, key, ca.read_text(), ROBOT_CERT, "0644")

        _write_host_pin(ip, key, host)

        rc, out = ssh(ip, key,
                      f"cat {ROBOT_SERVER_CONFIG} | head -c 120; echo; "
                      f"wc -c < {ROBOT_CERT}")
        print(f"verify on-robot:\n{out}")
    finally:
        ssh(ip, key, "mount -o remount,ro /")
        print("rootfs back to ro")

    fixed = quiet_cloud_uploaders(ip, key)
    if fixed:
        print(f"cloud health: {fixed}")

    if reboot:
        print("rebooting the robot to pick up the new cloud config…")
        # The reboot drops the SSH connection, so this command "times out" —
        # that IS success, not a failure. Swallow it.
        try:
            ssh(ip, key, "sync; (sleep 1; reboot) &", timeout=12)
        except subprocess.TimeoutExpired:
            pass
        except Exception:
            pass
        print("done — wait ~40 s, then run the pairing wizard "
              "(wire-pod must be running).")
    return "provisioned"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ip", required=True, help="robot LAN IP")
    ap.add_argument("--key", default="/tmp/vector_key", help="ssh private key")
    ap.add_argument("--host-mode", choices=("auto", "escapepod", "ip"),
                    default="auto",
                    help="auto: match whatever the pairing engine is serving "
                         "(default). escapepod: escapepod.local + the DDL "
                         "certificate. ip: this Mac's LAN IP + wire-pod's "
                         "self-signed certificate")
    ap.add_argument("--no-reboot", action="store_true")
    a = ap.parse_args()
    provision(a.ip, a.key, a.host_mode, reboot=not a.no_reboot)
    return 0


if __name__ == "__main__":
    sys.exit(main())
