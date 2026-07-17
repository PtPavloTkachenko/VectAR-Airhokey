/**
 * HandPaddle – drives the neon paddle from the player's hand.
 * SIK TrackedHand indexKnuckle -> project onto the field plane -> exp smooth
 * -> clamp to the player's half. Exposes field-space pose + velocity for
 * PuckPhysics. Editor fallback: paddle follows a slow demo orbit.
 */
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK";
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { FieldMath } from "./FieldMath";
import { GameConfig } from "./GameConfig";

const log = new NativeLogger("HandPaddle");

export class HandPaddle {
  public x = -120; // field mm
  public y = 0;
  public vx = 0;
  public vy = 0;
  public tracking = false;
  /** set by the SIK Interactable on the mallet: trigger held = grabbed */
  public interactableHeld = false;
  /** true while the player is pinch-holding the paddle */
  public grabbed = false;
  /** last pinch point in field mm (null when not pinching) — for UI buttons */
  public pinchPoint: vec2 | null = null;
  /** set when the paddle is being slammed against the field boundary */
  public edgeContact: vec2 | null = null;

  private smoothX = -120;
  private smoothY = 0;
  private prevX = -120;
  private prevY = 0;
  private isEditor: boolean;
  private demoT = 0;
  private static GRAB_RADIUS_MM = 90;

  constructor(private fieldMath: FieldMath, private handName: "left" | "right") {
    this.isEditor = global.deviceInfoSystem.isEditor();
  }

  /** true while the hand hovers over the field — the mallet exists */
  public overField = false;
  /** fired on enter/exit with the field position (mm) */
  public onEnterField: (x: number, y: number) => void = () => {};
  public onExitField: (x: number, y: number) => void = () => {};
  /** gate: the mallet only materializes while the game runs */
  public enabled = false;

  tick(dt: number) {
    let rawX: number | null = null;
    let rawY: number | null = null;

    // THE MALLET IS A PROJECTION: hand over the field -> it materializes
    // under the hand and follows; hand leaves -> it vanishes. No grabbing.
    const hand = SIK.HandInputData.getHand(this.handName);
    const wasOver = this.overField;
    let over = false;
    if (hand !== null && hand.isTracked() && hand.indexKnuckle !== null) {
      // mallet leads AHEAD of the fingertips along the hand direction
      const knu = this.fieldMath.worldToField(hand.indexKnuckle.position);
      const tipJ = (hand as any).indexTip;
      const tip = tipJ ? this.fieldMath.worldToField(tipJ.position) : knu;
      let fx = tip.x, fy = tip.y;
      const dx = tip.x - knu.x, dy = tip.y - knu.y;
      const dl = Math.sqrt(dx * dx + dy * dy);
      if (dl > 5) {
        fx += (dx / dl) * GameConfig.MALLET_LEAD_MM;
        fy += (dy / dl) * GameConfig.MALLET_LEAD_MM;
      }
      const f = new vec2(fx, fy);
      this.pinchPoint = hand.isPinching() ? new vec2(f.x, f.y) : null;
      // activation zone reaches 160mm TOWARD the player (hand hovers
      // short of the board edge a lot) but only 30mm on other sides
      const hl = GameConfig.FIELD_L / 2;
      const hw = GameConfig.FIELD_W / 2 + 30;
      over = this.enabled &&
        f.x > -hl - 160 && f.x < hl + 30 && Math.abs(f.y) < hw;
      if (over) {
        // the MALLET itself never leaves the field
        rawX = Math.max(-hl + 18, Math.min(hl - 18, f.x));
        rawY = Math.max(-hw + 48, Math.min(hw - 48, f.y));
        this.tracking = true;
      } else {
        this.tracking = false;
      }
      if (over && !wasOver) {
        this.x = f.x;  // materialize AT the hand, no slide-in
        this.y = f.y;
        this.onEnterField(f.x, f.y);
      } else if (!over && wasOver) {
        this.onExitField(this.x, this.y);
      }
      this.overField = over;
    } else if (this.isEditor && this.enabled) {
      // demo orbit so the paddle is alive in preview without hands
      this.demoT += dt;
      rawX = -120 + Math.sin(this.demoT * 0.9) * 40;
      rawY = Math.sin(this.demoT * 1.7) * 60;
      if (!this.overField) {
        this.onEnterField(rawX, rawY);
      }
      this.overField = true;
      this.tracking = true; // demo hand is always "over the field"
    } else {
      if (this.overField) {
        this.onExitField(this.x, this.y);
      }
      this.overField = false;
      this.tracking = false;
      this.pinchPoint = null;
    }

    if (rawX === null || rawY === null) {
      // not grabbed: paddle rests in place, no velocity
      this.vx = 0;
      this.vy = 0;
      this.prevX = this.x;
      this.prevY = this.y;
      return;
    }

    // exponential smoothing (cheap, portable)
    const k = Math.min(1, dt * 18);
    this.smoothX += (rawX - this.smoothX) * k;
    this.smoothY += (rawY - this.smoothY) * k;

    // clamp to the player's half — the paddle NEVER leaves the field;
    // a hard press against the boundary reports an edge contact (sparks!)
    const clampedX = Math.max(
      -GameConfig.FIELD_L / 2 + GameConfig.PADDLE_R,
      Math.min(-10, this.smoothX)
    );
    const wallY = GameConfig.FIELD_W / 2 - GameConfig.PADDLE_R;
    const clampedY = Math.max(-wallY, Math.min(wallY, this.smoothY));
    const overX = Math.abs(this.smoothX - clampedX);
    const overY = Math.abs(this.smoothY - clampedY);
    this.edgeContact = (this.grabbed && (overX > 6 || overY > 6))
      ? new vec2(clampedX, clampedY)
      : null;

    if (dt > 1e-4) {
      this.vx = (clampedX - this.prevX) / dt;
      this.vy = (clampedY - this.prevY) / dt;
    }
    this.prevX = clampedX;
    this.prevY = clampedY;
    this.x = clampedX;
    this.y = clampedY;
  }
}
