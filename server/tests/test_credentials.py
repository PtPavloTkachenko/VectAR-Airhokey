"""Stored credentials versus usable credentials.

A robot keeps his serial through a factory reset but comes back with a new
name and a new certificate. The entry written for him weeks earlier therefore
survives the wipe looking perfectly valid, and every "is he set up?" check that
asks only whether an entry exists says yes. That is how an onboarding which
never obtained a token still finished on a success screen.
"""
from pathlib import Path

from game_bridge import config
from game_bridge.web.server import WebUI


class _StubBridge:
    use_robot = False
    robot_linked = False
    robot_alive = False

    class ws:
        alive = False


def _ui() -> WebUI:
    return WebUI(_StubBridge())


def _write_config(tmp_path, monkeypatch, body: str) -> Path:
    p = tmp_path / "sdk_config.ini"
    p.write_text(body)
    monkeypatch.setattr(config, "SDK_CONFIG_PATH", p)
    return p


class TestStaleCredentials:
    def test_entry_from_before_a_wipe_is_rejected(self, tmp_path, monkeypatch):
        cert = tmp_path / "Vector-C6Z4-0dd1f6df.cert"
        cert.write_text("x")
        _write_config(tmp_path, monkeypatch, f"""
[0dd1f6df]
cert = {cert}
ip = 192.0.2.20
name = Vector-C6Z4
guid = old==
""")
        # Same physical robot, wiped since: serial unchanged, name rotated.
        why = _ui()._stale_credentials("0dd1f6df", "Vector-Y2B8")
        assert why
        assert "Vector-C6Z4" in why and "Vector-Y2B8" in why

    def test_matching_entry_is_accepted(self, tmp_path, monkeypatch):
        cert = tmp_path / "Vector-Y2B8-0dd1f6df.cert"
        cert.write_text("x")
        _write_config(tmp_path, monkeypatch, f"""
[0dd1f6df]
cert = {cert}
ip = 192.0.2.20
name = Vector-Y2B8
guid = fresh==
""")
        assert _ui()._stale_credentials("0dd1f6df", "Vector-Y2B8") == ""

    def test_missing_certificate_file_is_caught(self, tmp_path, monkeypatch):
        _write_config(tmp_path, monkeypatch, f"""
[0dd1f6df]
cert = {tmp_path / 'gone.cert'}
ip = 192.0.2.20
name = Vector-Y2B8
guid = fresh==
""")
        why = _ui()._stale_credentials("0dd1f6df", "Vector-Y2B8")
        assert "certificate is missing" in why

    def test_no_entry_is_a_normal_first_pairing(self, tmp_path, monkeypatch):
        _write_config(tmp_path, monkeypatch, "")
        assert _ui()._stale_credentials("0dd1f6df", "Vector-Y2B8") == ""

    def test_undecidable_without_a_live_name(self, tmp_path, monkeypatch):
        # No BLE session means no way to know who is actually in front of us.
        # Guessing "stale" there would block a robot that is perfectly fine.
        cert = tmp_path / "c.cert"
        cert.write_text("x")
        _write_config(tmp_path, monkeypatch, f"""
[0dd1f6df]
cert = {cert}
name = Vector-C6Z4
guid = old==
""")
        assert _ui()._stale_credentials("0dd1f6df", "") == ""
        assert _ui()._stale_credentials("", "Vector-Y2B8") == ""
