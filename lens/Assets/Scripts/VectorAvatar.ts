/**
 * VectorAvatar – mirrors the physical robot inside the lens.
 * Buffers bridge pose messages, renders at (now - 100ms) with interpolation
 * and bounded extrapolation, and drives (a) the depth-only occluder mesh and
 * (b) collision circle data for PuckPhysics.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { FieldMath } from "./FieldMath";
import { GameConfig } from "./GameConfig";
import { PoseMsg } from "./WSClient";

const log = new NativeLogger("VectorAvatar");

interface BufferedPose {
  rxAt: number; // local receive time (s)
  x: number;
  y: number;
  deg: number;
  vy: number;
}


const UP_AXIS = new vec3(0, 1, 0);
export class VectorAvatar {
  public x = GameConfig.GOALIE_X; // latest rendered field pose
  public y = 0;
  public deg = 180;
  public vy = 0;
  private headTarget = 0;
  private liftTarget = 32;
  private headRad = 0;
  private liftMm = 32;
  private headPivot: SceneObject | null = null;
  private liftPivot: SceneObject | null = null;
  private carriagePivot: SceneObject | null = null;
  private usePredicted = false;
  private predX = 0;
  private predY = 0;
  private predDeg = 180;
  private smX = 0;
  private smY = 0;
  private smDeg = 180;
  public hasPose = false;

  private buffer: BufferedPose[] = [];
  private timeS = 0;

  constructor(
    private fieldMath: FieldMath,
    private avatarRoot: SceneObject // holds occluder visual, local to fieldRoot
  ) {}

  onPose(p: PoseMsg) {
    if (p.head !== undefined) {
      this.headTarget = p.head;
    }
    if (p.lift !== undefined) {
      this.liftTarget = p.lift;
    }
    this.buffer.push({ rxAt: this.timeS, x: p.x, y: p.y, deg: p.deg, vy: p.vy });
    while (this.buffer.length > 12) {
      this.buffer.shift();
    }
    this.hasPose = true;
  }

  reset() {
    this.buffer = [];
    this.hasPose = false;
  }

  tick(dt: number) {
    this.timeS += dt;
    if (this.buffer.length === 0) {
      return;
    }
    const renderAt = this.timeS - GameConfig.POSE_RENDER_DELAY_S;

    // find bracketing samples
    let a = this.buffer[0];
    let b = this.buffer[this.buffer.length - 1];
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i].rxAt <= renderAt && this.buffer[i + 1].rxAt >= renderAt) {
        a = this.buffer[i];
        b = this.buffer[i + 1];
        break;
      }
    }

    if (renderAt >= b.rxAt) {
      // extrapolate (bounded) using vy along the patrol axis
      const dtEx = Math.min(GameConfig.POSE_EXTRAPOLATE_MAX_S, renderAt - b.rxAt);
      this.x = b.x;
      this.y = b.y + b.vy * dtEx;
      this.deg = b.deg;
      this.vy = b.vy;
    } else {
      const span = Math.max(1e-4, b.rxAt - a.rxAt);
      const t = Math.max(0, Math.min(1, (renderAt - a.rxAt) / span));
      this.x = a.x + (b.x - a.x) * t;
      this.y = a.y + (b.y - a.y) * t;
      this.deg = lerpDeg(a.deg, b.deg, t);
      this.vy = b.vy;
    }

    if (this.usePredicted) {
      // prediction leads reality — POSITION only; heading stays MEASURED
      // (choreography turns aren't predicted -> predicted heading twitched)
      this.x = this.predX;
      this.y = this.predY;
    }
    // critically-damped output smoothing — no visible pose jumps
    const ks = Math.min(1, dt * 10);
    const kh = Math.min(1, dt * 16); // heading catches up faster (ghost-turn fix)
    this.smX += (this.x - this.smX) * ks;
    this.smY += (this.y - this.smY) * ks;
    let dd = this.deg - this.smDeg;
    while (dd > 180) dd -= 360;
    while (dd < -180) dd += 360;
    this.smDeg += dd * kh;
    const tr = this.avatarRoot.getTransform();
    tr.setLocalPosition(this.fieldMath.fieldToLocal(this.smX, this.smY, 0));
    tr.setLocalRotation(this.fieldMath.headingToLocalRotation(this.smDeg));

    // articulated head + lift mirror the REAL robot (smoothed)
    this.headRad += (this.headTarget - this.headRad) * 0.25;
    this.liftMm += (this.liftTarget - this.liftMm) * 0.25;
    if (this.headPivot) {
      this.headPivot.getTransform().setLocalRotation(
        quat.angleAxis(-this.headRad, UP_AXIS));
    }
    if (this.liftPivot) {
      // 32..92 mm of lift ≈ 0..-55° of arm swing
      const k = Math.max(0, Math.min(1, (this.liftMm - 32) / 60));
      this.liftPivot.getTransform().setLocalRotation(
        quat.angleAxis(-k * 0.96, UP_AXIS));
      if (this.carriagePivot) {
        // counter-rotation keeps the fork vertical on the arm arc
        this.carriagePivot.getTransform().setLocalRotation(
          quat.angleAxis(k * 0.96, UP_AXIS));
      }
    }
  }

  /** Zero-latency mode: the local predictor owns x/y/deg. */
  setPredictedPose(x: number, y: number, deg: number) {
    this.usePredicted = true;
    this.predX = x;
    this.predY = y;
    this.predDeg = deg;
  }

  clearPredicted() {
    this.usePredicted = false;
  }

  setPivots(head: SceneObject | null, lift: SceneObject | null,
            carriage: SceneObject | null = null) {
    this.headPivot = head;
    this.liftPivot = lift;
    this.carriagePivot = carriage;
  }
}

// (articulation state lives on the class)
function lerpDeg(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return a + d * t;
}
