
/**
 * Drop-in replacement for DepthCache's pixel->world placement, WITHOUT the
 * DepthModule. Instead of sampling per-pixel depth it casts the camera ray and
 * intersects the calibrated horizontal surface plane (surface Y). Gemini only
 * gives us a 2D image + 2D pixel boxes; we project those onto our known plane.
 *
 * Why this is cheap: DepthCache ran a 30Hz full-frame copyFrame history + a 5Hz
 * full depth-buffer slice for the whole session — heavy memory churn. Here we do
 * exactly ONE copyFrame per capture (scan / reverify, ~1/cycle), and no depth
 * module at all.
 *
 * CRITICAL: the camera POSE is frozen at capture time. Gemini answers seconds
 * later, by which point the head has moved — projecting with the live pose would
 * misplace every toy. Same principle DepthCache used (it cached the depth frame's
 * pose), just without the depth buffer.
 *
 * Method names mirror DepthCache so SceneController call sites are unchanged.
 */

/** Minimal host contract — avoids a circular import with SceneController. */
export interface ProjectorHost {
  /** Device-tracked camera whose SceneObject world transform = the device pose. */
  getWorldCamera(): Camera | null;
  /** World-space Y (cm) of the calibrated surface, or null if not calibrated. */
  getSurfaceYForProjection(): number | null;
}

class FrameSnapshot {
  constructor(
    public texture: Texture,
    public camWorld: mat4,
    public deviceCamera: DeviceCamera
  ) {}
}

export class CameraSurfaceProjector {
  private frames: Map<number, FrameSnapshot> = new Map<number, FrameSnapshot>();
  private counter: number = 0;
  private isEditor: boolean = global.deviceInfoSystem.isEditor();

  constructor(private host: ProjectorHost) {}

  private getDeviceCamera(): DeviceCamera | null {
    const camId = this.isEditor
      ? CameraModule.CameraId.Default_Color
      : CameraModule.CameraId.Left_Color;
    return global.deviceInfoSystem.getTrackingCameraForId(camId);
  }

  /**
   * Freeze the current camera frame + device pose. Returns a frame id, or -1 if
   * the camera / pose / intrinsics aren't ready yet (caller surfaces the same
   * "Camera not ready" UX DepthCache used).
   */
  saveDepthFrame(): number {
    const tex = (this.host as any).getCameraTexture
      ? (this.host as any).getCameraTexture()
      : null;
    if (!tex) {
      print("[Projector] no camera texture from host");
      return -1;
    }
    const cam = this.host.getWorldCamera();
    if (!cam) {
      print("[Projector] no world camera wired (SceneController.debugCamera)");
      return -1;
    }
    const dc = this.getDeviceCamera();
    if (!dc) {
      print("[Projector] no device camera intrinsics");
      return -1;
    }
    // ONE copyFrame freezes the exact image that matches the pose captured on the
    // next line (1 per capture, NOT DepthCache's 30Hz churn).
    const frozen = tex.copyFrame();
    const camWorld = cam.getSceneObject().getTransform().getWorldTransform();
    const id = ++this.counter;
    this.frames.set(id, new FrameSnapshot(frozen, camWorld, dc));
    return id;
  }

  getCamImageWithID(depthFrameID: number): Texture | null {
    const f = this.frames.get(depthFrameID);
    return f ? f.texture : null;
  }

  /**
   * Pixel -> world: cast the camera ray (through the frozen pose + intrinsics)
   * and intersect the horizontal surface plane at surface Y. `pixelPos` is in
   * the full color-frame pixel space (same as the frozen texture). Returns null
   * if the surface isn't calibrated or the ray doesn't hit the plane in front.
   */
  getWorldPositionWithID(pixelPos: vec2, depthFrameID: number): vec3 | null {
    const f = this.frames.get(depthFrameID);
    if (!f) {
      print("[Projector] invalid frame id: " + depthFrameID);
      return null;
    }
    const surfaceY = this.host.getSurfaceYForProjection();
    if (surfaceY === null) return null;

    const uv = pixelPos.div(f.deviceCamera.resolution); // normalized [0,1]
    // unproject() returns a point in device-ref space (already includes the
    // camera offset); the frozen device world transform maps it to world.
    const nearWorld = f.camWorld.multiplyPoint(f.deviceCamera.unproject(uv, 10));
    const farWorld = f.camWorld.multiplyPoint(f.deviceCamera.unproject(uv, 200));
    const dir = farWorld.sub(nearWorld); // ray direction (un-normalized)
    if (Math.abs(dir.y) < 1e-5) return null; // ray parallel to the table
    const t = (surfaceY - nearWorld.y) / dir.y;
    if (t < 0) return null; // surface is behind the camera
    return nearWorld.add(dir.uniformScale(t));
  }

  disposeDepthFrame(depthFrameID: number): void {
    this.frames.delete(depthFrameID);
  }
}
