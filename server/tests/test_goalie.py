import pytest

from game_bridge import config
from game_bridge.robot.goalie import (
    FieldPose, PuckState, fold, predict_intercept, wheel_command,
)


H = config.FIELD_W / 2.0 - config.PUCK_R  # 85


def test_fold_inside():
    assert fold(0, H) == pytest.approx(0)
    assert fold(50, H) == pytest.approx(50)
    assert fold(-H, H) == pytest.approx(-H)


def test_fold_one_reflection():
    d = 20.0
    assert fold(H + d, H) == pytest.approx(H - d)
    assert fold(-H - d, H) == pytest.approx(-H + d)


def test_fold_two_reflections():
    # past the far wall and back
    assert fold(3 * H + 10, H) == pytest.approx(-H + 10)


def test_intercept_straight():
    # puck at center moving straight at the goalie line
    p = PuckState(x=0, y=30, vx=200, vy=0)
    y = predict_intercept(p)
    assert y == pytest.approx(30)


def test_intercept_diagonal_no_wall():
    p = PuckState(x=-60, y=0, vx=200, vy=50)
    t = (config.GOALIE_X - p.x) / p.vx
    assert predict_intercept(p) == pytest.approx(p.y + p.vy * t)


def test_intercept_wall_reflection():
    # steep diagonal guaranteed to hit a wall before the goalie line
    p = PuckState(x=-100, y=80, vx=150, vy=200)
    t = (config.GOALIE_X - p.x) / p.vx
    y_raw = p.y + p.vy * t
    assert y_raw > H  # sanity: unreflected path exits the field
    y = predict_intercept(p)
    assert y is not None
    assert -config.GOALIE_Y_RANGE <= y <= config.GOALIE_Y_RANGE
    assert y == pytest.approx(
        max(-config.GOALIE_Y_RANGE, min(config.GOALIE_Y_RANGE, fold(y_raw, H))))


def test_intercept_not_incoming():
    assert predict_intercept(PuckState(x=0, y=0, vx=-100, vy=0)) is None
    assert predict_intercept(PuckState(x=0, y=0, vx=10, vy=0)) is None  # too slow


def test_intercept_clamped_to_patrol():
    p = PuckState(x=0, y=config.GOALIE_Y_RANGE + 20, vx=300, vy=0)
    y = predict_intercept(p)
    assert y == pytest.approx(config.GOALIE_Y_RANGE)


def test_wheels_deadband():
    pose = FieldPose(x=140, y=0, deg=90)
    l, r = wheel_command(0.0, pose)
    assert l == 0 and r == 0


def test_wheels_drive_toward_target():
    pose = FieldPose(x=140, y=0, deg=90)
    l, r = wheel_command(50.0, pose)  # target +Y -> drive forward
    assert l > 0 and r > 0
    l2, r2 = wheel_command(-50.0, pose)
    assert l2 < 0 and r2 < 0


def test_wheels_heading_servo():
    # robot yawed to 80 deg; needs CCW correction -> right faster than left
    pose = FieldPose(x=140, y=0, deg=80)
    l, r = wheel_command(0.0, pose)
    assert r > l


def test_wheels_capped():
    pose = FieldPose(x=140, y=-70, deg=90)
    l, r = wheel_command(70.0, pose)  # 140 mm error * KP >> cap
    assert abs(l) <= config.MAX_WHEEL + 1e-9
    assert abs(r) <= config.MAX_WHEEL + 1e-9
