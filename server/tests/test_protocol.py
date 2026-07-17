import json

import pytest

from game_bridge import protocol


def test_decode_valid_puck():
    msg = protocol.decode(
        '{"t":"puck","x":1,"y":2,"vx":3,"vy":4,"ts":5}')
    assert msg["t"] == "puck" and msg["vx"] == 3


def test_decode_rejects_bad_json():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode("{nope")


def test_decode_rejects_unknown_type():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode('{"t":"warp_drive"}')


def test_decode_rejects_missing_fields():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode('{"t":"puck","x":1}')


def test_decode_rejects_unknown_event():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode('{"t":"event","name":"self_destruct"}')


def test_event_names_accepted():
    for name in protocol.EVENT_NAMES:
        msg = protocol.decode(json.dumps({"t": "event", "name": name}))
        assert msg["name"] == name


def test_encode_builders_roundtrip():
    for built in [
        protocol.welcome("connected"),
        protocol.pose(1.234, -5.678, 90.0, 12.3, ts=123.456, seq=7),
        protocol.robot_status(80, False, False, "idle", origin_id=3),
        protocol.anim_done("anim_pounce_success_02"),
        protocol.delocalized("origin_changed"),
        protocol.pong(42.0),
    ]:
        text = protocol.encode(built)
        parsed = json.loads(text)
        assert parsed["t"] == built["t"]


def test_encode_rejects_incomplete():
    with pytest.raises(protocol.ProtocolError):
        protocol.encode({"t": "pose", "x": 1})


def test_pose_rounding():
    p = protocol.pose(1.23456, 2.34567, 3.45678, 4.56789, ts=1.0, seq=1)
    assert p["x"] == 1.2 and p["deg"] == 3.5


def test_decode_many_single():
    msgs = protocol.decode_many('{"t":"ping","ts":1}')
    assert len(msgs) == 1


def test_decode_many_coalesced():
    text = '{"t":"puck","x":1,"y":2,"vx":3,"vy":4,"ts":5}{"t":"event","name":"rally_start"}'
    msgs = protocol.decode_many(text)
    assert [m["t"] for m in msgs] == ["puck", "event"]


def test_decode_many_whitespace_separated():
    msgs = protocol.decode_many('{"t":"ping","ts":1}\n {"t":"ping","ts":2}')
    assert len(msgs) == 2 and msgs[1]["ts"] == 2
