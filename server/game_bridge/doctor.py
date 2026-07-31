"""Doctor — one pass over the whole chain, with the fix for anything red.

Every failure we hit while getting a stock robot онboarded was diagnosable
from a fixed list of facts, but each time it cost a round of manual probing:
is wire-pod in escape-pod mode? does escapepod.local resolve? does :443 serve
the DDL cert? is the OTA cached? does the robot answer at all (and does he
answer on the SECOND try, since his Wi-Fi radio sleeps)? do we hold a cert and
a token for him? So: ask all of it at once, and print what to DO about each
answer rather than what is wrong.

    python -m game_bridge.doctor          # from server/
    curl -s localhost:8780/api/doctor     # same, as JSON

Read-only — it probes, it never changes anything.
"""
from __future__ import annotations

import configparser
import socket
import time
from pathlib import Path

from . import config


class Check:
    """One fact, its verdict, and the action that fixes it."""

    def __init__(self, name: str, ok: bool | None, detail: str, fix: str = ""):
        self.name = name
        self.ok = ok            # True / False / None = "not applicable yet"
        self.detail = detail
        self.fix = fix

    def as_dict(self) -> dict:
        return {"name": self.name, "ok": self.ok,
                "detail": self.detail, "fix": self.fix}


def _wirepod_checks() -> list[Check]:
    from .web import pairing
    out = []

    # Escape-pod mode needs a certificate AND its key. Only the certificate is
    # obvious when it's missing; without the key the engine simply fails to
    # bind :443 and every downstream check blames the mode instead.
    from onboarding import oskr_provision as prov
    ep_key = prov.EP_CERT.with_suffix(".key")
    have_pair = prov.EP_CERT.is_file() and ep_key.is_file()
    out.append(Check(
        "escape-pod certificate", have_pair,
        f"{prov.EP_CERT.parent}" if have_pair else
        f"missing {'certificate' if not prov.EP_CERT.is_file() else 'key'} in "
        f"{prov.EP_CERT.parent}",
        "" if have_pair else
        "Both ep.crt and ep.key must be present — the engine cannot serve the "
        "escape-pod identity without them, and every robot needs it."))

    st = pairing.wirepod_status(config.WIREPOD_URL)
    out.append(Check(
        "pairing engine running", st["up"],
        f"wire-pod at {config.WIREPOD_URL}" if st["up"] else st["detail"],
        "" if st["up"] else
        "cd server/onboarding/wire-pod/chipper && ./vectar-onboard"))
    if not st["up"]:
        return out
    out.append(Check(
        "escape-pod mode", st["ready"],
        st["detail"],
        "" if st["ready"] else
        "Set server.epconfig=true (port 443) in chipper/apiConfig.json and "
        "restart vectar-onboard. Every robot needs this mode: a stock one "
        "because his firmware hard-codes the name, a dev one because we point "
        "him at the same identity."))
    return out


def _ota_check() -> Check:
    for p in (Path(config.OTA_CACHE_DIR) / config.EP_OTA_NAME,
              Path(config.OTA_REPO_DIR) / config.EP_OTA_NAME):
        if not p.is_file():
            continue
        mb = p.stat().st_size / 1048576
        if p.stat().st_size < 1_000_000:
            # A Git LFS pointer, not the image. Serving it would hand the robot
            # 130 bytes of text and fail somewhere far away from the cause.
            return Check(
                "firmware image", False,
                f"{p} is a Git LFS pointer, not the image ({p.stat().st_size} B)",
                "Fetch it: git lfs install && git lfs pull")
        return Check("firmware image", True, f"{p} ({mb:.0f} MB)")
    return Check(
        "firmware image", None,
        "not on disk — it will be streamed from the Internet Archive",
        "Works, but slower and only while archive.org is up. For a local copy: "
        "git lfs pull, or drop the .ota into "
        f"{config.OTA_CACHE_DIR}/")


def _paired_serials() -> list[str]:
    cfg = configparser.ConfigParser(strict=False)
    try:
        cfg.read(config.SDK_CONFIG_PATH)
        return cfg.sections()
    except Exception:
        return []


