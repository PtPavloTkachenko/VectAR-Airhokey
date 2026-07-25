"""The name we point a dev robot at and the CA we install must be one choice.

Splitting them is the bug this guards: the robot was sent to a name he could
reach and handed a certificate the server there never presents, so his cloud
handshake failed forever and no token could be minted.
"""
import json

from onboarding import oskr_provision as prov


def test_escapepod_gets_the_certificate_that_name_serves():
    host, ca = prov.trust_anchor("escapepod")
    assert host == "escapepod.local"
    assert ca == prov.EP_CERT


def test_ip_mode_gets_wirepods_own_certificate():
    host, ca = prov.trust_anchor("ip")
    assert host != "escapepod.local"
    assert ca == prov.WIREPOD_CERT


def test_server_config_points_where_the_trust_anchor_says():
    for mode in ("escapepod", "ip"):
        host, _ = prov.trust_anchor(mode)
        cfg = json.loads(prov.server_config(mode))
        assert cfg["chipper"] == f"{host}:443"
        assert cfg["jdocs"] == f"{host}:443"
        assert cfg["tms"] == f"{host}:443"
        assert cfg["check"] == f"{host}/ok"


def test_the_two_identities_never_cross():
    _, ep_ca = prov.trust_anchor("escapepod")
    _, ip_ca = prov.trust_anchor("ip")
    assert ep_ca != ip_ca


def test_the_escape_pod_certificate_ships_with_the_repo():
    # Escape-pod mode is the mode a stock robot needs, so this file has to be
    # present for a dev robot to be set up alongside one.
    assert prov.EP_CERT.is_file(), (
        f"{prov.EP_CERT} is missing — dev robots cannot be pointed at the "
        "escape-pod engine without it")
    assert b"BEGIN CERTIFICATE" in prov.EP_CERT.read_bytes()
