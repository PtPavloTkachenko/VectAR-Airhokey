import math

import pytest

from game_bridge import config
from game_bridge.transform import RobotFieldTransform, wrap_deg


def test_wrap_deg():
    assert wrap_deg(190) == pytest.approx(-170)
    assert wrap_deg(-190) == pytest.approx(170)
    assert wrap_deg(180) == pytest.approx(180)
    assert wrap_deg(-180) == pytest.approx(180)
    assert wrap_deg(0) == 0


def test_bind_identity():
    t = RobotFieldTransform()
    t.bind(robot_pose=(140, 0, 90), field_pose=(140, 0, 90))
    fx, fy, fdeg = t.robot_to_field(140, 0, 90)
    assert (fx, fy, fdeg) == pytest.approx((140, 0, 90))
    fx, fy, fdeg = t.robot_to_field(100, 50, 10)
    assert (fx, fy, fdeg) == pytest.approx((100, 50, 10))


def test_bind_rotation_translation():
    # Robot odometry says (500, 300, 0); physically he's at field (140, 0, 90).
    t = RobotFieldTransform()
    t.bind(robot_pose=(500, 300, 0), field_pose=(140, 0, 90))
    # the bind point itself maps exactly
    fx, fy, fdeg = t.robot_to_field(500, 300, 0)
    assert (fx, fy) == pytest.approx((140, 0), abs=1e-9)
    assert fdeg == pytest.approx(90)
    # driving +100 mm along robot x (heading 0) should move +100 along field y
    fx2, fy2, _ = t.robot_to_field(600, 300, 0)
    assert fx2 == pytest.approx(140, abs=1e-9)
    assert fy2 == pytest.approx(100, abs=1e-9)


def test_roundtrip():
    t = RobotFieldTransform()
    t.bind(robot_pose=(123.4, -56.7, 37.0), field_pose=(140, 0, 90))
    for fx, fy in [(0, 0), (140, 70), (-200, -100), (13.7, 42.42)]:
        rx, ry = t.field_to_robot(fx, fy)
        bx, by, _ = t.robot_to_field(rx, ry, 0)
        assert (bx, by) == pytest.approx((fx, fy), abs=1e-6)


def test_vision_fix_blending():
    t = RobotFieldTransform()
    t.bind(robot_pose=(0, 0, 90), field_pose=(140, 0, 90))
    t.record_field_pose(140, 0, ts=100.0)
    # observation 40 mm off -> t moves by alpha * error
    applied = t.apply_vision_fix(140 + 40, 0, conf=0.9, ts=100.0)
    assert applied
    fx, fy, _ = t.robot_to_field(0, 0, 90)
    assert fx == pytest.approx(140 + config.ALPHA_VISION * 40)
    assert fy == pytest.approx(0)


def test_vision_fix_gates():
    t = RobotFieldTransform()
    t.bind(robot_pose=(0, 0, 90), field_pose=(140, 0, 90))
    t.record_field_pose(140, 0, ts=100.0)
    # low confidence
    assert not t.apply_vision_fix(180, 0, conf=0.3, ts=100.0)
    # outlier
    assert not t.apply_vision_fix(140 + config.VISION_OUTLIER_MM + 1, 0,
                                  conf=0.9, ts=100.0)
    # no matching history
    assert not t.apply_vision_fix(150, 0, conf=0.9, ts=200.0)
    # unbound
    t2 = RobotFieldTransform()
    assert not t2.apply_vision_fix(150, 0, conf=0.9, ts=100.0)


def test_invalidate():
    t = RobotFieldTransform()
    t.bind(robot_pose=(0, 0, 0), field_pose=(140, 0, 90), origin_id=7)
    assert t.bound and t.origin_id == 7
    t.invalidate()
    assert not t.bound
