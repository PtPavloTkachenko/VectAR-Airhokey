"""What the link says when it cannot get control.

There are three reasons and they need three different actions, but one message
covered all of them: "is another SDK client connected?". That answer is right
in exactly one case and actively misleading in the other two — it sends people
hunting for a second session while the robot is asleep, or sitting on a
network this Mac cannot see. The last one cost a morning.
"""
import game_bridge.netinfo as netinfo
import game_bridge.robot.sdk.connection as conn
from game_bridge.robot.sdk.connection import RobotLink


def _link(monkeypatch, ip: str, name: str = "Vector-T3ST") -> RobotLink:
    monkeypatch.setattr(conn.config, "read_robot_identity",
                        lambda want="": ("0dd1f6df", ip, name))
    return RobotLink()


class TestControlFailureReason:
    def test_different_network_says_so(self, monkeypatch):
        link = _link(monkeypatch, "203.0.113.194")
        monkeypatch.setattr(netinfo, "lan_ip", lambda: "198.51.100.10")
        monkeypatch.setattr(netinfo, "same_subnet", lambda a, b: False)
        msg = link._control_failure_reason()
        assert "different network" in msg
        assert "203.0.113.194" in msg and "198.51.100.10" in msg
        # Must NOT blame a second client — that was the old catch-all.
        assert "another SDK client" not in msg

    def test_unreachable_on_our_network_blames_the_robot_not_a_client(
            self, monkeypatch):
        link = _link(monkeypatch, "192.0.2.20")
        monkeypatch.setattr(netinfo, "lan_ip", lambda: "192.0.2.10")
        monkeypatch.setattr(netinfo, "same_subnet", lambda a, b: True)
        monkeypatch.setattr(conn, "_tcp_open", lambda ip, **kw: False)
        msg = link._control_failure_reason()
        assert "not answering" in msg
        assert "another SDK client" not in msg

    def test_reachable_but_refused_is_the_only_second_client_case(
            self, monkeypatch):
        link = _link(monkeypatch, "192.0.2.20")
        monkeypatch.setattr(netinfo, "lan_ip", lambda: "192.0.2.10")
        monkeypatch.setattr(netinfo, "same_subnet", lambda a, b: True)
        monkeypatch.setattr(conn, "_tcp_open", lambda ip, **kw: True)
        msg = link._control_failure_reason()
        assert "another SDK client" in msg
        # And it must be honest that he WAS reachable, so the reader knows the
        # difference from the case above.
        assert "reachable" in msg

    def test_undecidable_subnet_still_attempts(self, monkeypatch):
        # A mask we failed to read must not be treated as "different network",
        # or an unusual setup stops working with a confident wrong answer.
        link = _link(monkeypatch, "192.0.2.20")
        monkeypatch.setattr(netinfo, "lan_ip", lambda: "192.0.2.10")
        monkeypatch.setattr(netinfo, "same_subnet", lambda a, b: None)
        monkeypatch.setattr(conn, "_tcp_open", lambda ip, **kw: True)
        assert "another SDK client" in link._control_failure_reason()
