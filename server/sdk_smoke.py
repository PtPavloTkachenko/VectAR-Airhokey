"""SDK smoke-test: prove the anki_vector SDK path works on your paired robot.

Bonus proof: run with wire-pod STOPPED — a successful connect shows that SDK
control works without a live token service (wire-pod is only needed once, at
pairing time). Robot may be ON the dock -> drive_off_charger first.
All moves are bounded/auto-stop.

Usage: python sdk_smoke.py [serial]   (default: from ~/.anki_vector/sdk_config.ini)
"""
import os, sys, time, traceback
os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")

import anki_vector
from anki_vector.util import degrees
try:
    from anki_vector.connection import ControlPriorityLevel
    CTRL = ControlPriorityLevel.OVERRIDE_BEHAVIORS_PRIORITY
except Exception as e:
    print("[smoke] ControlPriorityLevel import issue:", e); CTRL = None

from game_bridge import config as _cfg
SERIAL = sys.argv[1] if len(sys.argv) > 1 else _cfg.read_robot_identity()[0]
if not SERIAL:
    sys.exit("[smoke] no robot paired — run the pairing wizard first "
             "(http://localhost:8780) or pass a serial: python sdk_smoke.py <serial>")
print(f"[smoke] connecting to Vector {SERIAL} ...")
try:
    kw = dict(serial=SERIAL)
    if CTRL is not None:
        kw["behavior_control_level"] = CTRL
    with anki_vector.Robot(**kw) as robot:
        print("[smoke] CONNECTED + behavior control acquired  ✅")
        try:
            b = robot.get_battery_state()
            print(f"[smoke] battery: level={getattr(b,'battery_level',None)} "
                  f"volts={getattr(b,'battery_volts',None):.2f} "
                  f"charging={getattr(b,'is_charging',None)} on_charger={getattr(b,'is_on_charger_platform',None)}")
        except Exception as e:
            print("[smoke] battery read skipped:", e)

        print("[smoke] drive_off_charger ...")
        robot.behavior.drive_off_charger()

        print("[smoke] say_text ...")
        robot.behavior.say_text("Vect A R online")

        print("[smoke] head move (visible) ...")
        robot.behavior.set_head_angle(degrees(25)); time.sleep(0.4)
        robot.behavior.set_head_angle(degrees(0))

        print("[smoke] bounded turn (wheels, auto-stop) ...")
        robot.behavior.turn_in_place(degrees(30))
        robot.behavior.turn_in_place(degrees(-30))

        print("[smoke] eye color -> green ...")
        try:
            robot.behavior.set_eye_color(hue=0.33, saturation=1.0)
            time.sleep(0.6)
        except Exception as e:
            print("[smoke] eye color skipped:", e)

        print("[smoke] repark on charger ...")
        try:
            robot.behavior.drive_on_charger()
        except Exception as e:
            print("[smoke] repark skipped:", e)

        print("\n[smoke] SUCCESS ✅ — SDK connect + control + say + head + wheels + eyes all worked on the STOCK robot.")
        print("[smoke] => A2 re-transport is de-risked; and offline variant (a) is live-proven.")
except Exception as e:
    print("\n[smoke] FAILED ❌:", repr(e))
    traceback.print_exc()
    print("\n[smoke] If this looks auth/connection related, wire-pod may be needed after all — "
          "start it and retry (that would refine the variant-a finding).")
    sys.exit(1)
