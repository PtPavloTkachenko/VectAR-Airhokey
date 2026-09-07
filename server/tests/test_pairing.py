"""Unit tests for the pairing core — no robot, no wire-pod, no network."""
import configparser

import pytest

from game_bridge.web import pairing
from game_bridge.web.pairing import PairingError


# --- standardize_name ---

@pytest.mark.parametrize("raw,expected", [
    ("Vector-A1B2", "Vector-A1B2"),
    ("vector-a1b2", "Vector-A1B2"),
    ("a1b2", "Vector-A1B2"),
    ("  Vector-Z9Y8  ", "Vector-Z9Y8"),
])
def test_standardize_name(raw, expected):
    assert pairing.standardize_name(raw) == expected


def test_standardize_name_rejects_garbage():
    with pytest.raises(PairingError) as e:
        pairing.standardize_name("robot")
    assert e.value.step == pairing.STEP_CERT


# --- fetch_cert ---

class _Resp:
    def __init__(self, status_code, content=b""):
        self.status_code = status_code
        self.content = content


def test_fetch_cert_404(monkeypatch):
    import requests
    monkeypatch.setattr(requests, "get", lambda url, timeout: _Resp(404))
    with pytest.raises(PairingError) as e:
        pairing.fetch_cert("localhost:8080", "00e20145")
    assert e.value.step == pairing.STEP_CERT
    assert "serial" in e.value.message


def test_fetch_cert_unreachable(monkeypatch):
    import requests

    def boom(url, timeout):
        raise OSError("no route")
    monkeypatch.setattr(requests, "get", boom)
    with pytest.raises(PairingError) as e:
        pairing.fetch_cert("badhost:8080", "00e20145")
    assert e.value.step == pairing.STEP_CERT


def test_fetch_cert_ok(monkeypatch):
    import requests
    pem = b"-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n"
    seen = {}

    def fake_get(url, timeout):
        seen["url"] = url
        return _Resp(200, pem)
    monkeypatch.setattr(requests, "get", fake_get)
    out = pairing.fetch_cert("localhost:8080", "00e20145")
    assert out == pem
    assert seen["url"] == "http://localhost:8080/session-certs/00e20145"


# --- pair() composition + config writing ---

@pytest.fixture
def anki_dir(tmp_path, monkeypatch):
    d = tmp_path / ".anki_vector"
    monkeypatch.setattr(pairing, "ANKI_DIR", d)
    return d


@pytest.fixture(autouse=True)
def no_robot(monkeypatch):
    """Never touch a real robot: no engine to ask, every key accepted.

    Tests that care about key selection override these."""
    monkeypatch.setattr(pairing, "pod_guid", lambda pod, serial: b"")
    monkeypatch.setattr(pairing, "guid_works",
                        lambda cert, ip, name, guid, timeout=12.0: True)


def test_pair_happy_path(monkeypatch, anki_dir):
    pem = b"-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n"
    monkeypatch.setattr(pairing, "fetch_cert", lambda pod, serial, wait=0.0, on_wait=None: pem)
    monkeypatch.setattr(pairing, "validate_cert_name", lambda cert, name: None)
    monkeypatch.setattr(pairing, "mint_guid", lambda cert, ip, name: b"guid-123")

    out = pairing.pair("localhost:8080", "00E20145", "vector-a1b2",
                       " 192.168.1.42 ")
    assert out["serial"] == "00e20145"
    assert out["name"] == "Vector-A1B2"
    assert out["ip"] == "192.168.1.42"

    cfg = configparser.ConfigParser(strict=False)
    cfg.read(anki_dir / "sdk_config.ini")
    sect = cfg["00e20145"]
    assert sect["guid"] == "guid-123"
    assert sect["ip"] == "192.168.1.42"
    assert sect["name"] == "Vector-A1B2"
    cert_file = anki_dir / "Vector-A1B2-00e20145.cert"
    assert cert_file.read_bytes() == pem
    assert sect["cert"] == str(cert_file)


def test_pair_preserves_other_sections(monkeypatch, anki_dir):
    anki_dir.mkdir(parents=True)
    (anki_dir / "sdk_config.ini").write_text(
        "[11111111]\ncert = /x.cert\nip = 10.0.0.5\nname = Vector-Q1Q1\n"
        "guid = old-guid\n")
    pem = b"-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n"
    monkeypatch.setattr(pairing, "fetch_cert", lambda pod, serial, wait=0.0, on_wait=None: pem)
    monkeypatch.setattr(pairing, "validate_cert_name", lambda cert, name: None)
    monkeypatch.setattr(pairing, "mint_guid", lambda cert, ip, name: b"new-guid")

    pairing.pair("localhost:8080", "22222222", "Vector-B2B2", "10.0.0.6")
    cfg = configparser.ConfigParser(strict=False)
    cfg.read(anki_dir / "sdk_config.ini")
    assert cfg["11111111"]["guid"] == "old-guid"
    assert cfg["22222222"]["guid"] == "new-guid"