def _identity_checks(want: str = "") -> tuple[list[Check], str, str]:
    """Credentials on disk. Returns (checks, serial, ip)."""
    serial, ips, name = config.read_robot_identity(want)
    ip = (ips.split(",")[0] or "").strip() if ips else ""
    if not serial:
        return ([Check(
            "robot paired", False,
            f"no robot in {config.SDK_CONFIG_PATH}",
            "Open http://localhost:%d and run PAIR ROBOT." % config.WEB_PORT)],
            "", "")

    checks = [Check("robot paired", True, f"{name or '?'} ({serial}) at {ip}")]
    cfg = configparser.ConfigParser(strict=False)
    try:
        cfg.read(config.SDK_CONFIG_PATH)
        sect = cfg[serial] if serial in cfg else None
    except Exception as e:
        sect = None
        checks.append(Check("sdk_config.ini readable", False, str(e),
                            "Delete it and re-pair."))
    if sect is not None:
        guid = sect.get("guid", "")
        checks.append(Check(
            "control token", bool(guid),
            "present" if guid else "missing",
            "" if guid else "Re-run PAIR ROBOT — authorize mints it."))
        cert_path = Path(sect.get("cert", ""))
        cert_ok = cert_path.is_file()
        checks.append(Check(
            "robot certificate", cert_ok,
            str(cert_path) if cert_ok else f"{cert_path} missing",
            "" if cert_ok else "Re-run PAIR ROBOT."))
        if cert_ok:
            # The CN must match the name we connect under; both rotate on a
            # factory reset, and a stale pair here is the classic silent fail.
            try:
                from cryptography import x509
                parsed = x509.load_pem_x509_certificate(cert_path.read_bytes())
                cn = ""
                for f in parsed.subject:
                    if "commonName" in str(f.oid):
                        cn = f.value
                match = (cn == name)
                checks.append(Check(
                    "certificate matches robot name", match,
                    f"cert CN={cn}, config name={name}",
                    "" if match else
                    "The robot was re-onboarded (name + cert rotate on a "
                    "wipe). Re-run PAIR ROBOT."))
            except Exception as e:
                checks.append(Check("certificate readable", False, str(e),
                                    "Re-run PAIR ROBOT."))
    return checks, serial, ip


def _robot_reachable(ip: str) -> Check:
    if not ip:
        return Check("robot reachable", None, "no IP known", "")
    from .robot.sdk.connection import _tcp_open
    t0 = time.monotonic()
    ok = _tcp_open(ip, tries=3)
    dt = time.monotonic() - t0
    if ok:
        note = f"{ip}:443 accepts ({dt:.1f}s)"
        if dt > 1.0:
            # Worth surfacing: it means the first probe was lost waking his
            # radio, which is exactly when a single-shot check lies.
            note += " — first probe was lost waking his Wi-Fi radio"
        return Check("robot reachable", True, note)
    return Check(
        "robot reachable", False, f"{ip}:443 did not answer in {dt:.1f}s",
        "He is asleep or his gateway is stuck. Pat him / press his backpack "
        "button. If he stays quiet, restart him: hold the button ~5 s until "
        "he switches off, then back on the charger.")


def _network_checks(robot_ip: str = "") -> list[Check]:
    """The questions an away-from-home setup gets wrong, asked out loud.

    Everything here was learned the expensive way: each check corresponds to a
    failure that took a live round of pairing to identify, and every one of
    them reported itself as something else entirely.
    """
    from . import netinfo
    out: list[Check] = []
    ip = netinfo.lan_ip()
    mask = netinfo._netmask_for(ip)
    out.append(Check(
        "this Mac's address", bool(ip),
        f"{ip}{f' / {mask}' if mask else ''}" if ip else "no outbound address",
        "" if ip else "No network at all — connect this Mac to Wi-Fi first."))
    if not ip:
        return out

    # The stale-announcement trap. Both .local names bind to the address they
    # saw at startup, so switching networks leaves them pointing at an address
    # that no longer exists — and the robot, told to go there, simply never
    # arrives. Nothing else in the system notices.
    for name, what in (("vectar.local", "lens name"),
                       ("escapepod.local", "pairing-engine name")):
        addrs = netinfo.resolves_to(name)
        if not addrs:
            out.append(Check(
                f"{what} ({name})", None, "does not resolve here",
                "Normal if that service is not running; if it is, restart it."))
        elif ip in addrs:
            out.append(Check(f"{what} ({name})", True, f"-> {ip}"))
        else:
            out.append(Check(
                f"{what} ({name})", False,
                f"-> {', '.join(addrs)}, but this Mac is now {ip}",
                "Announced before the network changed. Restart the service "
                "that owns this name (the game server for vectar.local, "
                "vectar-onboard for escapepod.local) so it re-announces."))

    if not robot_ip:
        return out

    same = netinfo.same_subnet(ip, robot_ip)
    if same is False:
        out.append(Check(
            "robot on this network", False,
            f"robot {robot_ip}, this Mac {ip}/{mask or '?'}",
            "Different networks — nothing can reach him from here. Either "
            "join the Mac to his network, or re-run the wizard and use JOIN A "
            "DIFFERENT NETWORK to move him to this one."))
        return out
    if same is None:
        out.append(Check("robot on this network", None,
                         f"cannot tell (robot {robot_ip}, mask unknown)", ""))

    rtt = netinfo.rtt_ms(robot_ip)
    if rtt is None:
        out.append(Check(
            "link to the robot", None, f"{robot_ip} did not answer ping",
            "He may be asleep — that alone is not a network fault."))
    elif rtt > netinfo.LAN_RTT_CEILING_MS:
        # The signature of a guest/corporate SSID: it answers, but the traffic
        # is relayed and client-to-client is usually blocked outright. The
        # robot cannot reach the pairing engine, and the error surfaces much
        # later as a token failure that blames the robot's firmware.
        out.append(Check(
            "link to the robot", False,
            f"{rtt:.0f} ms to {robot_ip} — a LAN hop is under "
            f"{netinfo.LAN_RTT_CEILING_MS:.0f} ms",
            "This looks like a guest or corporate network: it relays traffic "
            "and usually blocks devices from talking to each other, which is "
            "exactly what pairing needs. Use a phone hotspot for both the Mac "
            "and the robot."))
    else:
        out.append(Check("link to the robot", True, f"{rtt:.0f} ms to {robot_ip}"))
    return out


