"""The network facts an away-from-home setup depends on.

Every case here is one that actually happened while pairing a robot outside
the home network, and each one reported itself as something else: a stale
.local record read as "the robot is asleep", a /23 neighbour read as a
different network, a relayed guest link read as a firmware problem. They are
cheap to measure and expensive to guess, so they are pinned.
"""
import game_bridge.netinfo as netinfo
from game_bridge import doctor
from game_bridge.mdns import Responder


class TestSameSubnet:
    def test_reads_the_real_mask_not_an_assumed_24(self, monkeypatch):
        # The network that broke us was /23: .154.x and .155.x are neighbours,
        # and anything assuming /24 calls them unrelated.
        monkeypatch.setattr(netinfo, "_netmask_for", lambda ip: "255.255.254.0")
        assert netinfo.same_subnet("198.51.100.10", "198.51.100.31") is True

    def test_different_networks_are_reported(self, monkeypatch):
        monkeypatch.setattr(netinfo, "_netmask_for", lambda ip: "255.255.254.0")
        assert netinfo.same_subnet("198.51.100.10", "203.0.113.194") is False

    def test_unknown_is_none_not_false(self, monkeypatch):
        # "We could not read the mask" must never be reported as "they differ",
        # or a preflight starts blocking people over its own failure to look.
        monkeypatch.setattr(netinfo, "_netmask_for", lambda ip: "")
        assert netinfo.same_subnet("10.0.0.1", "10.0.0.2") is None
        assert netinfo.same_subnet("", "10.0.0.2") is None


class TestStaleAnnouncement:
    """The failure that cost the most: a name that resolves to nowhere."""

    def _checks(self, monkeypatch, lan, resolves):
        monkeypatch.setattr(netinfo, "lan_ip", lambda: lan)
        monkeypatch.setattr(netinfo, "_netmask_for", lambda ip: "255.255.255.0")
        monkeypatch.setattr(netinfo, "resolves_to",
                            lambda name: resolves.get(name, []))
        return {c.name: c for c in doctor._network_checks()}

    def test_name_pointing_at_the_previous_network_fails(self, monkeypatch):
        checks = self._checks(
            monkeypatch, "198.51.100.10",
            {"vectar.local": ["192.0.2.10"], "escapepod.local": ["198.51.100.10"]})
        lens = checks["lens name (vectar.local)"]
        assert lens.ok is False
        # The message has to carry both addresses: the whole point is that the
        # name resolves, so "it doesn't work" is not a usable description.
        assert "192.0.2.10" in lens.detail and "198.51.100.10" in lens.detail
        assert checks["pairing-engine name (escapepod.local)"].ok is True

    def test_name_at_the_current_address_passes(self, monkeypatch):
        checks = self._checks(
            monkeypatch, "192.0.2.10",
            {"vectar.local": ["192.0.2.10"], "escapepod.local": ["192.0.2.10"]})
        assert checks["lens name (vectar.local)"].ok is True

    def test_unpublished_name_is_not_a_failure(self, monkeypatch):
        # Nothing is wrong when the service that owns the name is simply off.
        checks = self._checks(monkeypatch, "192.0.2.10", {})
        assert checks["lens name (vectar.local)"].ok is None


class TestRobotOnThisNetwork:
    def _checks(self, monkeypatch, lan, robot, rtt=1.0, same=True):
        monkeypatch.setattr(netinfo, "lan_ip", lambda: lan)
        monkeypatch.setattr(netinfo, "_netmask_for", lambda ip: "255.255.255.0")
        monkeypatch.setattr(netinfo, "resolves_to", lambda name: [lan])
        monkeypatch.setattr(netinfo, "same_subnet", lambda a, b: same)
        monkeypatch.setattr(netinfo, "rtt_ms", lambda ip, **kw: rtt)
        return {c.name: c for c in doctor._network_checks(robot)}

    def test_robot_from_another_network_is_named_as_such(self, monkeypatch):
        checks = self._checks(monkeypatch, "198.51.100.10", "203.0.113.194",
                              same=False)
        c = checks["robot on this network"]
        assert c.ok is False
        # And the advice must be about the network, not about the robot: the
        # old text sent people to press his backpack button.
        assert "JOIN A DIFFERENT NETWORK" in c.fix

    def test_guest_network_latency_is_flagged_before_pairing(self, monkeypatch):
        # 300 ms on a "LAN" is the fingerprint of a relayed guest SSID, which
        # also blocks client-to-client — so pairing cannot work there at all.
        checks = self._checks(monkeypatch, "198.51.100.10", "198.51.100.31",
                              rtt=312.0)
        c = checks["link to the robot"]
        assert c.ok is False
        assert "hotspot" in c.fix

    def test_a_normal_lan_hop_passes(self, monkeypatch):
        checks = self._checks(monkeypatch, "192.0.2.10", "192.0.2.20",
                              rtt=11.0)
        assert checks["link to the robot"].ok is True

    def test_silence_is_not_reported_as_a_slow_network(self, monkeypatch):
        # A sleeping robot and a relayed one need different advice.
        checks = self._checks(monkeypatch, "192.0.2.10", "192.0.2.20",
                              rtt=None)
        assert checks["link to the robot"].ok is None


class TestResponderRebind:
    def test_same_address_is_a_no_op(self):
        r = Responder("10.0.0.1", 8777)
        assert r.rebind("10.0.0.1") is False
        assert r.rebind("") is False

    def test_moving_republishes_at_the_new_address(self, monkeypatch):
        r = Responder("198.51.100.10", 8777)
        calls = []
        monkeypatch.setattr(r, "stop", lambda: calls.append("stop"))
        monkeypatch.setattr(r, "start", lambda: calls.append("start") or True)
        assert r.rebind("192.0.2.10") is True
        # Order matters: the old record must be withdrawn before the new one
        # goes out, or both are briefly live and resolution picks either.
        assert calls == ["stop", "start"]
        assert r.ip == "192.0.2.10"