def test_pair_requires_serial_and_ip(monkeypatch, anki_dir):
    with pytest.raises(PairingError):
        pairing.pair("localhost:8080", "", "Vector-A1B2", "10.0.0.5")
    with pytest.raises(PairingError):
        pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "")


def test_pair_propagates_mint_failure(monkeypatch, anki_dir):
    pem = b"-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n"
    monkeypatch.setattr(pairing, "fetch_cert", lambda pod, serial, wait=0.0, on_wait=None: pem)
    monkeypatch.setattr(pairing, "validate_cert_name", lambda cert, name: None)

    def fail(cert, ip, name):
        raise PairingError(pairing.STEP_AUTH, "robot said no")
    monkeypatch.setattr(pairing, "mint_guid", fail)
    with pytest.raises(PairingError) as e:
        pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "10.0.0.5")
    assert e.value.step == pairing.STEP_AUTH
    # nothing must be written on failure
    assert not (anki_dir / "sdk_config.ini").exists()


# --- the engine can never get a cert for a robot set up once before ---
# Only a PRIMARY association carries the certificate, and a robot only ever
# makes one. So every re-onboarded robot 404s forever unless we read it off
# the robot himself. See pairing.fetch_cert_from_robot.

def _pod_has_no_cert(pod, serial, wait=0.0, on_wait=None):
    raise PairingError(pairing.STEP_CERT, "wire-pod has no certificate")


def test_pair_falls_back_to_the_robots_own_cert(monkeypatch, anki_dir):
    pem = b"-----BEGIN CERTIFICATE-----\nfromrobot\n-----END CERTIFICATE-----\n"
    stored = {}
    monkeypatch.setattr(pairing, "fetch_cert", _pod_has_no_cert)
    monkeypatch.setattr(pairing, "fetch_cert_from_robot",
                        lambda ip, timeout=10.0: pem)
    monkeypatch.setattr(pairing, "store_cert",
                        lambda serial, cert: stored.update(
                            {"serial": serial, "cert": cert}) or True)
    monkeypatch.setattr(pairing, "validate_cert_name", lambda cert, name: None)
    monkeypatch.setattr(pairing, "mint_guid", lambda cert, ip, name: b"g")

    out = pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "10.0.0.5")
    assert out["serial"] == "00e20145"
    # and it is handed to the engine, so the next run takes the normal path
    assert stored == {"serial": "00e20145", "cert": pem}
    assert (anki_dir / "Vector-A1B2-00e20145.cert").read_bytes() == pem


def test_pair_does_not_mask_a_non_cert_failure(monkeypatch, anki_dir):
    def boom(pod, serial, wait=0.0, on_wait=None):
        raise PairingError(pairing.STEP_TLS, "unreachable")
    monkeypatch.setattr(pairing, "fetch_cert", boom)
    monkeypatch.setattr(pairing, "fetch_cert_from_robot",
                        lambda ip, timeout=10.0: pytest.fail("must not run"))
    with pytest.raises(PairingError) as e:
        pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "10.0.0.5")
    assert e.value.step == pairing.STEP_TLS


def test_pair_replaces_a_pre_rename_cert(monkeypatch, anki_dir):
    """A cert minted under his old name can only be replaced by a primary
    association he will never make again — so replace it from the robot."""
    old = b"-----BEGIN CERTIFICATE-----\nold\n-----END CERTIFICATE-----\n"
    new = b"-----BEGIN CERTIFICATE-----\nnew\n-----END CERTIFICATE-----\n"
    monkeypatch.setattr(pairing, "fetch_cert",
                        lambda pod, serial, wait=0.0, on_wait=None: old)
    monkeypatch.setattr(pairing, "fetch_cert_from_robot",
                        lambda ip, timeout=10.0: new)
    monkeypatch.setattr(pairing, "store_cert", lambda serial, cert: True)

    def validate(cert, name):
        if cert == old:
            raise pairing.StaleCertError(pairing.STEP_CERT, "old name")
    monkeypatch.setattr(pairing, "validate_cert_name", validate)
    monkeypatch.setattr(pairing, "mint_guid", lambda cert, ip, name: b"g")

    pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "10.0.0.5")
    assert (anki_dir / "Vector-A1B2-00e20145.cert").read_bytes() == new


# --- which key gets written -------------------------------------------------
# The engine registers a key's hash in the robot's vic.AppTokens jdoc on the
# FIRST association only, so a re-onboarded robot mints keys he then refuses.
# pair() must write the key that WORKS, not the one most recently minted.

def _plain(monkeypatch):
    pem = b"-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n"
    monkeypatch.setattr(pairing, "fetch_cert",
                        lambda pod, serial, wait=0.0, on_wait=None: pem)
    monkeypatch.setattr(pairing, "validate_cert_name", lambda cert, name: None)
    return pem


