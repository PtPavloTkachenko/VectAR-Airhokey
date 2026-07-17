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


def test_pair_happy_path(monkeypatch, anki_dir):
    pem = b"-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n"
    monkeypatch.setattr(pairing, "fetch_cert", lambda pod, serial: pem)
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
    monkeypatch.setattr(pairing, "fetch_cert", lambda pod, serial: pem)
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
    monkeypatch.setattr(pairing, "fetch_cert", lambda pod, serial: pem)
    monkeypatch.setattr(pairing, "validate_cert_name", lambda cert, name: None)

    def fail(cert, ip, name):
        raise PairingError(pairing.STEP_AUTH, "robot said no")
    monkeypatch.setattr(pairing, "mint_guid", fail)
    with pytest.raises(PairingError) as e:
        pairing.pair("localhost:8080", "00e20145", "Vector-A1B2", "10.0.0.5")
    assert e.value.step == pairing.STEP_AUTH
    # nothing must be written on failure
    assert not (anki_dir / "sdk_config.ini").exists()
