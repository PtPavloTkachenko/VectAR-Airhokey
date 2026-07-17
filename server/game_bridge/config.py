"""All tunables for the game bridge. Env vars override."""
import os
from pathlib import Path


def _f(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _i(name: str, default: int) -> int:
    return int(os.getenv(name, default))


# --- Network ---
WS_HOST = os.getenv("GAME_WS_HOST", "0.0.0.0")
WS_PORT = _i("GAME_WS_PORT", 8777)          # lens (Spectacles) WebSocket
WEB_HOST = os.getenv("GAME_WEB_HOST", "0.0.0.0")
WEB_PORT = _i("GAME_WEB_PORT", 8780)        # web UI: pairing wizard + dashboard (0 = off)
PROTO_VERSION = 1

# --- Robot (stock Vector over the anki_vector SDK -> vic-gateway gRPC :443) ---
# Identity + credentials live in ~/.anki_vector/sdk_config.ini, written by the
# pairing wizard (http://localhost:8780) or anki_vector's own configure tool.
# Env vars VECTOR_SERIAL / VECTOR_IP / VECTOR_NAME override (VECTOR_IP may be a
# comma-separated candidate list if your robot bounces between DHCP leases).
SDK_CONFIG_PATH = Path.home() / ".anki_vector" / "sdk_config.ini"
WIREPOD_URL = os.getenv("WIREPOD_URL", "http://escapepod.local:8080")


def read_robot_identity() -> tuple[str, str, str]:
    """(serial, ips, name) — env overrides win, else sdk_config.ini.

    Read fresh on every call so a pairing done while the server is running
    is picked up without a restart. Empty strings = not paired yet.
    """
    import configparser
    serial = os.getenv("VECTOR_SERIAL", "").lower()
    ips = os.getenv("VECTOR_IP", "")
    name = os.getenv("VECTOR_NAME", "")
    try:
        cfg = configparser.ConfigParser(strict=False)
        cfg.read(SDK_CONFIG_PATH)
        sections = cfg.sections()
        sect = serial if serial in sections else (sections[0] if sections else None)
        if sect:
            serial = serial or sect
            ini_ip = cfg[sect].get("ip", "")
            ips = ips or ini_ip
            name = name or cfg[sect].get("name", "")
            # env gave IPs but ini knows another one -> append as a candidate
            if ini_ip and ini_ip not in ips.split(","):
                ips = f"{ips},{ini_ip}" if ips else ini_ip
    except Exception:
        pass
    return serial, ips, name

# --- In-game Gemini voice agent (talk to Vector; through the lens RSG, no Mac key) ---
# OFF by default -> zero change to the game. Lens must run LLMProxy (RSG) + ASR->utter.
VECTAR_CHAT = os.getenv("VECTAR_CHAT", "0") == "1"

# --- Pose refinement B6.4: gyro-fused heading. OFF = raw odometry (byte-identical).
# The IMU gyro measures TRUE rotation (immune to tread slip that inflates odom heading
# on point-turns); a weak pull toward odometry cancels the gyro's own bias drift.
VECTAR_GYRO_HEADING = os.getenv("VECTAR_GYRO_HEADING", "0") == "1"
GYRO_ODOM_ALPHA = _f("GYRO_ODOM_ALPHA", 0.02)   # per-sample odom correction blended into gyro heading

# --- Field frame (mm). Origin = field center, +X toward Vector's goal, +Y player's left ---
FIELD_L = 400.0            # goal lines at x = +-200
FIELD_W = 300.0            # walls at y = +-150 (widened)
PUCK_R = 15.0
GOALIE_X = 140.0           # Vector patrol line (goal 200 - half body 50 - margin 10)
GOALIE_Y_RANGE = 110.0     # patrol y in [-110, +110] (field widened)
GOALIE_HEADING = 90.0      # park heading, deg CCW (facing +Y = sideways)
VECTOR_BODY_R = 55.0       # virtual blocker radius (lens-side collision uses same value)

# --- Goalie control ---
KP = _f("GOALIE_KP", 3.8)              # mm/s per mm of y error
KH = _f("GOALIE_KH", 1.5)              # mm/s differential per deg of heading error
MAX_WHEEL = _f("GOALIE_MAX_WHEEL", 218.0)   # SDK max 220 — use it
MAX_TURN_DIFF = 60.0                    # cap on heading-servo differential
DEADBAND_MM = _f("GOALIE_DEADBAND", 8.0)
INTERCEPT_MAX_T = 3.0                   # ignore predictions further than 3 s out
PUCK_MIN_VX = 30.0                      # puck slower than this toward goal -> return home
GOALIE_RATE_HZ = 33.0  # tighter reaction loop (was 20)
POSE_RATE_HZ = 30.0

# --- Showman mode: drive nose-first, face the player between plays ---
# (Vector's eyes are the show — never park him sideways.)
SHOWMAN = os.getenv("GOALIE_SHOWMAN", "1") == "1"
FACE_PLAYER_DEG = 180.0     # facing -X = toward the player
ARRIVE_MM = 28.0            # within this of target -> stop driving, face the action
HEADING_FLIP_HYST_MM = 55.0 # only flip nose direction when error exceeds this
TURN_ALIGN_DEG = 55.0       # nose within this of travel dir -> arc-drive (v scaled by cos)
KW_TURN = _f("GOALIE_KW_TURN", 1.6)   # wheel mm/s per deg when rotating in place
MAX_TURN_WHEEL = 78.0       # gentler turns -> less tread slip/drift
# ^ deliberately modest: aggressive point turns make the treads slip and
#   odometry heading drifts -> robot physically walks off the field while
#   its own coordinates look perfect. Real fix = vision corrections from
#   the glasses (YOLO), which continuously re-anchor the transform.

# --- Liveliness: head tracks the puck, face-only eye reactions ---
HEAD_TRACKING = os.getenv("GOALIE_HEAD_TRACKING", "1") == "1"
HEAD_EYE_HEIGHT_MM = 50.0   # Vector's eye height above the table
HEAD_IDLE_RAD = 0.15        # idle: head slightly up, "looking at the player"
HEAD_MIN_RAD = -0.38        # SDK range ~[-22deg, +45deg]
HEAD_MAX_RAD = 0.60
HEAD_KP = 4.0               # motor speed per rad of error
HEAD_MAX_SPEED = 1.6
FACE_REACT_BLOCK = ["FistBumpSuccess",
                    "CubePounceWinHand",
                    "OnboardingReactToFaceHappy"]  # eyes/audio-only on block (SDK triggers)

# --- Safety ---
GOALIE_X_MIN = 100.0       # X corridor around the patrol line: outside ->
GOALIE_X_MAX = 190.0       # only inward motion allowed
WATCHDOG_PUCK_S = 0.5      # no puck msg for this long during rally -> STOP
SLEW_MM_S_PER_TICK = 55.0  # max wheel change per tick (~1100 mm/s^2 — snappy)
FIELD_Y_SOFT = 80.0        # outside this, only inward commands allowed
HELD_STOP_S = 1.0          # sustained held -> delocalized (0.5 false-fired on IMU spikes)

# --- Vision fix (complementary filter on translation) ---
# YOLO is THE position corrector (user-verified: detections are spatially
# tight even at conf ~0.45) — pull harder and let re-anchor clusters form
# from real-world confidences.
ALPHA_VISION = _f("ALPHA_VISION", 0.14)
VISION_MIN_CONF = 0.4
VISION_REANCHOR_CONF = _f("VISION_REANCHOR_CONF", 0.42)
VISION_OUTLIER_MM = 80.0
POSE_HISTORY_S = 1.5       # keep transformed poses this long for vision-fix matching

# --- Choreography: SDK animation TRIGGER names (proven-good set from live
# play; the commander plays them with ignore_body_track=True so the emotion
# shows on the face/head/lift but the treads never move — full-body anims
# corrupt the odometry->field transform and the goalie chases a phantom). ---
ANIM_SAD = ["CubePounceLoseHand", "BlackJack_VictorLose",
            "FrustratedByFailureMajor", "FistBumpLeftHanging"]
ANIM_HAPPY = ["CubePounceWinHand", "BlackJack_VictorWin", "FistBumpSuccess"]
ANIM_GREETING = ["GreetAfterLongTime", "ReactToGreeting"]
ANIM_GAME_WIN = ["CubePounceWinSession"]
ANIM_GAME_LOSE = ["CubePounceLoseSession"]

# Eye COLOR as (hue, saturation) 0..1 (SDK behavior.set_eye_color)
EYE_NORMAL = (0.42, 1.0)     # cyan-green (Vector default 0.45)
EYE_SAD = (0.90, 0.85)       # PINK — the player color scored on him
EYE_VICTORY = (0.33, 1.0)    # green

# --- Voice (Vector's own TTS): salty on conceding, cocky on scoring ---
SAY_POWER = ["Maximum power!", "Overdrive!", "Charged up!"]
SAY_TAUNT = ["Come on!", "Bring it!", "Try me!", "You ready?"]
SAY_LETSGO = ["Let's go!", "Game time!", "Here we go!", "Ready to roll!"]
SAY_STOLEN = ["Hey!", "That was mine!", "No fair!"]
EYE_ANGRY = (0.93, 0.72)  # pink anger for the pre-serve stare
SAY_S_PER_CHAR = 0.075   # TTS duration estimate (no completion ack on Link)

# --- Collision sounds FROM THE ROBOT: retired Link-era polish. The SDK
# commander's collision_react() is a no-op (these are on-robot clip names,
# not SDK triggers) — kept so the call sites stay wired for future mapping.
ANIM_PUCK_PADDLE = "anim_dancebeat_headnod_01"
ANIM_PUCK_WALL = "anim_blackjack_deal_01"
ANIM_DAMAGE = "anim_explorer_huh_01"
COLLISION_MIN_GAP_S = 0.45
SAY_CONCEDE = ["Fuck!", "What?! No!", "Oh come on!", "Not again!",
               "Seriously?!", "Argh!"]
SAY_SCORE = ["Yes!", "Too easy!", "Gotcha!", "Ha ha!", "Beep beep, loser!"]
SAY_VOLUME = 1.0
SAY_BLOCK = ["Hah!", "Hyah!", "Hup!", "Ha!", "Boom!", "Nope!"]
SAY_BLOCK_COOLDOWN_S = 2.5

# --- Cube anchor: user places the LightCube at a KNOWN field spot ---
# Behind the PLAYER goal => inside the goalie's forward view all match long.
CUBE_ANCHOR = _f("CUBE_ANCHOR", 0.0) > 0.5  # retired: YOLO carries it
CUBE_FIELD_X = _f("CUBE_FIELD_X", -230.0)  # player-side RIGHT corner
CUBE_FIELD_Y = _f("CUBE_FIELD_Y", -130.0)  # (user's right = field -Y)
ALPHA_CUBE = _f("ALPHA_CUBE", 0.06)   # translation blend per sighting
ALPHA_CUBE_THETA = _f("ALPHA_CUBE_THETA", 0.03)  # heading blend
CUBE_FRESH_S = 2.0                    # only trust recent sightings
CUBE_OUTLIER_MM = 160.0

REPARK_TOL_MM = 20.0
ANIM_TIMEOUT_S = 8.0
