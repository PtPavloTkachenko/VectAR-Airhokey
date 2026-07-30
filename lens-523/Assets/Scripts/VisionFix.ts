/**
 * VisionFix – YOLO-based absolute position correction for the REAL robot.
 * Layer 3 of the positioning stack: SLAM (continuous, robot-side) +
 * THIS (periodic absolute anchor) + GoaliePredictor (zero-lag visual).
 *
 * WHEN a fix is taken (smart duty cycle):
 *  - at most once per VISION_PERIOD seconds
 *  - only while the robot is SLOW (no motion blur, odometry settled)
 *  - detection score >= CONF_MIN (bridge gates again at 0.6 + 80mm outlier)
 * The bridge blends fixes with a complementary filter (a=0.08) into the
 * odometry->field transform, so commands self-correct.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { CoffeeMLController } from "./ML16/CoffeeMLController";
import { Detection } from "./ML16/DetectionHelpers";
import { CameraSurfaceProjector } from "./CameraSurfaceProjector";
import { WSClient } from "./WSClient";
import { FieldMath } from "./FieldMath";
import { OneEuroFilterVec3 } from "SpectaclesInteractionKit.lspkg/Utils/OneEuroFilter";

const log = new NativeLogger("VisionFix");

const VISION_PERIOD_S = 0.5;   // 2Hz — YOLO earned the trust
const CONF_MIN = 0.4; // model tops out ~0.42-0.50 live
const SLOW_SPEED_MM_S = 120.0; // side-drive dashes are fine — filters cover

export class VisionFix {
  private lastFixAt = -99;
  private timeS = 0;

  /** bbox bottom edge = NEAR edge of the footprint as seen by the camera —
   * push the point AWAY from the viewer by half the body depth. */
  public depthOffsetMm = 0;
  public debugLog = false; // center-projection needs little/no push

  constructor(
    private ml: CoffeeMLController,
    private projector: CameraSurfaceProjector,
    private ws: WSClient,
    private fieldRoot: SceneObject,
    private fieldMath: FieldMath,
    private robotSpeed: () => number,  // |mm/s| estimate from pose stream
    private cameraPos: () => vec3     // camera world position
  ) {
    this.ml.onDetections((dets) => this.onDetections(dets));
    log.i("VisionFix armed (period " + VISION_PERIOD_S + "s)");
  }

  tick(dt: number) {
    this.timeS += dt;
  }

  /** Marker hook: fires on EVERY estimate so the user can SEE it. */
  public onEstimate: (x: number, y: number, conf: number) => void = () => {};
  public sentCount = 0;
  public detCount = 0;
  // COFFEE-TEST SCHEME: One Euro on the WORLD point (their exact params)
  private euro = new OneEuroFilterVec3({
    frequency: 15, minCutoff: 1.0, beta: 0.1, dcutoff: 1.0,
  });
  /** filtered world-space target — GameController glides the marker here */
  public targetWorld: vec3 | null = null;
  private consec = 0; // consecutive-hit debounce (kills one-frame ghosts)

  private onDetections(dets: Detection[]) {
    this.detCount++;
    if (this.detCount % 40 === 1) {
      if (this.debugLog) print("[VISION] detections batch #" + this.detCount +
            " n=" + dets.length);
    }
    // best detection above a LOW bar (marker shows even weak estimates)
    let best: Detection | null = null;
    for (const d of dets) {
      if (d.score >= 0.35 && (!best || d.score > best.score)) { // marker gate
        best = d;
      }
    }
    if (!best) {
      this.consec = 0; // dry frame breaks the streak
      return;
    }
    this.consec++;
    if (this.consec < 2) {
      return; // need 2 hits in a row before the marker even moves
    }
    // bbox bottom-center = where the robot touches the table.
    // Use ML16's OWN unprojection (device-camera intrinsics + capture-time
    // head pose) — the geometry proven in the example project.
    if (!this.ml.isCameraModelReady()) {
      return;
    }
    // COFFEE-TEST OUTPUT: sample inside the bbox with their default bias
    // (yBias 0.5 -> halfway to the bottom = base on the table)
    const u = best.bbox[0] + best.bbox[2] * 0.5 * 0.0;
    const vImg = best.bbox[1] + best.bbox[3] * 0.5 * 0.5;
    const uv = new vec2(u, 1.0 - vImg); // unproject wants y-UP
    const camPos = this.ml.getDeviceCameraPosition();
    const onRay = this.ml.unprojectToWorld(uv);
    const dir = onRay.sub(camPos);
    const planeY = this.fieldRoot.getTransform().getWorldPosition().y;
    if (Math.abs(dir.y) < 1e-4) {
      return; // ray parallel to the table
    }
    const t = (planeY - camPos.y) / dir.y;
    if (t <= 0) {
      return; // table behind the camera — bogus
    }
    const world = new vec3(camPos.x + dir.x * t, planeY,
                           camPos.z + dir.z * t);
    // world -> field mm
    const inv = this.fieldRoot.getTransform().getInvertedWorldTransform();
    const local = inv.multiplyPoint(world);
    let fx = local.x * 10;
    let fy = -local.z * 10;
    // near-edge -> footprint-center: push away from the camera (flattened)
    const camF = this.fieldMath.worldToField3(this.cameraPos());
    const dx = fx - camF.x, dy = fy - camF.y;
    const dl = Math.sqrt(dx * dx + dy * dy);
    if (dl > 1) {
      fx += (dx / dl) * this.depthOffsetMm;
      fy += (dy / dl) * this.depthOffsetMm;
    }
    // sanity: inside the extended field area only
    if (Math.abs(fx) > 350 || Math.abs(fy) > 250) {
      return;
    }
    // COFFEE SCHEME: One Euro denoises the WORLD point; the per-frame
    // glide in GameController eases the marker toward it.
    this.targetWorld = this.euro.filter(world, this.timeS);
    const tf = this.fieldMath.worldToField(this.targetWorld);
    fx = tf.x + (fx - tf.x) * 0; // fixes use the filtered target too
    fy = tf.y;
    fx = tf.x;
    this.onEstimate(fx, fy, best.score);
    // send to the bridge only per the duty cycle + quality gates
    if (this.consec < 3) {
      return; // fixes need an even longer streak
    }
    if (this.timeS - this.lastFixAt < VISION_PERIOD_S) {
      return;
    }
    if (this.robotSpeed() > SLOW_SPEED_MM_S || best.score < CONF_MIN) {
      return;
    }
    this.lastFixAt = this.timeS;
    this.sentCount++;
    this.ws.sendJson({
      t: "vision_fix", x: Math.round(fx), y: Math.round(fy),
      conf: Math.round(best.score * 100) / 100, ts: this.timeS,
    });
    if (this.debugLog) print("[VISION] fix SENT (" + Math.round(fx) + "," + Math.round(fy) +
          ") conf=" + best.score.toFixed(2));
  }
}
