/**
 * PuckPhysics – authoritative 2D puck sim in field mm, ticked at render rate.
 * Walls reflect, paddle and Vector's body are circles, |x|>200 = goal.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { GameConfig } from "./GameConfig";

const log = new NativeLogger("PuckPhysics");

export interface CirclePaddle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export class PuckPhysics {
  public x = 0;
  public y = 0;
  public vx = 0;
  public vy = 0;
  public active = false;
  /** who touched the puck last: "player" | "vector" | "" */
  public lastHitter = "";
  /** side holding the power-cell boost ("" = none); their hits fly ~2x */
  public boostSide = "";

  public onGoal: (scoredOnVectorSide: boolean) => void = () => {};
  public onWallBounce: () => void = () => {};
  public onPaddleHit: () => void = () => {};
  public onVectorHit: () => void = () => {};

  private applyBoost(hitter: string) {
    if (this.boostSide !== hitter) {
      return;
    }
    // powered side: outgoing speed jumps (capped at 2x the normal ceiling)
    const sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    const target = Math.min(sp * 1.8, GameConfig.PUCK_MAX_SPEED * 2);
    if (sp > 1) {
      const k = target / sp;
      this.vx *= k;
      this.vy *= k;
    }
  }

  serve(towardPlayer: boolean) {
    this.x = 0;
    this.y = 0;
    const ang = ((Math.random() * 60 - 30) * Math.PI) / 180;
    const dir = towardPlayer ? -1 : 1;
    this.vx = dir * GameConfig.PUCK_SERVE_SPEED * Math.cos(ang);
    this.vy = GameConfig.PUCK_SERVE_SPEED * Math.sin(ang);
    this.active = true;
  }

  stop() {
    this.active = false;
    this.vx = 0;
    this.vy = 0;
  }

  tick(dt: number, paddle: CirclePaddle | null, vector: CirclePaddle | null) {
    if (!this.active) {
      return;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // walls
    const wallY = GameConfig.FIELD_W / 2 - GameConfig.PUCK_R;
    if (this.y > wallY && this.vy > 0) {
      this.y = wallY;
      this.vy = -this.vy * GameConfig.WALL_RESTITUTION;
      this.onWallBounce();
    } else if (this.y < -wallY && this.vy < 0) {
      this.y = -wallY;
      this.vy = -this.vy * GameConfig.WALL_RESTITUTION;
      this.onWallBounce();
    }

    // paddles
    if (paddle !== null && this.collideCircle(paddle)) {
      this.lastHitter = "player";
      this.applyBoost("player");
      this.onPaddleHit();
    }
    if (vector !== null && this.collideCircle(vector)) {
      this.lastHitter = "vector";
      this.applyBoost("vector");
      this.onVectorHit();
    }

    // goals
    const goalX = GameConfig.FIELD_L / 2;
    if (this.x > goalX) {
      this.active = false;
      this.onGoal(true); // crossed Vector's goal line -> player scores
    } else if (this.x < -goalX) {
      this.active = false;
      this.onGoal(false); // player's goal line -> Vector scores
    }
  }

  private collideCircle(c: CirclePaddle): boolean {
    const dx = this.x - c.x;
    const dy = this.y - c.y;
    const rSum = GameConfig.PUCK_R + c.r;
    const distSq = dx * dx + dy * dy;
    if (distSq >= rSum * rSum || distSq < 1e-9) {
      return false;
    }
    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const ny = dy / dist;
    // separate
    this.x = c.x + nx * rSum;
    this.y = c.y + ny * rSum;
    // reflect velocity along contact normal (only if approaching)
    const vDotN = this.vx * nx + this.vy * ny;
    if (vDotN < 0) {
      this.vx -= 2 * vDotN * nx;
      this.vy -= 2 * vDotN * ny;
    }
    // add mover velocity
    this.vx += c.vx * GameConfig.PADDLE_VEL_TRANSFER;
    this.vy += c.vy * GameConfig.PADDLE_VEL_TRANSFER;
    // clamp speed (powered side gets a 2x ceiling)
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    const ceil = GameConfig.PUCK_MAX_SPEED
      * (this.boostSide !== "" && this.boostSide === this.lastHitter ? 2 : 1);
    const clamped = Math.max(
      GameConfig.PUCK_MIN_SPEED,
      Math.min(ceil, speed)
    );
    if (speed > 1e-6) {
      const k = clamped / speed;
      this.vx *= k;
      this.vy *= k;
    }
    return true;
  }
}
