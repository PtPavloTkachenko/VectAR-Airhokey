/**
 * GoaliePredictor – ZERO-LATENCY occluder sync. Mirrors the bridge's
 * ShowmanGoalie (same constants, same math) locally at 60 fps against the
 * lens-owned puck, and integrates 2-wheel kinematics into a predicted pose.
 * Incoming REAL poses only CORRECT drift (soft blend, hard snap on big err).
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { GameConfig } from "./GameConfig";

const log = new NativeLogger("GoaliePredictor");

// bridge config mirror (game_bridge/config.py)
const KP = 3.0;
const MAX_WHEEL = 200.0;
const ARRIVE_MM = 15.0;
const HEADING_FLIP_HYST_MM = 25.0;
const TURN_ALIGN_DEG = 55.0;
const KW_TURN = 1.6;
const MAX_TURN_WHEEL = 78.0;
const MAX_TURN_DIFF = 60.0;
const TRACK_MM = 48.0; // Vector wheelbase (mm) for differential kinematics
const FACE_PLAYER_DEG = 180.0;
const PUCK_MIN_VX = 30.0;
const INTERCEPT_MAX_T = 4.0;
const GOALIE_Y_RANGE = 70.0;

function wrapDeg(a: number): number {
  a = a % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

function fold(y: number, h: number): number {
  // reflect off walls until inside [-h, h]
  let v = y;
  for (let i = 0; i < 8; i++) {
    if (v > h) v = 2 * h - v;
    else if (v < -h) v = -2 * h - v;
    else break;
  }
  return v;
}

export class GoaliePredictor {
  public x = 0;
  public y = 0;
  public deg = 180;
  private faceTurning = false;

  reset(x: number, y: number, deg: number) {
    this.x = x;
    this.y = y;
    this.deg = deg;
  }

  /** Soft-correct toward a real pose sample (called per WS pose). */
  correct(rx: number, ry: number, rdeg: number) {
    const ex = rx - this.x, ey = ry - this.y;
    const err = Math.sqrt(ex * ex + ey * ey);
    if (err > 80) {
      // trust reality — hard snap
      this.x = rx; this.y = ry; this.deg = rdeg;
      return;
    }
    const a = 0.15;
    this.x += ex * a;
    this.y += ey * a;
    this.deg += wrapDeg(rdeg - this.deg) * a;
  }

  /** Mirror of predict_intercept (straight line + wall folds). */
  private intercept(px: number, py: number, pvx: number, pvy: number
                    ): number | null {
    if (pvx <= PUCK_MIN_VX) {
      return null;
    }
    const tHit = (GameConfig.GOALIE_X - px) / pvx;
    if (tHit < 0 || tHit > INTERCEPT_MAX_T) {
      return null;
    }
    const h = GameConfig.FIELD_W / 2 - GameConfig.PUCK_R;
    const yHit = fold(py + pvy * tHit, h);
    return Math.max(-GOALIE_Y_RANGE, Math.min(GOALIE_Y_RANGE, yHit));
  }

  private rotateToward(targetDeg: number): [number, number] {
    const d = wrapDeg(targetDeg - this.deg);
    if (this.faceTurning) {
      if (Math.abs(d) < 4) { this.faceTurning = false; return [0, 0]; }
    } else {
      if (Math.abs(d) < 12) { return [0, 0]; }
      this.faceTurning = true;
    }
    const w = Math.max(-MAX_TURN_WHEEL, Math.min(MAX_TURN_WHEEL, KW_TURN * d));
    return [-w, w];
  }

  /** SIDE MODE mirror: fore/aft patrol along the goal line. */
  private sideCommand(yTarget: number): [number, number] {
    const dPos = wrapDeg(90 - this.deg);
    const dNeg = wrapDeg(-90 - this.deg);
    const patrol = Math.abs(dPos) <= Math.abs(dNeg) ? 90 : -90;
    const d = patrol > 0 ? dPos : dNeg;
    if (Math.abs(d) > 22) {
      const w = Math.max(-MAX_TURN_WHEEL, Math.min(MAX_TURN_WHEEL, KW_TURN * d));
      return [-w, w];
    }
    const dy = yTarget - this.y;
    if (Math.abs(dy) < 12) {
      if (Math.abs(d) > 6) {
        const w = Math.max(-40, Math.min(40, KW_TURN * d));
        return [-w, w];
      }
      return [0, 0];
    }
    let v = KP * dy * (patrol > 0 ? 1 : -1);
    v = Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, v));
    const vyIntent = v * (patrol > 0 ? 1 : -1);
    const yr = GameConfig.GOALIE_Y_RANGE;
    if ((this.y >= yr && vyIntent > 0) || (this.y <= -yr && vyIntent < 0)) {
      v = 0;
    }
    // x-hygiene lean — mirror of the bridge
    const xErr = this.x - GameConfig.GOALIE_X;
    const bias = Math.max(-9, Math.min(9, 0.22 * xErr))
      * (v >= 0 ? 1 : -1) * (patrol > 0 ? 1 : -1);
    const d2 = wrapDeg(patrol + bias - this.deg);
    const w = Math.max(-22, Math.min(22, 1.2 * d2));
    let left = v - w, right = v + w;
    const m = Math.max(Math.abs(left), Math.abs(right));
    if (m > MAX_WHEEL) {
      left *= MAX_WHEEL / m;
      right *= MAX_WHEEL / m;
    }
    return [left, right];
  }

  /** Mirror of ShowmanGoalie.command → wheel speeds. */
  private command(yTarget: number, faceDeg: number): [number, number] {
    const dx = GameConfig.GOALIE_X - this.x;
    const dy = yTarget - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < ARRIVE_MM) {
      return this.rotateToward(faceDeg);
    }
    const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
    const d = wrapDeg(bearing - this.deg);
    if (dist < HEADING_FLIP_HYST_MM && Math.abs(d) > 90) {
      return this.rotateToward(faceDeg);
    }
    if (Math.abs(d) > TURN_ALIGN_DEG) {
      return this.rotateToward(bearing);
    }
    let v = Math.min(MAX_WHEEL, KP * dist);
    v *= Math.max(0.15, Math.cos((d * Math.PI) / 180));
    const w = Math.max(-MAX_TURN_DIFF, Math.min(MAX_TURN_DIFF, 2.0 * d));
    let left = v - w, right = v + w;
    const m = Math.max(Math.abs(left), Math.abs(right));
    if (m > MAX_WHEEL) {
      left *= MAX_WHEEL / m;
      right *= MAX_WHEEL / m;
    }
    return [left, right];
  }

  /** Advance the prediction one frame against the live puck. */
  tick(dt: number, rallyActive: boolean,
       px: number, py: number, pvx: number, pvy: number, puckActive: boolean) {
    let yTarget = 0;
    let face = FACE_PLAYER_DEG;
    if (rallyActive && puckActive) {
      const hit = this.intercept(px, py, pvx, pvy);
      if (hit !== null) {
        yTarget = hit;
      } else if (pvx < 0) {
        yTarget = Math.max(-GOALIE_Y_RANGE,
                           Math.min(GOALIE_Y_RANGE, py * 0.65));
      }
    }
    // SIDE MODE: choreography turns (block flash) are NOT predicted —
    // corrections absorb them; patrol itself is a clean linear mirror
    const cmd = this.sideCommand(yTarget);
    this.integrate(cmd[0], cmd[1], dt);
  }

  /** Differential-drive kinematics (same as the physical robot). */
  private integrate(left: number, right: number, dt: number) {
    const v = (left + right) / 2;             // mm/s forward
    const wDeg = ((right - left) / TRACK_MM) * (180 / Math.PI); // deg/s
    this.deg = this.deg + wDeg * dt;
    const rad = (this.deg * Math.PI) / 180;
    this.x += Math.cos(rad) * v * dt;
    this.y += Math.sin(rad) * v * dt;
  }
}
