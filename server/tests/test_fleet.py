"""More than one robot on one Mac.

Two things have to hold, and both have bitten us on hardware:

  * whoever is at the FRONT of sdk_config.ini is the robot everything resolves
    to when nobody names one — the game, the Lens, the watchdog. Choosing a
    robot is moving him there.
  * a robot we are holding must be LET GO before we reach for another one.
    Vector grants behavior control to a single client, so a robot we quietly
    keep is a robot that stands still forever, unable to roam or dock.
"""
import asyncio

import pytest

from game_bridge import config
from game_bridge.web.server import WebUI

from test_web_api import _StubBridge


TWO_ROBOTS = """\
[00e20100]
cert = /tmp/vectar-test-00e20100.cert
ip = 192.168.0.194
name = Vector-R3H7
guid = aaaaaaaaaaaaaaaa

[00e20200]
cert = /tmp/vectar-test-00e20200.cert
ip = 192.168.0.205
name = Vector-V6M2
guid = bbbbbbbbbbbbbbbb
"""


@pytest.fixture
def two_robots(tmp_path, monkeypatch):
    """An sdk_config.ini with two paired robots, plus their cert files."""
    ini = tmp_path / "sdk_config.ini"
    certs = {}
    for serial in ("00e20100", "00e20200"):
        c = tmp_path / f"{serial}.cert"
        c.write_text("-----BEGIN CERTIFICATE-----\n")
        certs[serial] = c
    ini.write_text(TWO_ROBOTS
                   .replace("/tmp/vectar-test-00e20100.cert", str(certs["00e20100"]))
                   .replace("/tmp/vectar-test-00e20200.cert", str(certs["00e20200"])))
    monkeypatch.setattr(config, "SDK_CONFIG_PATH", ini)
    # Build-type memory is a separate file; keep the developer's real one out.
    monkeypatch.setattr(config, "ROBOT_FACTS", tmp_path / "robots.json")
    return ini, certs


# --- config: the bookkeeping ---

def test_the_first_section_is_the_active_robot(two_robots):
    robots = config.list_robots()
    assert [r["serial"] for r in robots] == ["00e20100", "00e20200"]
    assert [r["active"] for r in robots] == [True, False]
    assert robots[0]["name"] == "Vector-R3H7"
    assert robots[0]["ip"] == "192.168.0.194"
    assert robots[0]["has_token"] is True


def test_selecting_a_robot_moves_him_to_the_front(two_robots):
    assert config.set_active_robot("00e20200") is True
    robots = config.list_robots()
    assert [r["serial"] for r in robots] == ["00e20200", "00e20100"]
    # and the OTHER robot survives the rewrite intact — losing his cert path
    # or his token here would silently un-pair him
    other = robots[1]
    assert other["name"] == "Vector-R3H7"
    assert other["ip"] == "192.168.0.194"
    assert other["has_token"] is True


def test_selecting_the_robot_who_is_already_first_is_a_no_op(two_robots):
    assert config.set_active_robot("00e20100") is True
    assert [r["serial"] for r in config.list_robots()] == ["00e20100", "00e20200"]


def test_an_unknown_serial_is_refused_not_invented(two_robots):
    assert config.set_active_robot("deadbeef") is False
    assert config.forget_robot("deadbeef") is False
    assert len(config.list_robots()) == 2


def test_forgetting_drops_the_section_and_his_certificate(two_robots):
    _ini, certs = two_robots
    assert config.forget_robot("00e20200") is True
    assert [r["serial"] for r in config.list_robots()] == ["00e20100"]
    assert not certs["00e20200"].exists()
    # the robot we kept keeps his certificate
    assert certs["00e20100"].exists()


def test_read_robot_identity_answers_for_the_robot_asked_for(two_robots):
    # The bug this locks: asking for one robot and being handed the other's
    # address, which then reads as "he isn't answering".
    serial, ips, name = config.read_robot_identity("00e20200")
    assert serial == "00e20200"
    assert ips.split(",")[0] == "192.168.0.205"
    assert name == "Vector-V6M2"


# --- the web API ---

class _FakeLink:
    def __init__(self, serial):
        self.serial = serial
        self.robot = object()
        self.has_control = True
        self.disconnected = False

    async def disconnect(self):
        self.disconnected = True
        self.robot = None


class _FreshPump:
    fresh = True
    snapshot = {"x": 0.0, "y": 0.0, "deg": 0.0}


def _client(bridge=None):
    from aiohttp.test_utils import TestClient, TestServer
    bridge = bridge or _StubBridge()
    return bridge, TestClient(TestServer(WebUI(bridge).app))


def test_the_fleet_lists_both_and_marks_exactly_one_for_the_lens(two_robots):
    async def go():
        bridge, client = _client()
        await client.start_server()
        try:
            data = await (await client.get("/api/robots")).json()
            assert [r["serial"] for r in data["robots"]] == ["00e20100", "00e20200"]
            # The Lens is handed one robot and never chooses. If this is ever
            # 0 or 2, something downstream has to start deciding — which is
            # precisely what the design forbids.
            assert sum(1 for r in data["robots"] if r["lens"]) == 1
            assert data["robots"][0]["lens"] is True
        finally:
            await client.close()
    asyncio.run(go())