def _port_check(port: int, what: str) -> Check:
    s = socket.socket()
    s.settimeout(1.0)
    try:
        s.connect(("127.0.0.1", port))
        return Check(what, True, f"listening on :{port}")
    except Exception:
        return Check(what, False, f"nothing on :{port}",
                     "Start the game server: python -m game_bridge.main")
    finally:
        s.close()


def run(bridge=None) -> dict:
    """All checks. `bridge` (when called in-process) adds live link state."""
    checks: list[Check] = []
    # Network first, and deliberately so: when it is wrong, every check below
    # reports a symptom of it — a robot that "won't answer", an engine that
    # "has no certificate", a token that "failed". Reading those in that order
    # sends you after the wrong thing, which is exactly what happened.
    try:
        _, _first_ip, _ = config.read_robot_identity("")
    except Exception:
        _first_ip = ""
    checks += _network_checks((_first_ip or "").split(",")[0].strip())
    checks += _wirepod_checks()
    checks.append(_ota_check())
    # Every paired robot, not just the first one in the file. With a dev robot
    # set up alongside a stock one, reporting only the first meant the doctor
    # could say "1 problem" about a robot that is switched off on purpose while
    # staying silent about the one being played with.
    serials = _paired_serials()
    serial, ip = "", ""
    for i, s in enumerate(serials or [""]):
        ident, s_serial, s_ip = _identity_checks(s)
        if len(serials) > 1:
            _, _, s_name = config.read_robot_identity(s)
            tag = f" [{s_name or s_serial or '?'}]"
            ident = [Check(c.name + tag, c.ok, c.detail, c.fix) for c in ident]
        checks += ident
        r = _robot_reachable(s_ip)
        if len(serials) > 1:
            _, _, s_name = config.read_robot_identity(s)
            r = Check(r.name + f" [{s_name or s_serial or '?'}]",
                      r.ok, r.detail, r.fix)
        checks.append(r)
        if i == 0:
            serial, ip = s_serial, s_ip
    checks.append(_port_check(config.WS_PORT, "lens socket"))

    if bridge is not None:
        linked = bool(getattr(bridge, "robot_linked", False))
        alive = bool(getattr(bridge, "robot_alive", False))
        if alive:
            checks.append(Check("robot link", True, "connected, control held"))
        elif linked:
            # Don't call this ok: the link is up but he isn't sending poses,
            # and the goalie cannot move without them. Brief gaps are normal
            # (an animation owns the motors); a persistent one is not.
            age = getattr(bridge, "pose_age", 0.0)
            checks.append(Check(
                "robot link", None,
                f"connected, but no pose for {age:.0f}s",
                "Normal for a moment during an animation. If it stays this "
                "way he is not streaming: press RELEASE CONTROL then CONNECT "
                "ROBOT, and restart him if that doesn't restore it."))
        else:
            checks.append(Check(
                "robot link", False, "not connected",
                getattr(bridge, "last_link_hint", "")
                or "Press CONNECT ROBOT on the dashboard."))
        lens = bool(getattr(bridge.ws, "alive", False))
        checks.append(Check(
            "lens connected", None if not lens else True,
            "yes" if lens else "no lens (fine unless you're playing in the "
            "glasses)", ""))

    # Don't let a downstream check argue with the cause. When the robot is
    # demonstrably on another network, "he did not answer" is true but its
    # advice — pat him, restart him — sends people to the wrong end of the
    # problem, and having both on screen at once is worse than either alone.
    if any(c.ok is False and c.name.startswith("robot on this network")
           for c in checks):
        for c in checks:
            if c.name.startswith("robot reachable") and c.ok is False:
                c.fix = ("Expected — he is on another network (see above). "
                         "Nothing here can reach him until he joins this one.")

    bad = [c for c in checks if c.ok is False]
    return {
        "ok": not bad,
        "summary": ("everything ready" if not bad else
                    f"{len(bad)} problem(s): "
                    + ", ".join(c.name for c in bad)),
        "checks": [c.as_dict() for c in checks],
    }


def main() -> int:
    res = run()
    mark = {True: "  ok  ", False: " FAIL ", None: " --   "}
    print()
    for c in res["checks"]:
        print(f"[{mark[c['ok']]}] {c['name']}: {c['detail']}")
        if c["fix"]:
            print(f"          -> {c['fix']}")
    print(f"\n{res['summary']}\n")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
