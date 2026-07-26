"""Which path a robot is sent down is decided from one string he reports.

Read him wrong and the wizard sends a dev robot to install firmware his own
build-type gate rejects, or hides the firmware step from a stock robot who is
already sitting in recovery waiting for it. Both happened. The strings below
are real ones, off live units.
"""
from onboarding.ble import messages as m

# A Digital Dream Labs dev unit. Note what is NOT here: the word "ankidev".
# It lives in the OTA manifest as its own field and never reaches us over BLE.
# Verified on the robot: /etc/os-version = 2.0.1.6091oskr.
OSKR = "v2.0.1.6091-f61178e_os2.0.1.6091oskr-14ae740-202509231400"

# A 2026 factory-stock unit, sitting in recovery. Upstream matches the literal
# "0.9.0" and would read this as normal firmware.
STOCK_RECOVERY = "v0.9.3.1013-9a03e5c_os0.9.3.1013-3e8307e-202209101520"

# The 2018 recovery image upstream was written against.
OLD_RECOVERY = "v0.9.0-12efb91_os0.9.0-3e8307e-201806191226"

STOCK = "v2.0.1.6076-8e9f1a2_os2.0.1.6076-3e8307e-202209261200"
STOCK_EP = "v2.0.1.6076-8e9f1a2_os2.0.1.6076ep-3e8307e-202209261200"


def test_an_oskr_unit_is_a_dev_robot():
    assert m.is_dev_robot(OSKR)


def test_an_anki_dev_build_is_still_a_dev_robot():
    assert m.is_dev_robot("v1.8.1.6051-abc_os1.8.1.6051ankidev-def-202202011200")


def test_stock_firmware_is_not_a_dev_robot():
    assert not m.is_dev_robot(STOCK)
    assert not m.is_dev_robot(STOCK_EP)
    assert not m.is_dev_robot("")


def test_recovery_is_matched_by_branch_not_by_one_build():
    assert m.is_recovery(STOCK_RECOVERY)
    assert m.is_recovery(OLD_RECOVERY)
    assert not m.is_recovery(STOCK)
    assert not m.is_recovery(OSKR)


def test_a_dev_robot_is_routed_to_ssh_not_to_a_firmware_install():
    # The whole point: no flash for this one. His build-type gate would reject
    # the escape-pod image anyway (die 214).
    assert m.classify_robot(OSKR) == m.STATE_FIRMWARE_DEV


def test_a_stock_robot_in_recovery_is_ready_for_the_install():
    assert m.classify_robot(STOCK_RECOVERY) == m.STATE_RECOVERY_PROD


def test_a_stock_robot_on_normal_firmware_needs_the_install():
    assert m.classify_robot(STOCK) == m.STATE_FIRMWARE_NONEP


def test_an_already_escape_pod_robot_goes_straight_to_pairing():
    assert m.classify_robot(STOCK_EP) == m.STATE_FIRMWARE_EP


# Captured from a live dev unit over BLE, 2026-07-26. It carries BOTH markers;
# the on-disk files carry only `oskr`, so this is the string that settles it.
LIVE_OSKR_BLE = "v2.0.1.6091-f61178e_os2.0.1.6091oskr-14ae740-202509231819-ankidev"


def test_the_string_a_real_dev_robot_sends_over_ble():
    assert m.is_dev_robot(LIVE_OSKR_BLE)
    assert not m.is_recovery(LIVE_OSKR_BLE)
    assert m.classify_robot(LIVE_OSKR_BLE) == m.STATE_FIRMWARE_DEV