def test_choosing_another_robot_lets_go_of_the_one_we_hold(two_robots):
    async def go():
        bridge, client = _client()
        held = _FakeLink("00e20100")
        bridge.link = held
        bridge.pump = _FreshPump()
        await client.start_server()
        try:
            data = await (await client.post(
                "/api/robots/select", json={"serial": "00e20200"})).json()
            assert data["ok"] is True
            assert held.disconnected is True, "the old robot stayed ours"
            assert bridge.pump is None and bridge.commander is None
            assert bridge.connect_calls == 1
            assert [r["serial"] for r in config.list_robots()][0] == "00e20200"
        finally:
            await client.close()
    asyncio.run(go())


def test_a_switch_is_recorded_even_when_he_does_not_answer(two_robots):
    async def go():
        bridge, client = _client()        # stub connect_robot returns False
        await client.start_server()
        try:
            data = await (await client.post(
                "/api/robots/select", json={"serial": "00e20200"})).json()
            # ok = "the choice is saved", connected = "he answered". Collapsing
            # the two would throw away a good selection because a robot was
            # asleep, and the console would offer re-pairing for no reason.
            assert data["ok"] is True
            assert data["connected"] is False
            assert data["error"]
            assert config.list_robots()[0]["serial"] == "00e20200"
        finally:
            await client.close()
    asyncio.run(go())


def test_choosing_a_robot_clears_a_manual_release(two_robots):
    async def go():
        bridge, client = _client()
        bridge.link_paused = True         # someone pressed RELEASE CONTROL
        await client.start_server()
        try:
            await client.post("/api/robots/select", json={"serial": "00e20200"})
            assert bridge.link_paused is False
        finally:
            await client.close()
    asyncio.run(go())


def test_choosing_an_unknown_robot_changes_nothing(two_robots):
    async def go():
        bridge, client = _client()
        held = _FakeLink("00e20100")
        bridge.link = held
        await client.start_server()
        try:
            r = await client.post("/api/robots/select", json={"serial": "nope"})
            assert r.status == 404
            assert held.disconnected is False
            assert bridge.connect_calls == 0
        finally:
            await client.close()
    asyncio.run(go())


def test_switching_never_reaches_for_onboarding(two_robots, monkeypatch):
    """A robot who is already set up must not be sent through setup again.

    This is the failure the fleet menu exists to end: the only way to play
    with the other robot used to be re-running the wizard, which re-ran
    Authorize and sat at '0 s left'. Selecting is bookkeeping plus a connect.
    """
    async def go():
        from game_bridge.web import pairing

        def _boom(*a, **k):
            raise AssertionError("selecting a paired robot re-ran onboarding")
        monkeypatch.setattr(pairing, "pair", _boom)
        monkeypatch.setattr(pairing, "mint_guid", _boom, raising=False)

        bridge, client = _client()
        await client.start_server()
        try:
            data = await (await client.post(
                "/api/robots/select", json={"serial": "00e20200"})).json()
            assert data["ok"] is True
            assert bridge.connect_calls == 1
        finally:
            await client.close()
    asyncio.run(go())


def test_forgetting_the_robot_we_hold_releases_him_first(two_robots):
    async def go():
        bridge, client = _client()
        held = _FakeLink("00e20100")
        bridge.link = held
        bridge.pump = _FreshPump()
        await client.start_server()
        try:
            data = await (await client.post(
                "/api/robots/forget", json={"serial": "00e20100"})).json()
            assert data["ok"] is True
            assert held.disconnected is True
            assert [r["serial"] for r in data["robots"]] == ["00e20200"]
        finally:
            await client.close()
    asyncio.run(go())


def test_forgetting_someone_else_leaves_our_link_alone(two_robots):
    async def go():
        bridge, client = _client()
        held = _FakeLink("00e20100")
        bridge.link = held
        bridge.pump = _FreshPump()
        await client.start_server()
        try:
            await client.post("/api/robots/forget", json={"serial": "00e20200"})
            assert held.disconnected is False
            assert bridge.link is held
        finally:
            await client.close()
    asyncio.run(go())


def test_the_search_looks_for_the_playing_robot_first():
    """Whoever answers a ping fastest must not become the robot you play."""
    from game_bridge.web.server import prefer_active

    cands = [{"ip": "192.168.0.205", "serial": "00e20200", "name": "Vector-V6M2"},
             {"ip": "192.168.0.194", "serial": "00e20100", "name": "Vector-R3H7"}]
    prefer_active(cands, "00e20100")
    assert [c["serial"] for c in cands] == ["00e20100", "00e20200"]

    # Nothing selected, or a robot who isn't on the network: leave the order
    # discovery found — inventing a preference here would be a guess.
    order = [{"serial": "a"}, {"serial": "b"}]
    assert [c["serial"] for c in prefer_active(list(order), "")] == ["a", "b"]
    assert [c["serial"] for c in prefer_active(list(order), "zz")] == ["a", "b"]

    # Unidentified candidates (an address and nothing else) sort last but
    # survive — they are still worth pinging when nobody named is answering.
    mixed = [{"ip": "1.2.3.4", "serial": ""}, {"ip": "5.6.7.8", "serial": "00e20100"}]
    prefer_active(mixed, "00e20100")
    assert [c["ip"] for c in mixed] == ["5.6.7.8", "1.2.3.4"]


def test_forgetting_an_unknown_robot_is_a_404(two_robots):
    async def go():
        bridge, client = _client()
        await client.start_server()
        try:
            r = await client.post("/api/robots/forget", json={"serial": "nope"})
            assert r.status == 404
            assert len(config.list_robots()) == 2
        finally:
            await client.close()
    asyncio.run(go())