def _read_guid(anki_dir):
    cfg = configparser.ConfigParser(strict=False)
    cfg.read(anki_dir / "sdk_config.ini")
    return cfg["00e20145"]["guid"]


def test_pair_prefers_the_engine_key_when_the_robot_refuses_his_own(
        monkeypatch, anki_dir):
    _plain(monkeypatch)
    monkeypatch.setattr(pairing, "mint_guid", lambda cert, ip, name: b"minted")
    monkeypatch.setattr(pairing, "pod_guid", lambda pod, serial: b"engine")
    monkeypatch.setattr(
        pairing, "guid_works",
        lambda cert, ip, name, guid, timeout=12.0: guid == b"engine")

    pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "10.0.0.5")
    assert _read_guid(anki_dir) == "engine"


def test_pair_keeps_the_robots_key_when_he_honours_it(monkeypatch, anki_dir):
    _plain(monkeypatch)
    monkeypatch.setattr(pairing, "mint_guid", lambda cert, ip, name: b"minted")
    monkeypatch.setattr(pairing, "pod_guid", lambda pod, serial: b"engine")
    monkeypatch.setattr(pairing, "guid_works",
                        lambda cert, ip, name, guid, timeout=12.0: True)

    pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "10.0.0.5")
    assert _read_guid(anki_dir) == "minted"


def test_pair_uses_the_engine_key_when_the_robot_issues_none(
        monkeypatch, anki_dir):
    """A dev robot reports success and hands back an empty key."""
    _plain(monkeypatch)
    monkeypatch.setattr(pairing, "mint_guid", lambda cert, ip, name: b"")
    monkeypatch.setattr(pairing, "pod_guid", lambda pod, serial: b"engine")
    monkeypatch.setattr(pairing, "guid_works",
                        lambda cert, ip, name, guid, timeout=12.0: True)

    pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "10.0.0.5")
    assert _read_guid(anki_dir) == "engine"


def test_pair_refuses_to_write_a_key_the_robot_rejects(monkeypatch, anki_dir):
    """Writing an unverified key is what produced a 'successful' pairing
    followed by a bare 401 on every later connection."""
    _plain(monkeypatch)
    monkeypatch.setattr(pairing, "mint_guid", lambda cert, ip, name: b"minted")
    monkeypatch.setattr(pairing, "pod_guid", lambda pod, serial: b"engine")
    monkeypatch.setattr(pairing, "guid_works",
                        lambda cert, ip, name, guid, timeout=12.0: False)

    with pytest.raises(PairingError) as e:
        pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "10.0.0.5")
    assert e.value.step == pairing.STEP_AUTH
    assert "restart him" in e.value.message
    assert not (anki_dir / "sdk_config.ini").exists()


def test_pair_reports_when_neither_side_has_a_key(monkeypatch, anki_dir):
    _plain(monkeypatch)
    monkeypatch.setattr(pairing, "mint_guid", lambda cert, ip, name: b"")
    monkeypatch.setattr(pairing, "pod_guid", lambda pod, serial: b"")
    with pytest.raises(PairingError) as e:
        pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "10.0.0.5")
    assert e.value.step == pairing.STEP_AUTH
    assert "connect over Bluetooth once" in e.value.message


# --- the engine's state directories ----------------------------------------
# wire-pod creates them only when packaged; run from a source tree it writes
# jdocs/ and session-certs/ by relative path and fails silently without them,
# forgetting every robot on each restart (and it restarts on each Wi-Fi change).

def test_ensure_engine_dirs_creates_both(tmp_path, monkeypatch):
    from game_bridge import pairing_engine as pe
    jd, sc = tmp_path / "jdocs", tmp_path / "session-certs"
    monkeypatch.setattr(pe, "JDOCS_DIR", jd)
    monkeypatch.setattr(pe, "SESSION_CERTS_DIR", sc)
    assert pe.ensure_engine_dirs() is True
    assert jd.is_dir() and sc.is_dir()
    # idempotent: a second start must not report a change
    assert pe.ensure_engine_dirs() is False


def test_ensure_engine_dirs_survives_an_unwritable_parent(tmp_path,
                                                          monkeypatch):
    """A failure here must not stop the engine from starting."""
    from game_bridge import pairing_engine as pe
    blocked = tmp_path / "file-not-a-dir" / "jdocs"
    (tmp_path / "file-not-a-dir").write_text("x")
    monkeypatch.setattr(pe, "JDOCS_DIR", blocked)
    monkeypatch.setattr(pe, "SESSION_CERTS_DIR", tmp_path / "session-certs")
    assert pe.ensure_engine_dirs() is True     # the other one was made
    assert (tmp_path / "session-certs").is_dir()
