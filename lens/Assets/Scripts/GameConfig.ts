/**
 * All game tunables. Field frame matches the Mac bridge (game_bridge/config.py):
 * units mm, origin at field center, +X toward Vector's goal, +Y = player's left.
 * Lens world units are cm — FieldMath converts.
 */
export const GameConfig = {
  // --- Network ---
  // Set this to YOUR Mac's LAN IP (the machine running the game server).
  // Find it: macOS System Settings -> Wi-Fi -> Details, or `ipconfig getifaddr en0`.
  WS_URL: "ws://192.168.1.100:8777",
  PING_INTERVAL_S: 2.0,
  PONG_TIMEOUT_S: 5.0,
  PUCK_SEND_HZ: 30,

  // --- Field (mm) ---
  FIELD_L: 400,           // goal lines at x = +-200
  FIELD_W: 300,           // walls at y = +-150 (widened from 200)
  WALL_H_CM: 3.0,
  PUCK_R: 15,
  PADDLE_R: 25,
  VECTOR_BODY_R: 55,
  GOALIE_X: 140,          // Vector start pad center
  GOALIE_Y_RANGE: 110, // patrol y clamp (mirrors bridge)
  BATTERY_SPAWN_S: 11,    // rally seconds between power-cell spawns
  BATTERY_RADIUS_MM: 26,  // pickup radius (puck center hit)

  // --- Puck (toned down per playtest: "динаміку трошки менше") ---
  CUBE_ENABLED: false, // cube anchor retired — YOLO carries positioning
  CUBE_FIELD_X: -230, // LightCube anchor spot (player-side right corner)
  CUBE_FIELD_Y: -130,
  MALLET_LEAD_MM: 55, // mallet rides AHEAD of the fingertips (space match)
  PUCK_SERVE_SPEED: 135,  // mm/s
  PUCK_MIN_SPEED: 150,
  PUCK_MAX_SPEED: 235,
  WALL_RESTITUTION: 0.98,
  PADDLE_VEL_TRANSFER: 0.6,

  // --- Game ---
  WIN_SCORE: 5,
  COUNTDOWN_S: 4.0,
  GOAL_PAUSE_TIMEOUT_S: 7.0, // choreo is fast now (no mid-match repark)

  // --- Avatar ---
  POSE_RENDER_DELAY_S: 0.06, // tighter — ghost-turn lag fix
  POSE_EXTRAPOLATE_MAX_S: 0.1,

  // --- Dev flags ---
  PREDICTIVE_OCCLUDER: true, // v2: output smoothing + gentle turns tame it
  OFFLINE: false,          // REAL ROBOT via bridge :8777
  DEBUG_AUTOPLACE: false,  // ON-DEVICE: real hand calibration
  VISION_FIX_ENABLED: false, // on-device YOLO -> vision_fix (M3+)
  TRAIL_STEP_MM: 6,   // ribbon point spacing
  TRAIL_FADE_S: 1.2,  // tread trail life (short — hockey pace)

  // ===========================================================================
  //  OPTIONAL — VOICE AGENT (talk to Vector during the game, Gemini replies via
  //  his TTS). Skip this whole block to play without it.
  //
  //  ┌─ PASTE YOUR TOKEN HERE ─────────────────────────────────────────────┐
  //  │  1. In Lens Studio, open the Asset Library and install               │
  //  │     "Remote Service Gateway" (RemoteServiceGateway.lspkg).           │
  //  │  2. Menu bar -> Remote Service Gateway -> Generate Token.            │
  //  │  3. Copy the token and paste it into RSG_GOOGLE_TOKEN below.         │
  //  │  4. Set VOICE_ENABLED: true, and start the server with VECTAR_CHAT=1.│
  //  │  The token is per-developer and must NOT be committed publicly.      │
  //  └─────────────────────────────────────────────────────────────────────┘
  VOICE_ENABLED: false,                 // <- flip to true after pasting a token
  RSG_GOOGLE_TOKEN: "",                 // <- PASTE YOUR RSG TOKEN HERE
  LLM_MODEL: "gemini-3.1-flash-lite",   // one-shot generateContent model
};
