import {
  PlacementMode,
  PlacementSettings,
} from "SurfacePlacement.lspkg/Scripts/PlacementSettings";
import { SurfacePlacementController } from "SurfacePlacement.lspkg/Scripts/SurfacePlacementController";

// Hand-calibrated surface plane for the session (SurfacePlacement TableTop mode:
// user presses a hand flat on the surface; ~1s of stable frames -> (pos, rot)).
// Plain class (not a component) hosted by SceneController so no scene wiring is
// needed — SurfacePlacementController is a code singleton that builds its own
// scene objects. start() may be called again at any time to RECALIBRATE; a
// successful pass overwrites the stored plane, a timeout keeps the previous one.
export class SurfaceCalibration {
  private host: BaseScriptComponent;
  private surfacePos: vec3 | null = null;
  private surfaceRot: quat | null = null;
  private running = false;
  private timeoutEvent: DelayedCallbackEvent | null = null;
  private onDone: ((ok: boolean) => void) | null = null;

  constructor(host: BaseScriptComponent) {
    this.host = host;
  }

  public isCalibrated(): boolean {
    return this.surfacePos !== null;
  }

  public isRunning(): boolean {
    return this.running;
  }

  // World-space Y (cm) of the calibrated surface plane, or null.
  public getSurfaceY(): number | null {
    return this.surfacePos ? this.surfacePos.y : null;
  }

  public getSurfacePlane(): { pos: vec3; rot: quat } | null {
    return this.surfacePos && this.surfaceRot
      ? { pos: this.surfacePos, rot: this.surfaceRot }
      : null;
  }

  // Start (or restart) hand calibration. The package shows its own visual hint
  // ("place hand face down on a surface") + progress circle; the voice agent is
  // responsible for narrating. Times out after timeoutSeconds (keeps any
  // previously calibrated plane on timeout).
  public start(timeoutSeconds: number, onDone: (ok: boolean) => void) {
    if (this.running) this.cancel();
    this.running = true;
    this.onDone = onDone;
    print("[SurfaceCalibration] starting hand calibration (timeout " + timeoutSeconds + "s)");

    SurfacePlacementController.getInstance().startSurfacePlacement(
      new PlacementSettings(PlacementMode.NEAR_SURFACE, false),
      (pos: vec3, rot: quat) => this.complete(pos, rot)
    );

    if (this.timeoutEvent === null) {
      this.timeoutEvent = this.host.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
      this.timeoutEvent.bind(() => this.onTimeout());
    }
    this.timeoutEvent.reset(timeoutSeconds);
  }

  // Stop a calibration in progress (keeps any previously stored plane).
  public cancel() {
    if (!this.running) return;
    this.running = false;
    this.onDone = null;
    if (this.timeoutEvent) this.timeoutEvent.cancel();
    SurfacePlacementController.getInstance().stopSurfacePlacement();
  }

  private complete(pos: vec3, rot: quat) {
    if (this.timeoutEvent) this.timeoutEvent.cancel();
    this.running = false;
    this.surfacePos = pos;
    this.surfaceRot = rot;
    print(
      "[SurfaceCalibration] calibrated — surface Y=" + pos.y.toFixed(1) + "cm at (" +
        pos.x.toFixed(0) + ", " + pos.z.toFixed(0) + ")"
    );
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb(true);
  }

  private onTimeout() {
    if (!this.running) return;
    print("[SurfaceCalibration] timed out — keeping previous plane (if any)");
    this.running = false;
    SurfacePlacementController.getInstance().stopSurfacePlacement();
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb(false);
  }
}
