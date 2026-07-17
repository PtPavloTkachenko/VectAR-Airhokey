/**
 * GameController – root component of Vector Robo Air-Hockey.
 * Owns the state machine, all game services, and the WS link to the Mac
 * bridge that drives the physical Vector goalie.
 *
 * States:
 * BOOT -> CONNECT_WS -> PLACE_FIELD -> PLACE_VECTOR -> COUNTDOWN -> RALLY
 *   -> GOAL_PAUSE -> (COUNTDOWN | GAME_OVER); DELOCALIZED overlay from any
 * play state. DEBUG_AUTOPLACE skips manual placement for preview work.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { FieldBuilder, FieldVisuals } from "./FieldBuilder";
import { FieldMath } from "./FieldMath";
import { DecoAnimator } from "./DecoAnimator";
import { FXController } from "./FXController";
import { GlowKit } from "./GlowKit";
import { GameConfig } from "./GameConfig";
import { LLMProxy } from "./LLMProxy";
import { VoiceTalk } from "./VoiceTalk";
import { HandPaddle } from "./HandPaddle";
import { IntroAssembler } from "./IntroAssembler";
import { SurfaceCalibration } from "./SurfaceCalibration";
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK";
import { GoaliePredictor } from "./GoaliePredictor";
import { CoffeeMLController } from "./ML16/CoffeeMLController";
import { CameraSurfaceProjector } from "./CameraSurfaceProjector";
import { VisionFix } from "./VisionFix";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { PuckPhysics } from "./PuckPhysics";
import { ScoreUI } from "./ScoreUI";
import { VectorAvatar } from "./VectorAvatar";
import { VFXBursts } from "./VFXBursts";
import { TrailDots, AirTrails } from "./TrailDots";
import { WSClient } from "./WSClient";

const log = new NativeLogger("GameController");

type GameState =
  | "BOOT"
  | "CALIBRATE"
  | "CONFIRM_FIELD"
  | "ROBOT_TO_POST"
  | "START"
  | "CONNECT_WS"
  | "PLACE_FIELD"
  | "PLACE_VECTOR"
  | "COUNTDOWN"
  | "RALLY"
  | "GOAL_PAUSE"
  | "GAME_OVER"
  | "DELOCALIZED";

@component
export class GameController extends BaseScriptComponent {
  @input
  @hint("InternetModule asset (declares the internet capability)")
  internetModule: InternetModule;

  @input
  @hint("Main camera (for placing the field in front of the player)")
  mainCamera: Camera;

  @input
  @hint("Glow base material — green (ImageMaterial, Add blend)")
  matCyan: Material; // note: holds GlowGreen (input name kept to avoid rewiring)

  @input
  @hint("Glow base material — pink (ImageMaterial, Add blend)")
  matMagenta: Material; // holds GlowPink

  @input
  @allowUndefined
  @hint("Depth-only occluder material (colorMask off)")
  matOccluder: Material;

  @input
  @hint("Solid additive neon green (for GLB glass parts)")
  matNeonGreen: Material;

  @input
  @hint("Solid additive neon pink (for GLB glass parts)")
  matNeonPink: Material;

  @input
  @hint("Dark PBR metal (for GLB caps/legs)")
  matMetal: Material;

  @input
  @hint("VT323 font for the CRT score display")
  scoreFont: Font;

  @input
  @hint("Fresnel rim shader material for the robot silhouette")
  @allowUndefined
  matRim: Material;

  @input
  @hint("OPTIONAL voice agent — talk to Vector, Gemini answers in his TTS")
  voiceEnabled: boolean = false;

  @input
  @showIf("voiceEnabled")
  @hint("Paste your Remote Service Gateway token here (Lens Studio menu -> Remote Service Gateway -> Generate Token). Leave blank to use GameConfig.")
  rsgToken: string = "";

  @input
  @hint("EDITOR DEBUG: skip surface detection, take the surface at world 0")
  editorSkipCalibration: boolean = false;

  @input
  @hint("Model shift (mm) so the REAL rotation axle sits on the pose point")
  @widget(new SliderWidget(-30, 30, 1))
  axleOffsetMm: number = 15;

  @input
  @hint("Vision: push along view dir (mm; + away from camera, - toward)")
  @widget(new SliderWidget(-60, 60, 1))
  visionDepthOffsetMm: number = 0;

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("YOLO: min confidence (objectness*class) to accept a detection")
  visionScoreThreshold: number = 0.4;

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("YOLO: IoU threshold for non-max suppression")
  visionIouThreshold: number = 0.45;

  @input
  @widget(new SliderWidget(1, 10, 1))
  @hint("YOLO: run inference every N frames (4 = ~15/s)")
  visionFrameSkip: number = 6; // ~10Hz — plenty for a slow robot

  @input
  @hint("YOLO: apply sigmoid to raw outputs (ON only if detections never appear)")
  visionApplySigmoid: boolean = false;

  @input
  @hint("YOLO: print [CoffeeML] detections=N best=... every run")
  visionDebugLog: boolean = false; // vision is dialed in — silence

  @input
  @hint("Vision: show the debug marker disc over the detected robot")
  visionShowMarker: boolean = false;

  @input
  @allowUndefined
  @hint("YOLO model (toys-640.onnx) for robot position correction")
  mlModel: MLAsset;

  @input
  @allowUndefined
  @hint("CameraModule asset (device camera for vision fixes)")
  camModule: CameraModule;


  @input
  @hint("Play with left hand instead of right")
  useLeftHand: boolean = false;

  private state: GameState = "BOOT";
  private ws: WSClient;
  private llm: LLMProxy | null = null;     // Gemini voice agent (RSG transport)
  private voice: VoiceTalk | null = null;  // ASR -> utter
  private fieldMath: FieldMath;
  private visuals: FieldVisuals;
  private puck = new PuckPhysics();
  private paddle: HandPaddle;
  private avatar: VectorAvatar;
  private scoreUI: ScoreUI;
  private fx: FXController;
  private vfx: VFXBursts;
  private lastBlipAt = -1;
  private startBtn: any;
  private replayBtn: any;
  private prevAvatarY = 0;
  private deco: DecoAnimator;
  private intro: IntroAssembler;
  private blockBurstT = 99;
  private servePending = false;
  private hiddenAtStart: SceneObject[] = [];
  private predictor = new GoaliePredictor();
  private visionFix: VisionFix | null = null;
  private visionStatus = "none";
  private rimT = 99;
  private rimAmp = 1.0; // concede storm multiplies the rim envelope
  private stormX = 0;
  private stormY = 0;
  private loseStormEvts: DelayedCallbackEvent[] = [];
  private stormEvt1: DelayedCallbackEvent | null = null;
  private stormEvt2: DelayedCallbackEvent | null = null;
  private bubbleObj: SceneObject | null = null;
  private bubbleText: any = null;
  private bubbleT = 99;
  private dustObj: SceneObject | null = null;
  private trailDots: TrailDots | null = null;
  private airTrails: AirTrails | null = null;
  private fieldCommitted = false;
  private warmupFrames = 0;
  private bootGuide: SceneObject | null = null;
  private bootGuideText: Text | null = null;
  private batteryObj: SceneObject | null = null;
  private batteryModel: ObjectPrefab | null = null;
  private batteryX = 0;
  private batteryY = 0;
  private batterySpawnT = 0;
  private batteryPulseT = 0;
  private decoAccum = 0;
  private syncAccum = 0;
  private lastPoseSeq = 0;
  private lastPoseAt = 0;
  private lastPoseX = 0;
  private lastPoseY = 0;
  private lastPoseDeg = 0;
  private dustFadeT = -1; // -1 idle, else 0..1 fade-in progress
  private lastCollisionSent = 0; // throttle robot collision-sound events
  private calib: SurfaceCalibration | null = null;
  private calibDone = false;
  private malletHint: SceneObject | null = null;
  private glowKit: GlowKit;

  private scorePlayer = 0;
  private scoreVector = 0;
  private stateT = 0;
  private puckSendAccum = 0;
  private robotState = "disconnected";

  onAwake() {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart() {
    if (!this.internetModule || !this.matCyan || !this.matMagenta) {
      log.e("Missing @input references — check Inspector wiring");
      return;
    }

    // Build the circuit-board field
    const glow = new GlowKit(this.matCyan, this.matMagenta);
    this.glowKit = glow;
    let vectorModel: ObjectPrefab | undefined;
    let tubeModel: ObjectPrefab | undefined;
    let capModel: ObjectPrefab | undefined;
    try {
      vectorModel = requireAsset("../Models/vector.obj") as ObjectPrefab;
    } catch (e) {
      log.w("vector.obj not importable — using occluder box");
    }
    let resModel: ObjectPrefab | undefined;
    let chipModel: ObjectPrefab | undefined;
    let btnModel: ObjectPrefab | undefined;
    let puckModel: ObjectPrefab | undefined;
    let malletModel: ObjectPrefab | undefined;
    try {
      tubeModel = requireAsset("../Models/neon_tube.glb") as ObjectPrefab;
      capModel = requireAsset("../Models/capacitor.glb") as ObjectPrefab;
      resModel = requireAsset("../Models/resistor.glb") as ObjectPrefab;
      chipModel = requireAsset("../Models/score_chip.glb") as ObjectPrefab;
      btnModel = requireAsset("../Models/arcade_button.glb") as ObjectPrefab;
      puckModel = requireAsset("../Models/puck.glb") as ObjectPrefab;
      malletModel = requireAsset("../Models/mallet.glb") as ObjectPrefab;
      this.batteryModel = requireAsset(
        "../Models/battery.glb") as ObjectPrefab;
    } catch (e) {
      log.w("prop GLBs missing — borders fall back to lines");
    }
    const builder = new FieldBuilder(
      this.getSceneObject(), glow, this.matOccluder, vectorModel,
      tubeModel, capModel, resModel, chipModel, puckModel, malletModel,
      this.matNeonGreen, this.matNeonPink, this.matMetal, this.matRim);
    builder.axleOffsetMm = this.axleOffsetMm;
    this.visuals = builder.build();
    this.fieldMath = new FieldMath(this.visuals.fieldRoot);
    this.paddle = new HandPaddle(this.fieldMath, this.useLeftHand ? "left" : "right");
    // the mallet is a PROJECTION under the hand: lightning in, lightning out
    this.visuals.paddleObj.enabled = false;
    this.paddle.onEnterField = (x, y) => {
      this.visuals.paddleObj.enabled = true;
      this.vfx.wallLightning(x, y);
      this.vfx.verticalBurst(x, y, false, 0.8);
      this.fx.play("mallet_grab");
    };
    this.paddle.onExitField = (x, y) => {
      this.visuals.paddleObj.enabled = false;
      this.vfx.wallLightning(x, y);
      this.fx.play("wall_zap", 0.4);
    };
    this.avatar = new VectorAvatar(this.fieldMath, this.visuals.avatarRoot);
    this.avatar.setPivots(this.visuals.headPivotObj, this.visuals.liftPivotObj,
      this.visuals.carriagePivotObj);
    this.scoreUI = new ScoreUI(this.visuals.fieldRoot, glow, chipModel, this.scoreFont, builder, btnModel);
    // NOT under fieldRoot — the blackout used to disable the audio
    this.fx = new FXController(this.getSceneObject());
    this.adoptDustEmitter();
    // PIPELINE WARM-UP: render the zone as a sub-pixel dot for the first
    // ~25 boot frames so every glow material compiles its GPU pipeline,
    // then hide it (pipelines stay cached). Full-size enable at confirm
    // used to freeze the lens for ~a second. NB: dot only lives during
    // the very first second — 100 additive quads stacked in 3mm otherwise
    // read as a weird glowing plasma blob at the calibration point.
    this.visuals.fieldRoot.enabled = true;
    this.visuals.fieldRoot.getTransform().setLocalScale(
      new vec3(0.005, 0.005, 0.005));
    this.warmupFrames = 25;
    // ...except a camera-locked guide, or the user stares into nothing
    const guide = global.scene.createSceneObject("BootGuide");
    guide.setParent(this.mainCamera.getSceneObject());
    const gtr = guide.getTransform();
    gtr.setLocalPosition(new vec3(0, -6, -60));
    gtr.setLocalRotation(quat.quatIdentity());
    const gt = guide.createComponent("Component.Text") as Text;
    gt.text = "HOLD YOUR PALM OVER THE TABLE";
    gt.size = 42;
    gt.textFill.color = new vec4(0.45, 1, 0.55, 1);
    if (this.scoreFont) {
      gt.font = this.scoreFont;
    }
    this.bootGuide = guide;
    this.bootGuideText = gt;
    this.hideSikCursors(); // direct interaction only — no ray cursor
    this.vfx = new VFXBursts(this.fieldMath, this.visuals.fieldRoot, glow);
    this.vfx.prewarmTreads();
    this.deco = new DecoAnimator(
      glow, this.visuals.fieldRoot,
      builder.arcs, builder.animRings, builder.blinkers, builder.tracePaths);
    this.intro = builder.intro;

    // ONE persistent circuit button: always present; lit when pressable
    this.startBtn = this.scoreUI.addButton("Start", "START", 0, -(GameConfig.FIELD_W / 2 + 65), () => {
      if (this.state === "PLACE_VECTOR"
                 || this.state === "DELOCALIZED") {
        this.fx.play("button_press");
        this.confirmPlacement(); // Vector is on his spot — (re)bind & go
      } else if (this.state === "GAME_OVER") {
        this.fx.play("button_press");
        this.scorePlayer = 0;
        this.scoreVector = 0;
        this.scoreUI.setScore(0, 0);
        // instant rematch ONLY when poses are fresh (transform still bound);
        // otherwise the bridge restarted -> honest re-placement
        const fresh = getTime() - this.lastPoseAt < 2.0;
        this.enter(fresh ? "ROBOT_TO_POST" : "PLACE_VECTOR");
      }
    });
    this.replayBtn = this.startBtn; // merged — the button never disappears
    this.scoreUI.setButtonVisible(this.startBtn, true);

    // Puck event wiring. Collision SOUNDS play FROM THE ROBOT (short Wwise
    // clips over the bridge) — the physical robot is the game's speaker;
    // lens keeps only the visuals. Rate-limited lens-side to spare the WS.
    this.puck.onGoal = (onVectorSide) => this.handleGoal(onVectorSide);
    this.puck.onWallBounce = () => {
      this.vfx.verticalBurst(this.puck.x, this.puck.y, false, 0.55);
      this.vfx.wallLightning(this.puck.x, this.puck.y); // tube gets angry
      this.sendCollision("puck_wall");
    };
    this.puck.onPaddleHit = () => {
      this.vfx.verticalBurst(this.puck.x, this.puck.y, false, 1.0);
      this.sendCollision("puck_paddle");
    };
    this.puck.onVectorHit = () => {
      this.rimT = 0; // robot lights up on the block
      this.blockBurstT = 0; // square PERIMETER flash (follows the robot)
      // physics contact jitter fires this in bursts (5x/50ms observed) —
      // same throttle as the other collisions
      this.sendCollision("vector_block");
    };

    // Place the field (debug: fixed spot in front of the camera on a virtual table)
    this.placeFieldDebug();
    this.enter("CALIBRATE");

    if (GameConfig.OFFLINE) {
      log.i("OFFLINE mode — scripted goalie");
      this.robotState = "offline";
      return;
    }

    // WS link
    this.ws = new WSClient(this.internetModule);
    // In-game Gemini voice agent (through the lens RSG, no Mac key): talk to Vector,
    // he answers in his own voice. Enabled by the Inspector's "voiceEnabled" +
    // "rsgToken" (or GameConfig.VOICE_ENABLED / RSG_GOOGLE_TOKEN); needs server VECTAR_CHAT=1.
    if (this.rsgToken) GameConfig.RSG_GOOGLE_TOKEN = this.rsgToken;
    const voiceOn = (this.voiceEnabled || GameConfig.VOICE_ENABLED)
                    && !!GameConfig.RSG_GOOGLE_TOKEN;
    if (voiceOn) {
      this.llm = new LLMProxy(this.ws);
      this.ws.onLlmRequest = (m) => this.llm.onLlmRequest(m);
      this.voice = new VoiceTalk(this.ws);
    }
    this.ws.onWelcome = (robot) => {
      this.robotState = robot;
      log.i("Bridge welcome, robot=" + robot);
      if (this.state === "CONNECT_WS") {
        this.enter("PLACE_VECTOR");
      }
      // START state waits for the player; welcome just updates the status
    };
    this.ws.onSay = (text) => {
      this.showBubble(text);
    };
    this.ws.onPose = (p) => {
      this.avatar.onPose(p);
      if (p.drv) {
        this.predictor.correct(p.x, p.y, p.deg);
      } else {
        // bridge is NOT driving (choreo/stop) — virtual must not run ahead
        this.predictor.reset(p.x, p.y, p.deg);
      }
      this.lastPoseSeq = p.seq;
      this.lastPoseAt = getTime();
      this.lastPoseX = p.x;
      this.lastPoseY = p.y;
      this.lastPoseDeg = p.deg;
    };
    this.setupVision(); // AFTER ws exists (was armed with undefined ws!)
    this.ws.onRobotStatus = (st: any) => {
      if ((this.state === "PLACE_VECTOR" || this.state === "DELOCALIZED")
          && !GameConfig.OFFLINE) {
        const down = !st.held && !st.cliff;
        this.scoreUI.setButtonLit(this.startBtn, down);
        this.scoreUI.setStatus(down
          ? "Press START"
          : (this.state === "DELOCALIZED"
             ? "Vector lost! Place him on the mark"
             : "Place Vector on the mark"));
      }
    };
    this.ws.onAnimDone = () => {
      if (this.state === "GOAL_PAUSE") {
        this.enter(this.isGameOver() ? "GAME_OVER" : "COUNTDOWN");
      }
    };
    this.ws.onRelocalized = () => {
      if (this.state === "DELOCALIZED") {
        log.i("RELOCALIZED by vision — resuming");
        this.enter("ROBOT_TO_POST");
      }
    };
    this.ws.onDelocalized = (reason) => {
      // stale bridge state must not hijack a fresh boot: before the game
      // is placed there is nothing to delocalize
      if (this.state === "BOOT" || this.state === "CALIBRATE"
          || this.state === "CONFIRM_FIELD" || this.state === "CONNECT_WS"
          || this.state === "PLACE_VECTOR") {
        return;
      }
      log.w("DELOCALIZED: " + reason);
      this.enter("DELOCALIZED");
    };
    this.ws.onDisconnected = () => {
      // pre-game states own their own flow — a ws blip must not teleport
      // the FSM past calibration and the pinch gate (it did: field spawned
      // at the default pose and never centered)
      if (this.state === "BOOT" || this.state === "CALIBRATE"
          || this.state === "CONFIRM_FIELD") {
        return;
      }
      this.enter("CONNECT_WS");
    };
    this.ws.connect(); // connects in the background during calibration
  }

  private placeFieldDebug() {
    // Field sits 60 cm in front of the camera, 40 cm below eye level,
    // player goal toward the camera. Good enough for preview; real
    // placement (hand calibration + pinch drag) comes with SurfacePlacement.
    const camTr = this.mainCamera.getSceneObject().getTransform();
    // camera looks down its local -Z; derive the look direction explicitly
    // (Transform.forward sign is a classic LS trap)
    const lookDir = camTr.getWorldRotation().multiplyVec3(new vec3(0, 0, -1));
    const flatFwd = new vec3(lookDir.x, 0, lookDir.z).normalize();
    const pos = camTr.getWorldPosition()
      .add(flatFwd.uniformScale(60))
      .add(new vec3(0, -40, 0));
    const tr = this.visuals.fieldRoot.getTransform();
    tr.setWorldPosition(pos);
    // orient so field +X (Vector's goal) points AWAY from the player:
    // local +X must align with the flattened view direction
    const yaw = Math.atan2(-flatFwd.z, flatFwd.x);
    tr.setWorldRotation(quat.angleAxis(yaw, vec3.up()));
    log.i("Field placed (debug) at " + pos.toString());
  }

  private enter(s: GameState) {
    log.i("STATE " + this.state + " -> " + s);
    this.state = s;
    this.stateT = 0;
    switch (s) {
      case "CONFIRM_FIELD":
        if (this.bootGuideText) {
          this.bootGuideText.text = "PINCH TO PLACE THE RINK";
        }
        break;
      case "CALIBRATE":
        // TableTop widget shows its own instruction — no duplicate text
        if (this.bootGuide) {
          this.bootGuide.enabled = false;
        }
        this.visuals.puckObj.enabled = false;
        this.visuals.padObj.enabled = false;
        if (this.visuals.cubePadObj) this.visuals.cubePadObj.enabled = false;
        this.intro.hideAll(); // the board does not exist yet
        this.hiddenAtStart = [];
        for (let i = 0; i < this.visuals.fieldRoot.getChildrenCount(); i++) {
          const ch = this.visuals.fieldRoot.getChild(i);
          if (ch.name !== "VectorPad" && ch.enabled) {
            ch.enabled = false;
            this.hiddenAtStart.push(ch);
          }
        }
        this.calibDone = false;
        if (!GameConfig.OFFLINE && !GameConfig.DEBUG_AUTOPLACE
            && !(this.editorSkipCalibration
                 && global.deviceInfoSystem.isEditor())) {
          this.calib = new SurfaceCalibration(this);
          this.startCalibrationLoop();
        }
        break;
      case "ROBOT_TO_POST":
        this.hideBigText();
        // the game zone assembles itself WHILE Vector drives to his goal
        this.visuals.padObj.enabled = false;
        if (this.visuals.cubePadObj) this.visuals.cubePadObj.enabled = false;
        this.scoreUI.setStatus("Vector driving to post...");
        this.avatar.x = 0;
        this.avatar.y = 0;
        this.avatar.deg = 180;
        this.intro.play();
        break;
      case "START":
        // hidden elements return WITH lightning around them
        for (const ch of this.hiddenAtStart) {
          ch.enabled = true;
        }
        this.hiddenAtStart = [];
        this.fx.play("ui_on");
        this.fx.play("cap_strike", 0.7);
        this.fx.playMusic(0.32); // ambient loop enters with the power-on
        // child the USER'S GPU emitter to the live fieldRoot and fade in
        let dust = this.dustObj;
        try {
          if (!dust || isNull(dust)) {
            dust = null;
          }
        } catch (e) {
          dust = null;
        }
        if (!dust) {
          for (let i = 0; i < global.scene.getRootObjectsCount(); i++) {
            const ro = global.scene.getRootObject(i);
            if (ro.name.indexOf("Helix") >= 0) {
              dust = ro;
              break;
            }
          }
          this.dustObj = dust;
        }
        if (dust) {
          dust.setParent(this.visuals.fieldRoot);
          const dtr = dust.getTransform();
          dtr.setLocalPosition(new vec3(0, 5, 0)); // PROVEN at 4; 10 and 6 = invisible
          dtr.setLocalRotation(quat.quatIdentity());
          // SCALE MUST BE EXACTLY 1: the GPU-instanced particle shader dies
          // under non-uniform scale (proven live — 1.4/0.7/1.0 = invisible,
          // 1/1/1 = swirls). Cloud is 35u ~ 35cm — fits the field as-is.
          dtr.setLocalScale(new vec3(1, 1, 1));
          dust.enabled = true;
          if (this.visuals.dustMat) {
            (this.visuals.dustMat.mainPass as any).fade = 0.0;
          }
          print("[DUST] emitter childed to field, world="
            + dtr.getWorldPosition());
        }
        this.dustFadeT = 0; // dust materializes over ~2.5s
        this.rimT = -0.2; // longer rim during the storm
        // LIGHTNING STORM: the whole circuit powers on
        this.vfx.capacitorStrike(0, -220, 2.2, 0.5); // the display chip
        this.vfx.capacitorStrike(0, 220, 2.2, 0.5);  // the START button
        this.vfx.capacitorStrike(0, 0, 2.2, 0.5);    // center court
        this.vfx.capacitorStrike(-120, 60, 2, 0.5);  // random board spots
        this.vfx.capacitorStrike(130, -70, 2, 0.5);
        this.vfx.capacitorStrike(60, 90, 2, 0.5);
        this.visuals.puckObj.enabled = false;
        this.visuals.padObj.enabled = false;
        if (this.visuals.cubePadObj) this.visuals.cubePadObj.enabled = false;
        this.scoreUI.setStatus("ROBO AIR-HOCKEY");
        break;
      case "CONNECT_WS":
        // reachable mid-game on WS drop — freeze the round cleanly
        this.servePending = false;
        this.visuals.puckObj.enabled = false;
        this.vfx?.clearStrikes();
        this.scoreUI?.setStatus("Connecting to Vector...");
        this.scoreUI?.setButtonLit(this.startBtn, false); // game running -> dim
        break;
        if (this.bootGuide && this.bootGuideText) {
          this.bootGuide.enabled = true;
          this.bootGuideText.text = "CONNECTING TO VECTOR...";
        }
      case "PLACE_VECTOR":
        this.visuals.fieldRoot.enabled = true; // surface found — lights on
        this.visuals.fieldRoot.getTransform().setLocalScale(
          new vec3(1, 1, 1)); // end of the warm-up dot
        if (this.bootGuide) {
          this.bootGuide.destroy();
          this.bootGuide = null;
          this.bootGuideText = null;
        }
        this.servePending = false;
        this.vfx.clearStrikes();
        this.visuals.padObj.enabled = true;
        if (this.visuals.cubePadObj && GameConfig.CUBE_ENABLED) this.visuals.cubePadObj.enabled = true;
        this.visuals.padObj.getTransform().setLocalPosition(new vec3(0, 0, 0));
        // ghost occluder sits ON the mark, nose to the player — align the
        // real robot with it
        {
          const atr = this.visuals.avatarRoot.getTransform();
          atr.setLocalPosition(this.fieldMath.fieldToLocal(0, 0, 0));
          atr.setLocalRotation(this.fieldMath.headingToLocalRotation(180));
        }
        if (GameConfig.OFFLINE && GameConfig.DEBUG_AUTOPLACE) {
          this.scoreUI.setButtonLit(this.startBtn, false);
          this.confirmPlacement();
        } else {
          // REAL robot: give the human time — place Vector, press START.
          // The blackout hid everything: reveal just the button + display
          this.revealFromBlackout(["BtnStart", "ScoreChip", "ScoreBlock",
                                   "StatusBlock", "VectorAvatar"]);
          // button lights only when the robot is DOWN (bridge held flag)
          this.scoreUI.setButtonLit(this.startBtn, false);
          this.scoreUI.setStatus("Place Vector on the mark");
        }
        break;
      case "COUNTDOWN":
        this.hideBigText();
        this.ws?.sendJson({ t: "event", name: "countdown",
                            score: [this.scorePlayer, this.scoreVector] });
        this.paddle.enabled = true; // hand-over-field now summons the mallet
        this.setMalletHint(false);
        this.visuals.padObj.enabled = false;
        if (this.visuals.cubePadObj) this.visuals.cubePadObj.enabled = false;
        this.visuals.puckObj.enabled = false; // appears via the summon bolts
        this.scoreUI.setStatus("Get ready...");
        break;
      case "RALLY":
        this.hideCountdown3D();

        this.scoreUI.setStatus("");
        // ALL 4 capacitors SUMMON the puck; it materializes in the flash
        this.visuals.puckObj.enabled = false;
        this.rimT = 0;
        this.vfx.capacitorStrike(0, 0, 4);
        this.fx.play("cap_strike");
        this.servePending = true;
        this.ws?.sendJson({ t: "event", name: "rally_start",
                            score: [this.scorePlayer, this.scoreVector] });
        break;
      case "GOAL_PAUSE":
        this.visuals.puckObj.enabled = false; // no frozen puck at the goal
        break;
      case "GAME_OVER": {
        this.paddle.enabled = false;
        this.visuals.paddleObj.enabled = false;
        const won = this.scorePlayer > this.scoreVector;
        this.fx.play("game_win");
        this.scoreUI.setButtonLit(this.startBtn, true); // pressable again
        this.scoreUI.setStatus(won ? "YOU WIN! 🏆" : "VECTOR WINS! 🤖");
        this.showBigText("GAME OVER", won ? "green" : "pink",
                         won ? "YOU WIN!" : "VECTOR WINS!");
        if (!won) {
          // he beat you — the WHOLE rink erupts while he dances
          if (this.loseStormEvts.length === 0) {
            for (let k = 0; k < 6; k++) {
              const dl = this.createEvent("DelayedCallbackEvent");
              dl.bind(() => {
                const rx = -120 + Math.random() * 240;
                const ry = (Math.random() * 2 - 1)
                  * (GameConfig.FIELD_W / 2 - 30);
                this.vfx.robotStorm(rx, ry, 4);
                this.fx.play("cap_strike", 0.5);
              });
              this.loseStormEvts.push(dl);
            }
          }
          for (let k = 0; k < this.loseStormEvts.length; k++) {
            this.loseStormEvts[k].reset(0.3 + k * 0.55);
          }
        }
        this.ws?.sendJson({ t: "event", name: "game_over",
                            score: [this.scorePlayer, this.scoreVector] });
        break;
      }
      case "DELOCALIZED":
        this.showBigText("RECALIBRATION", "pink",
                         "PLACE VECTOR ON THE MARK");

        // exactly like placement: mark at center, held-gated button, press
        // re-binds the transform and the game resumes via ROBOT_TO_POST
        this.servePending = false;
        this.paddle.enabled = false;
        this.visuals.paddleObj.enabled = false;
        this.visuals.puckObj.enabled = false;
        this.vfx.clearStrikes();
        this.visuals.padObj.enabled = true;
        if (this.visuals.cubePadObj && GameConfig.CUBE_ENABLED) this.visuals.cubePadObj.enabled = true;
        this.visuals.padObj.getTransform().setLocalPosition(new vec3(0, 0, 0));
        this.scoreUI.setButtonLit(this.startBtn, false);
        this.scoreUI.setStatus("Vector lost! Place him on the mark");
        break;
    }
  }

  /** 3D instruction: pulsing ring + label at the mallet — "grab it". */
  private setMalletHint(on: boolean) {
    if (on && !this.malletHint) {
      const h = global.scene.createSceneObject("MalletHint");
      h.setParent(this.visuals.paddleObj);
      this.glowKit.flatQuad(h, "MalletHintRing", 14, 14, "green", "ring", 0.12);
      const txtObj = global.scene.createSceneObject("MalletHintText");
      txtObj.setParent(h);
      const t = txtObj.createComponent("Component.Text") as Text;
      t.text = "HAND OVER THE FIELD";
      t.size = 26;
      t.textFill.color = new vec4(0.45, 1, 0.55, 1);
      if (this.scoreFont) {
        t.font = this.scoreFont;
      }
      const ttr = txtObj.getTransform();
      ttr.setLocalPosition(new vec3(0, 6.5, 0));
      ttr.setLocalRotation(quat.lookAt(new vec3(0, 1, 0), new vec3(1, 0, 0)));
      this.malletHint = h;
    }
    if (this.malletHint) {
      this.malletHint.enabled = on;
    }
  }

  /** Hand calibration MUST succeed before anything appears — on timeout
   * we simply try again (the hint stays up until the hand lands). */
  private startCalibrationLoop() {
    this.calib!.start(45, (ok) => {
      // the field is COMMITTED after the pinch — recalibration must never
      // move a live rink (it did: occluder/rim split, phantom escapes)
      // committed = the robot placement was confirmed at least once;
      // until then the field may follow recalibration freely
      if (this.fieldCommitted) {
        return; // stop the loop for good
      }
      if (!ok) {
        log.w("calibration timed out — restarting");
        this.startCalibrationLoop();
        return;
      }
      const plane = this.calib!.getSurfacePlane()!;
      const tr = this.visuals.fieldRoot.getTransform();
      tr.setWorldPosition(plane.pos);
      const camT = this.mainCamera.getSceneObject().getTransform();
      const look = camT.getWorldRotation()
        .multiplyVec3(new vec3(0, 0, -1));
      // long axis INTO the view: +X aligns with flattened look dir
      tr.setWorldRotation(quat.angleAxis(
        Math.atan2(-look.z, look.x), vec3.up()));
      this.calibDone = true; // ONLY a real success advances the flow
    });
  }

  /** Comic speech bubble above the REAL robot — duplicates his TTS. */
  private showBubble(text: string) {
    if (!this.bubbleObj) {
      this.bubbleObj = global.scene.createSceneObject("SpeechBubble");
      this.bubbleObj.setParent(this.visuals.fieldRoot);
      const t = this.bubbleObj.createComponent(
        "Component.Text3D") as any;
      t.font = this.scoreFont;
      t.size = 40;
      try {
        t.extrusionDepth = 1.2;
      } catch (e) {
      }
      const bm = this.glowKit!.solidTinted("green").clone();
      (bm.mainPass as any).baseColor = new vec4(0.5, 2.0, 0.85, 1); // brighter
      t.mainMaterial = bm;
      this.bubbleText = t;
    }
    this.bubbleText!.text = text;
    this.bubbleObj.enabled = true;
    this.bubbleT = 0;
  }

  private tickBubble(dt: number) {
    if (!this.bubbleObj || this.bubbleT > 2.2) {
      return;
    }
    this.bubbleT += dt;
    // ride above the robot (his lift tops ~9cm) + gentle rise
    const tr = this.bubbleObj.getTransform();
    tr.setLocalPosition(this.fieldMath.fieldToLocal(
      this.avatar.x, this.avatar.y, 11 + this.bubbleT * 1.2));
    // billboard to the player
    const camPos = this.mainCamera.getSceneObject()
      .getTransform().getWorldPosition();
    const p = tr.getWorldPosition();
    const dir = new vec3(camPos.x - p.x, 0, camPos.z - p.z).normalize();
    tr.setWorldRotation(quat.lookAt(dir, vec3.up()));
    // pop-in then fade-out
    // Text3D has NO textFill (that is 2D Text) — fade via scale only
    const a = this.bubbleT < 1.6 ? 1 : Math.max(0, 1 - (this.bubbleT - 1.6) / 0.6);
    const s = Math.min(1, this.bubbleT * 6) * (0.4 + 0.6 * a);
    // Z 0.3: VT323 extrusion reads as a slab at full depth (same fix as
    // the countdown / GAME OVER texts)
    tr.setLocalScale(new vec3(s, s, s * 0.3));
    if (this.bubbleT > 2.2) {
      this.bubbleObj.enabled = false;
    }
  }

  /** Any tracked hand as field-mm position + height (for palm buttons). */
  private palmField(): vec3 | null {
    for (const hn of ["right", "left"]) {
      const hand = SIK.HandInputData.getHand(hn as any);
      if (hand !== null && hand.isTracked() && hand.indexKnuckle !== null) {
        return this.fieldMath.worldToField3(hand.indexKnuckle.position);
      }
    }
    return null;
  }

  /** The game is direct-touch only: kill the SIK ray cursor visuals. */
  private hideSikCursors() {
    for (let i = 0; i < global.scene.getRootObjectsCount(); i++) {
      const root = global.scene.getRootObject(i);
      if (root.name.indexOf("SpectaclesInteractionKit") < 0) {
        continue;
      }
      const walk = (o: SceneObject) => {
        if (o.name === "InteractorCursors") {
          o.enabled = false;
          log.i("SIK cursors disabled");
          return;
        }
        for (let c = 0; c < o.getChildrenCount(); c++) {
          walk(o.getChild(c));
        }
      };
      walk(root);
    }
  }

  /** YOLO vision stack: camera -> detector -> surface projection ->
   * vision_fix to the bridge (see VisionFix.ts for the duty cycle). */
  private setupVision() {
    if (GameConfig.OFFLINE || !this.mlModel) {
      this.visionStatus = "OFF(m:" + (this.mlModel ? "ok" : "X") + ")";
      print("[VISION] " + this.visionStatus);
      return;
    }
    const visObj = global.scene.createSceneObject("Vision");
    visObj.setParent(this.getSceneObject());
    // DISABLED object defers onAwake — set the @inputs BEFORE lifecycle
    visObj.enabled = false;
    const ml = visObj.createComponent(
      CoffeeMLController.getTypeName()) as CoffeeMLController;
    (ml as any).model = this.mlModel;
    (ml as any).scoreThreshold = this.visionScoreThreshold;
    (ml as any).iouThreshold = this.visionIouThreshold;
    (ml as any).frameSkip = this.visionFrameSkip;
    (ml as any).applySigmoid = this.visionApplySigmoid;
    (ml as any).debugLog = this.visionDebugLog;
    visObj.enabled = true; // inputs in place — lifecycle may run now
    ml.start();
    const host = {
      getCameraTexture: () => ml.getDisplayTexture(),
      getWorldCamera: () => this.mainCamera,
      getSurfaceYForProjection: () =>
        this.visuals.fieldRoot.getTransform().getWorldPosition().y,
    };
    const projector = new CameraSurfaceProjector(host as any);
    this.visionFix = new VisionFix(
      ml, projector, this.ws!, this.visuals.fieldRoot, this.fieldMath,
      () => Math.abs(this.avatar.vy),
      () => this.mainCamera.getSceneObject().getTransform().getWorldPosition());
    this.visionFix.depthOffsetMm = this.visionDepthOffsetMm;
    // visible marker: a small neon quad lands where YOLO thinks Vector is
    const marker = this.glowKit.flatQuad(
      this.visuals.fieldRoot, "VisionMarker", 44, 44, "pink", "disc", 0.35);
    marker.enabled = false;
    let display: vec3 | null = null;
    this.visionFix.debugLog = this.visionDebugLog;
    this.visionFix.onEstimate = (x, y, conf) => {
      marker.enabled = this.visionShowMarker;
    };
    // their glideToTarget: frame-rate-independent ease, smoothingRate=6
    const glide = this.createEvent("UpdateEvent");
    glide.bind(() => {
      const target = this.visionFix ? this.visionFix.targetWorld : null;
      if (!target || !marker.enabled) {
        return;
      }
      const t = 1 - Math.exp(-6 * getDeltaTime());
      display = display === null ? target : vec3.lerp(display, target, t);
      const local = this.fieldMath.worldToField(display);
      marker.getTransform().setLocalPosition(
        this.fieldMath.fieldToLocal(local.x, local.y, 0.3));
    });
    this.visionStatus = "ARMED16";
    print("[VISION] ARMED (proven pipeline) — marker ready");
  }

  /** Pull specific objects out of the calibration blackout early. */
  private revealFromBlackout(names: string[]) {
    for (let i = this.hiddenAtStart.length - 1; i >= 0; i--) {
      const ch = this.hiddenAtStart[i];
      if (names.indexOf(ch.name) >= 0) {
        ch.enabled = true;
        this.hiddenAtStart.splice(i, 1);
      }
    }
  }

  /** Find the hand-placed "Helix Emitter", parent it to the field
   * (world transform preserved) and take over its material for the
   * fade choreography + our colors. */
  private adoptDustEmitter() {
    for (let i = 0; i < global.scene.getRootObjectsCount(); i++) {
      const so = global.scene.getRootObject(i);
      if (so.name.indexOf("Helix") < 0) {
        continue;
      }
      // USER'S GPU particles — touch NOTHING except enabled + (later) fade.
      // Writing non-existent pass props (colors/scale) corrupts bindings
      // in 5.15 — the pass exposes ONLY: Custom Map, fade.
      this.dustObj = so;
      const rmv = so.getComponent(
        "Component.RenderMeshVisual") as RenderMeshVisual;
      if (rmv && rmv.mainMaterial) {
        this.visuals.dustMat = rmv.mainMaterial;
      }
      so.enabled = false; // hidden until the START storm
      print("[DUST] adopted " + so.name
        + " mat=" + (this.visuals.dustMat ? "ok" : "none"));
      return;
    }
    print("[DUST] Helix Emitter NOT FOUND in scene roots");
  }

  private tickBattery(dt: number) {
    if (this.state !== "RALLY") {
      if (this.batteryObj && this.batteryObj.enabled
          && this.state !== "GOAL_PAUSE") {
        this.despawnBattery();
      }
      return;
    }
    if (!this.batteryObj || !this.batteryObj.enabled) {
      this.batterySpawnT += dt;
      if (this.batterySpawnT > GameConfig.BATTERY_SPAWN_S) {
        this.spawnBattery();
      }
      return;
    }
    // pulse so it reads as a pickup
    this.batteryPulseT += dt;
    const p = 0.8 + 0.25 * Math.sin(this.batteryPulseT * 5);
    this.batteryObj.getTransform().setLocalScale(new vec3(p, p, p));
    // pickup: puck must HIT the cell; owner = whoever hit the puck last
    if (this.puck.active && this.puck.lastHitter !== "") {
      const dx = this.puck.x - this.batteryX;
      const dy = this.puck.y - this.batteryY;
      const rr = GameConfig.BATTERY_RADIUS_MM + GameConfig.PUCK_R;
      if (dx * dx + dy * dy < rr * rr) {
        const side = this.puck.lastHitter;
        this.puck.boostSide = side;
        // immediate drama: current flight doubles
        this.puck.vx *= 2;
        this.puck.vy *= 2;
        this.fx.play("cap_strike");
        this.fx.play("game_win", 0.5);
        this.vfx.robotStorm(this.batteryX, this.batteryY, 5);
        this.scoreUI.setStatus(side === "player"
          ? "POWER CELL: YOU" : "POWER CELL: VECTOR");
        this.ws?.sendJson({ t: "event",
                            name: side === "vector"
                              ? "battery_picked_vector"
                              : "battery_picked_player",
                            score: [this.scorePlayer, this.scoreVector] });
        this.despawnBattery();
      }
    }
  }

  private materializeBattery(obj: SceneObject) {
    const n = obj.name;
    const rmvs = obj.getComponents("Component.RenderMeshVisual");
    for (let i = 0; i < rmvs.length; i++) {
      const rmv = rmvs[i] as RenderMeshVisual;
      if (n.indexOf("glow_") === 0) {
        rmv.mainMaterial = this.matNeonGreen;
      } else if (n.indexOf("dark_") === 0) {
        rmv.mainMaterial = this.glowKit!.darkMaterial();
        rmv.setRenderOrder(-5);
      } else if (n.indexOf("solid_") === 0) {
        rmv.mainMaterial = this.glowKit!.solidTinted("green");
        rmv.setRenderOrder(-5);
      }
    }
    for (let i = 0; i < obj.getChildrenCount(); i++) {
      this.materializeBattery(obj.getChild(i));
    }
  }

  private spawnBattery() {
    this.batterySpawnT = 0;
    this.batteryPulseT = 0;
    // center band both sides can reach
    this.batteryX = -60 + Math.random() * 120;
    this.batteryY = (Math.random() * 2 - 1) * (GameConfig.FIELD_W / 2 - 60);
    const g = this.glowKit!;
    if (!this.batteryObj) {
      // built ONCE and pooled — GLB instantiate mid-rally is a frame spike
      if (this.batteryModel) {
        this.batteryObj = global.scene.createSceneObject("PowerCell");
        this.batteryObj.setParent(this.visuals.fieldRoot);
        const bm = this.batteryModel.instantiate(this.batteryObj);
        bm.getTransform().setLocalScale(new vec3(1, 1, 1)); // GLB root x100
        this.materializeBattery(bm);
        g.flatQuad(this.batteryObj, "CellPool", 7, 7, "green", "disc", 0.08);
      } else {
        this.batteryObj = g.cylinderGlow(this.visuals.fieldRoot, "PowerCell",
                                         1.6, 4.2, "green");
      }
    }
    this.batteryObj.enabled = true;
    this.batteryObj.getTransform().setLocalPosition(
      this.fieldMath.fieldToLocal(this.batteryX, this.batteryY, 0.4));
    this.fx.play("puck_spawn", 0.8);
    this.ws?.sendJson({ t: "battery",
                        on: 1, x: this.batteryX, y: this.batteryY });
  }

  private despawnBattery() {
    if (this.batteryObj) {
      this.batteryObj.enabled = false; // pooled — never destroyed
    }
    this.batterySpawnT = 0;
    this.ws?.sendJson({ t: "battery", on: 0, x: 0, y: 0 });
  }

  private cd3dObj: SceneObject | null = null;
  private cd3dText: Text3D | null = null;
  private cd3dLast = -1;

  private showCountdown3D(sec: number, tLeft: number) {
    if (!this.cd3dObj) {
      this.cd3dObj = global.scene.createSceneObject("Countdown3D");
      this.cd3dObj.setParent(this.visuals.fieldRoot);
      const t3 = this.cd3dObj.createComponent(
        "Component.Text3D") as Text3D;
      t3.text = "3";
      t3.size = 64;
      if (this.scoreFont) {
        t3.font = this.scoreFont;
      }
      try {
        (t3 as any).extrusionDepth = 1.6;
      } catch (e) {
      }
      t3.mainMaterial = this.glowKit!.solidTinted("green");
      this.cd3dText = t3;
    }
    this.cd3dObj.enabled = true;
    if (this.cd3dText && sec !== this.cd3dLast) {
      this.cd3dLast = sec;
      this.cd3dText.text = "" + sec;
    }
    // center of the rink, floats + pops on each tick
    const frac = tLeft - Math.floor(tLeft);
    const pop = 1 + 0.35 * Math.max(0, frac - 0.7) / 0.3;
    const tr = this.cd3dObj.getTransform();
    tr.setLocalPosition(this.fieldMath.fieldToLocal(0, 0, 10));
    // exact same proportions as the GAME OVER text (proven on device);
    // pop scales in-plane only so the glyphs never turn into a strip
    tr.setLocalScale(new vec3(pop * 4.6, pop * 2.88, 0.1));
    // face the player; guard the degenerate case (camera straight above
    // the rink center -> xz direction ~0 -> garbage quat = edge-on text)
    const camPos = this.mainCamera.getSceneObject()
      .getTransform().getWorldPosition();
    const p = tr.getWorldPosition();
    const flat = new vec3(camPos.x - p.x, 0, camPos.z - p.z);
    if (flat.length > 3) {
      tr.setWorldRotation(quat.lookAt(flat.normalize(), vec3.up()));
    }
  }

  private hideCountdown3D() {
    if (this.cd3dObj) {
      this.cd3dObj.enabled = false;
      this.cd3dLast = -1;
    }
  }

  private fieldGhost: SceneObject | null = null;
  private wasPinching = true; // true at boot: require a RELEASE first

  private tickFieldGhost() {
    if (!this.fieldGhost) {
      const g = this.glowKit!;
      this.fieldGhost = global.scene.createSceneObject("FieldGhost");
      const L = GameConfig.FIELD_L / 10;
      const W = GameConfig.FIELD_W / 10;
      // thin OUTLINE only — a filled quad read as a huge green
      // gradient plane hovering at the detection point
      const hw = W / 2, hl = L / 2;
      g.line(this.fieldGhost, "GhostN", -hw, -hl, hw, -hl, 0.5, "green", 0.1);
      g.line(this.fieldGhost, "GhostS", -hw, hl, hw, hl, 0.5, "green", 0.1);
      g.line(this.fieldGhost, "GhostW", -hw, -hl, -hw, hl, 0.5, "green", 0.1);
      g.line(this.fieldGhost, "GhostE", hw, -hl, hw, hl, 0.5, "green", 0.1);
      const ring = g.flatQuad(this.fieldGhost, "GhostRing",
                              10, 10, "pink", "ring", 0.2);
      ring.getTransform().setLocalPosition(new vec3(0, 0.2, 0));
    }
    // follow the (still hidden) fieldRoot — recalibration keeps updating it
    const src = this.visuals.fieldRoot.getTransform();
    const tr = this.fieldGhost.getTransform();
    tr.setWorldPosition(src.getWorldPosition());
    tr.setWorldRotation(src.getWorldRotation());
  }

  private destroyFieldGhost() {
    if (this.fieldGhost) {
      this.fieldGhost.destroy();
      this.fieldGhost = null;
    }
  }

  private bigTextObj: SceneObject | null = null;
  private bigT3: any = null;
  private bigSub: any = null;

  private showBigText(title: string, color: string, sub: string) {
    if (!this.bigTextObj) {
      this.bigTextObj = global.scene.createSceneObject("BigText");
      this.bigTextObj.setParent(this.visuals.fieldRoot);
      const t3 = this.bigTextObj.createComponent(
        "Component.Text3D") as any;
      t3.size = 84;
      if (this.scoreFont) {
        t3.font = this.scoreFont;
      }
      this.bigT3 = t3;
      const subObj = global.scene.createSceneObject("BigTextSub");
      subObj.setParent(this.bigTextObj);
      subObj.getTransform().setLocalPosition(new vec3(0, -11, 0));
      const s3 = subObj.createComponent("Component.Text3D") as any;
      s3.size = 40;
      if (this.scoreFont) {
        s3.font = this.scoreFont;
      }
      this.bigSub = s3;
    }
    this.bigTextObj.enabled = true;
    this.bigT3.text = title;
    this.bigSub.text = sub;
    for (const t of [this.bigT3, this.bigSub]) {
      t.mainMaterial = this.glowKit!.solidTinted(
        color === "green" ? "green" : "pink");
    }
    const tr = this.bigTextObj.getTransform();
    tr.setLocalPosition(this.fieldMath.fieldToLocal(0, 0, 16));
    tr.setLocalScale(new vec3(1.15, 0.72, 1));
    const camPos = this.mainCamera.getSceneObject()
      .getTransform().getWorldPosition();
    const p = tr.getWorldPosition();
    const flat = new vec3(camPos.x - p.x, 0, camPos.z - p.z);
    if (flat.length > 3) {
      tr.setWorldRotation(quat.lookAt(flat.normalize(), vec3.up()));
    }
  }

  private hideBigText() {
    if (this.bigTextObj) {
      this.bigTextObj.enabled = false;
    }
  }

  private confirmPlacement() {
    this.fieldCommitted = true;
    this.ws?.sendJson({
      t: "place_confirm",
      field: { L: GameConfig.FIELD_L, W: GameConfig.FIELD_W },
      robotFieldPose: { x: 0, y: 0, deg: 180 }, // center of the calib point
    });
    this.predictor.reset(0, 0, 180);
    this.enter("ROBOT_TO_POST");
  }

  /** Collision -> the ROBOT plays the sound (short on-robot clip via the
   *  bridge). Throttled: wall bounces can burst several per second. */
  private sendCollision(name: string) {
    const now = getTime();
    if (now - this.lastCollisionSent < 0.3) return;
    this.lastCollisionSent = now;
    this.ws?.sendJson({ t: "event", name: name,
                        score: [this.scorePlayer, this.scoreVector] });
  }

  private handleGoal(onVectorSide: boolean) {
    this.puck.boostSide = ""; // power expires at a goal
    this.despawnBattery();
    if (onVectorSide) {
      this.scorePlayer++;
    } else {
      this.scoreVector++;
    }
    this.scoreUI.setScore(this.scorePlayer, this.scoreVector);
    this.visuals.puckObj.enabled = false;
    // the puck DIES through lightning: ALL FOUR caps execute it
    this.rimT = -0.15;
    if (onVectorSide) {
      // conceded: the storm crawls OVER his real body + rim flares hard
      // MeshBuilder arcs are pricey — spread creation over 3 frames-ish
      this.vfx.robotStorm(this.avatar.x, this.avatar.y, 6);
      this.stormX = this.avatar.x;
      this.stormY = this.avatar.y;
      if (!this.stormEvt1) {
        this.stormEvt1 = this.createEvent("DelayedCallbackEvent");
        this.stormEvt1.bind(() => this.vfx.robotStorm(this.stormX, this.stormY, 6));
        this.stormEvt2 = this.createEvent("DelayedCallbackEvent");
        this.stormEvt2.bind(() => this.vfx.robotStorm(this.stormX, this.stormY, 8));
      }
      this.stormEvt1.reset(0.12);
      this.stormEvt2.reset(0.28);
      this.rimT = -0.5;   // longer envelope
      this.rimAmp = 2.6;  // and much brighter
      // damage reads PINK, not green
      (this.visuals.rimMat.mainPass as any).rimTint =
        new vec4(1.0, 0.3, 0.75, 1.0);
    }
    this.vfx.capacitorStrike(this.puck.x, this.puck.y, 4, 0.22);
    this.vfx.wallLightning(this.puck.x, this.puck.y);
    this.fx.play("cap_strike");
    this.fx.play("wall_zap", 0.6);
    this.vfx.goalAbsorb(this.puck.x, this.puck.y, onVectorSide);
    this.fx.play(onVectorSide ? "goal_score" : "goal_concede");
    this.scoreUI.setStatus(onVectorSide ? "GOAL! 🎉" : "Vector scores!");
    this.ws?.sendJson({
      t: "event",
      name: onVectorSide ? "goal_player" : "goal_vector",
      score: [this.scorePlayer, this.scoreVector],
    });
    this.enter("GOAL_PAUSE");
  }

  private isGameOver(): boolean {
    return (
      this.scorePlayer >= GameConfig.WIN_SCORE ||
      this.scoreVector >= GameConfig.WIN_SCORE
    );
  }

  private onUpdate() {
    const dt = getDeltaTime();
    if (!this.visuals) {
      return;
    }
    this.ws?.tick(dt);
    this.voice?.tick(dt);
    this.paddle.tick(dt);
    this.avatar.tick(dt);
    this.scoreUI.tick(dt);
    this.scoreUI.tickButtons(dt, this.palmField());
    this.vfx.tick(dt);
    // decorative layer (pulses, dust, arcs, blinks) at 30 Hz — the small
    // stuff doesn't need frame rate; speeds stay correct via accumulated dt
    this.decoAccum += dt;
    if (this.decoAccum >= 1 / 30) {
      this.deco.tick(this.decoAccum);
      this.decoAccum = 0;
    }
    this.intro.tick(dt);
    this.fx.tick(dt); // music fade ramp
    this.fx.tickTime(dt); // sfx cooldown clock
    this.tickBubble(dt);
    this.tickBattery(dt);
    this.visionFix?.tick(dt);
    // [SYNC] telemetry: rendered avatar vs last bridge pose, 2 Hz
    this.syncAccum += dt;
    if (this.syncAccum > 2.0 && !GameConfig.OFFLINE) {
      this.syncAccum = 0;
      const age = ((getTime() - this.lastPoseAt) * 1000).toFixed(0);
      print("[SYNC-LENS] st=" + this.state
        + " render=(" + this.avatar.x.toFixed(0) + ","
        + this.avatar.y.toFixed(0) + "," + this.avatar.deg.toFixed(0) + ")"
        + " pose#" + this.lastPoseSeq
        + "=(" + this.lastPoseX.toFixed(0) + "," + this.lastPoseY.toFixed(0)
        + "," + this.lastPoseDeg.toFixed(0) + ") age=" + age + "ms"
        + " puck=(" + this.puck.x.toFixed(0) + "," + this.puck.y.toFixed(0) + ")"
        + " vis=" + this.visionStatus
        + (this.visionFix
           ? " det=" + this.visionFix.detCount + " sent=" + this.visionFix.sentCount
           : ""));
    }
    // ZERO-LATENCY OCCLUDER: local goalie mirror leads, poses correct
    if (!GameConfig.OFFLINE && GameConfig.PREDICTIVE_OCCLUDER) {
      const inPlay = this.state === "ROBOT_TO_POST" || this.state === "START"
        || this.state === "COUNTDOWN" || this.state === "RALLY"
        || this.state === "GOAL_PAUSE";
      if (inPlay) {
        this.predictor.tick(dt, this.state === "RALLY",
          this.puck.x, this.puck.y, this.puck.vx, this.puck.vy,
          this.puck.active);
        this.avatar.setPredictedPose(
          this.predictor.x, this.predictor.y, this.predictor.deg);
      } else {
        this.avatar.clearPredicted();
      }
    }
    // ambient dust fade-in (materializes with the power-on storm)
    if (this.dustFadeT >= 0 && this.visuals.dustMat) {
      this.dustFadeT = Math.min(1, this.dustFadeT + dt / 2.5);
      const e = this.dustFadeT * this.dustFadeT * (3 - 2 * this.dustFadeT);
      (this.visuals.dustMat.mainPass as any).fade = e;
      if (this.dustFadeT >= 1) {
        this.dustFadeT = -1;
      }
    }
    // the mallet's light pool stays ON the table, tracking its x/z
    this.visuals.paddleGlowObj.getTransform().setLocalPosition(
      this.fieldMath.fieldToLocal(this.paddle.x, this.paddle.y, 0));

    // placement hint: the ghost's rim breathes so the user knows where
    // (and which way) to put the real robot
    if ((this.state === "PLACE_VECTOR" || this.state === "DELOCALIZED")
        && this.visuals.rimMat) {
      // placement beacon: deeper, brighter, faster breathing
      const pulse = 0.5 + 0.75 * (0.5 + 0.5 * Math.sin(getTime() * 4.2));
      (this.visuals.rimMat.mainPass as any).rimBoost = pulse;
    }
    // rim light: smooth intensity envelope with electric jitter
    if (this.rimT < 0.45 && this.visuals.rimMat) {
      this.rimT += dt;
      const k = Math.max(0, Math.min(1, this.rimT / 0.45));
      const env = Math.pow(1 - k, 1.4) * 2.0 * (0.7 + Math.random() * 0.5)
        * this.rimAmp;
      this.visuals.rimMat.mainPass.rimBoost = env;
      this.rimAmp += (1.0 - this.rimAmp) * Math.min(1, dt * 2.5);
      if (this.rimT >= 0.45) {
        this.visuals.rimMat.mainPass.rimBoost = 0.0;
        this.rimT = 99;
        this.rimAmp = 1.0;
        (this.visuals.rimMat.mainPass as any).rimTint =
          new vec4(0.35, 1.0, 0.5, 1.0); // back to green
      }
    }
    if (this.malletHint && this.malletHint.enabled) {
      const ps = 1 + Math.sin(getTime() * 4) * 0.12;
      this.malletHint.getTransform().setLocalScale(new vec3(ps, 1, ps));
      if (this.paddle.tracking) {
        this.fx.play("mallet_grab");
        this.setMalletHint(false); // grabbed — instruction done
      }
    }
    // square perimeter block burst: walls shoot up and fade out
    if (this.blockBurstT < 0.45) {
      this.blockBurstT += dt;
      const bb = this.visuals.blockBurstObj;
      const k = Math.min(1, this.blockBurstT / 0.45);
      bb.enabled = true;
      const e = 1 - (1 - k) * (1 - k);
      bb.getTransform().setLocalScale(new vec3(1.45, 0.2 + e * 1.3, 1.45));
      if (k >= 1) {
        bb.enabled = false;
        this.blockBurstT = 99;
      }
    }
    // motion sparks behind the (digital or real) Vector
    const avatarVy = (this.avatar.y - this.prevAvatarY) / Math.max(dt, 1e-4);
    this.prevAvatarY = this.avatar.y;
    if (this.avatar.hasPose || GameConfig.OFFLINE) {
      // motion FX only during play — the intro drive to the post left a
      // stray piece of trail right after surface confirm
      const motionFx = this.state === "RALLY" || this.state === "GOAL_PAUSE"
        || this.state === "COUNTDOWN";
      const fxVy = motionFx ? avatarVy : 0;
      this.vfx.motionSparks(dt, this.avatar.x, this.avatar.y, fxVy);
      if (!this.trailDots && this.glowKit) {
        this.trailDots = new TrailDots(
          this.glowKit, this.visuals.fieldRoot, this.fieldMath);
      }
      this.trailDots?.update(dt, this.avatar.x, this.avatar.y,
        this.avatar.deg, motionFx && Math.abs(fxVy) > 25);
      if (!this.airTrails && this.glowKit) {
        this.airTrails = new AirTrails(
          this.glowKit, this.visuals.fieldRoot, this.fieldMath);
      }
      this.airTrails?.update(dt, this.avatar.x, this.avatar.y,
        this.avatar.deg, motionFx && Math.abs(fxVy) > 60);
    }
    this.stateT += dt;

    // paddle visual follows even outside rallies
    this.visuals.paddleObj
      .getTransform()
      .setLocalPosition(this.fieldMath.fieldToLocal(this.paddle.x, this.paddle.y, 0));

    if (this.warmupFrames > 0) {
      this.warmupFrames--;
      if (this.warmupFrames === 0 && this.state !== "PLACE_VECTOR"
          && !this.fieldCommitted) {
        this.visuals.fieldRoot.enabled = false; // warm-up done, hide
      }
    }
    switch (this.state) {
      case "CONNECT_WS": {
        if (this.robotState !== "" && this.robotState !== "disconnected"
            && this.stateT > 0.2) {
          // welcome already arrived while we were calibrating
          this.enter("PLACE_VECTOR");
        }
        break;
      }
      case "CALIBRATE": {
        if (this.editorSkipCalibration && global.deviceInfoSystem.isEditor()) {
          // EDITOR DEBUG: surface = world origin, no hand calibration
          const tr = this.visuals.fieldRoot.getTransform();
          tr.setWorldPosition(new vec3(0, 0, 0));
          tr.setWorldRotation(quat.quatIdentity());
          this.enter(GameConfig.OFFLINE ? "PLACE_VECTOR" : "CONNECT_WS");
          break;
        }
        const offline = GameConfig.OFFLINE || GameConfig.DEBUG_AUTOPLACE;
        if ((offline && this.stateT > 1.2) || (!offline && this.calibDone)) {
          if (offline) {
            this.placeFieldDebug();
          }
          this.enter(GameConfig.OFFLINE ? "PLACE_VECTOR" : "CONFIRM_FIELD");
        }
        break;
      }
      case "CONFIRM_FIELD": {
        // resting hands complete TableTop calibration by ACCIDENT — show a
        // dim ghost of the rink and demand a deliberate PINCH to commit.
        // EDGE-detected: a pinch held from before must not auto-confirm.
        this.tickFieldGhost();
        const pinch = this.isAnyHandPinching();
        if (this.stateT > 0.6 && pinch && !this.wasPinching) {
          this.destroyFieldGhost();
          this.enter("CONNECT_WS");
        }
        this.wasPinching = pinch;
        break;
      }
      case "ROBOT_TO_POST": {
        if (GameConfig.OFFLINE) {
          // OFFLINE: scripted avatar drive to the post
          const k = Math.min(1, this.stateT / 3.0);
          const e = 1 - (1 - k) * (1 - k);
          this.avatar.x = GameConfig.GOALIE_X * e;
          const tr = this.visuals.avatarRoot.getTransform();
          tr.setLocalPosition(this.fieldMath.fieldToLocal(this.avatar.x, 0, 0));
          tr.setLocalRotation(this.fieldMath.headingToLocalRotation(180));
          if (this.stateT > 3.4 && !this.intro.playing) {
            this.enter("START");
          }
        } else {
          // ONLINE: the REAL pose stream owns the avatar (no ghost lerp);
          // advance when the robot actually reached the post (or timeout)
          const arrived = this.avatar.hasPose &&
            Math.abs(this.avatar.x - GameConfig.GOALIE_X) < 30;
          if ((arrived || this.stateT > 10.0) && !this.intro.playing) {
            this.enter("START");
          }
        }
        break;
      }
      case "START": {
        // power-on storm is an AUTO phase — no extra button press
        if (this.stateT > 2.6 && !this.intro.playing) {
          this.enter("COUNTDOWN");
        }
        break;
      }

      case "COUNTDOWN": {
        // always a 3-2-1 count, but stretched across the full COUNTDOWN_S
        // (each digit shows ~COUNTDOWN_S/3 s). Maps the window to 3 slots.
        const remain = GameConfig.COUNTDOWN_S - this.stateT;
        const secLeft = Math.max(1, Math.min(3,
          Math.ceil(remain / GameConfig.COUNTDOWN_S * 3)));
        this.scoreUI.setStatus("" + secLeft);
        this.showCountdown3D(secLeft, remain);
        if (secLeft !== this.lastBlipAt) {
          this.lastBlipAt = secLeft;
          this.fx.play("countdown_blip", 0.6);
        }
        if (this.stateT >= GameConfig.COUNTDOWN_S) {
          this.lastBlipAt = -1;
          this.enter("RALLY");
        }
        break;
      }

      case "RALLY": {
        if (this.servePending && this.stateT > 0.3) {
          this.servePending = false;
          this.visuals.puckObj.enabled = true;
          this.fx.play("puck_spawn");
          this.puck.serve(Math.random() < 0.5);
          this.vfx.blockFlash(0, 0); // serve flash at center
          this.fx.play("cap_strike", 0.35);
        }
        const paddleCircle = this.paddle.tracking
          ? { x: this.paddle.x, y: this.paddle.y,
              vx: this.paddle.vx, vy: this.paddle.vy,
              r: GameConfig.PADDLE_R }
          : null;
        const vectorCircle = this.avatar.hasPose || GameConfig.OFFLINE
          ? { x: this.avatar.x, y: this.avatar.y,
              vx: 0, vy: this.avatar.vy, r: GameConfig.VECTOR_BODY_R }
          : null;
        this.puck.tick(dt, paddleCircle, vectorCircle);
        this.visuals.puckObj
          .getTransform()
          .setLocalPosition(this.fieldMath.fieldToLocal(this.puck.x, this.puck.y, 0));
        this.vfx.puckTrail(dt, this.puck.x, this.puck.y, this.puck.active);

        // stream puck state at 20 Hz
        this.puckSendAccum += dt;
        if (this.puckSendAccum >= 1.0 / GameConfig.PUCK_SEND_HZ) {
          this.puckSendAccum = 0;
          this.ws?.sendJson({
            t: "puck",
            x: Math.round(this.puck.x * 10) / 10,
            y: Math.round(this.puck.y * 10) / 10,
            vx: Math.round(this.puck.vx * 10) / 10,
            vy: Math.round(this.puck.vy * 10) / 10,
            ts: getTime(),
          });
        }
        break;
      }

      case "GOAL_PAUSE":
        // bridge choreography ends with anim_done; timeout as fallback
        if (this.stateT > GameConfig.GOAL_PAUSE_TIMEOUT_S || GameConfig.OFFLINE) {
          if (this.stateT > (GameConfig.OFFLINE ? 2.0 : GameConfig.GOAL_PAUSE_TIMEOUT_S)) {
            this.enter(this.isGameOver() ? "GAME_OVER" : "COUNTDOWN");
          }
        }
        break;

      case "GAME_OVER":
        // waits for the REPLAY plane button (editor: auto after 12 s)
        if (global.deviceInfoSystem.isEditor() && this.stateT > 12.0) {
          this.scorePlayer = 0;
          this.scoreVector = 0;
          this.scoreUI.setScore(0, 0);
          this.enter("PLACE_VECTOR");
        }
        break;

      case "DELOCALIZED":
        // resume via auto-confirm in debug; real flow waits for pinch confirm
        if (GameConfig.DEBUG_AUTOPLACE && this.stateT > 4.0 && this.avatarLinkOk()) {
          this.confirmPlacement();
        }
        break;
    }

    // edge slam sparks (paddle pressed against the boundary)
    if (this.paddle.edgeContact !== null) {
      this.vfx.edgeSparks(this.paddle.edgeContact.x, this.paddle.edgeContact.y, dt);
    }

    // OFFLINE scripted goalie: chase the puck, FACE the puck (like the
    // real showman goalie does)
    const inPlay = this.state === "COUNTDOWN" || this.state === "RALLY" ||
      this.state === "GOAL_PAUSE" || this.state === "GAME_OVER";
    if (GameConfig.OFFLINE && inPlay) {
      const target = this.puck.active
        ? Math.max(-70, Math.min(70, this.puck.y))
        : 0;
      this.avatar.y += (target - this.avatar.y) * Math.min(1, dt * 3);
      this.avatar.x = GameConfig.GOALIE_X;
      const targetDeg = this.puck.active
        ? (Math.atan2(this.puck.y - this.avatar.y,
                      this.puck.x - this.avatar.x) * 180) / Math.PI
        : 180;
      let dDeg = targetDeg - this.avatar.deg;
      while (dDeg > 180) dDeg -= 360;
      while (dDeg < -180) dDeg += 360;
      this.avatar.deg += dDeg * Math.min(1, dt * 4);
      const tr = this.visuals.avatarRoot.getTransform();
      tr.setLocalPosition(this.fieldMath.fieldToLocal(this.avatar.x, this.avatar.y, 0));
      tr.setLocalRotation(this.fieldMath.headingToLocalRotation(this.avatar.deg));
    }
  }

  private avatarLinkOk(): boolean {
    return this.ws !== undefined && this.ws.connected;
  }

  private isAnyHandPinching(): boolean {
    try {
      const SIKModule = require("SpectaclesInteractionKit.lspkg/SIK");
      const hid = SIKModule.SIK.HandInputData;
      for (const name of ["left", "right"]) {
        const hand = hid.getHand(name);
        if (hand !== null && hand.isTracked() && hand.isPinching()) {
          return true;
        }
      }
    } catch (e) { /* SIK not ready yet */ }
    return false;
  }
}
