import Event from "SpectaclesInteractionKit.lspkg/Utils/Event";

/**
 * Singleton that owns the world color camera and broadcasts frames to
 * downstream consumers (ML inference, optional Gemini snapshots, etc.).
 *
 * Why a singleton + `@input camModule`:
 *   1. Lens Studio auto-declares the **Camera** capability only when a
 *      CameraModule asset is bound via `@input` in the inspector. A
 *      `require("LensStudio:CameraModule")` call does NOT trigger the
 *      auto-declaration, so frames stay empty forever on device.
 *   2. We don't want two camera requests competing on Spectacles — share
 *      this one across all consumers.
 *
 * Lifecycle (on device):
 *   onAwake → register singleton
 *   OnStartEvent → init() → requestCamera() + wire screenCropTexture
 *                          + subscribe to onNewFrame
 *   first onNewFrame → configure crop rect, mark ready, fire onCameraReady
 *   each subsequent onNewFrame → fire onNewFrame
 */
@component
export class CameraService extends BaseScriptComponent {
  @input
  @hint("Camera Module asset — inspector binding auto-declares the Camera capability")
  camModule: CameraModule;

  @input
  @hint("Square ScreenCropTexture used as MLComponent input — will be wired to the camera at runtime")
  screenCropTexture: Texture;

  private static _instance: CameraService | null = null;
  public static getInstance(): CameraService | null {
    return CameraService._instance;
  }

  public camTexture: Texture;
  public isEditor: boolean = false;

  private cropProvider: any = null;
  private isReady: boolean = false;
  private frameCount: number = 0;

  public onCameraReady = new Event<{ width: number; height: number }>();
  public onNewFrame = new Event<void>();

  onAwake() {
    if (CameraService._instance) {
      print("[CameraService] WARN: duplicate instance ignored");
      return;
    }
    CameraService._instance = this;
    this.isEditor = global.deviceInfoSystem.isEditor();
    this.createEvent("OnStartEvent").bind(() => this.init());
  }

  public isCameraReady(): boolean {
    return this.isReady;
  }

  /**
   * Raw camera texture — useful if a consumer needs the uncropped view
   * (e.g. for Gemini snapshots). Returns null until camera is ready.
   */
  public getCameraTexture(): Texture | null {
    return this.isReady ? this.camTexture : null;
  }

  private init(): void {
    print("[CameraService] init() starting, isEditor=" + this.isEditor);

    if (!this.camModule) {
      print("[CameraService] ERROR: camModule @input is not wired — bind a CameraModule asset");
      return;
    }
    if (!this.screenCropTexture) {
      print("[CameraService] ERROR: screenCropTexture @input is not wired");
      return;
    }

    // Left_Color is the Spectacles world color camera — same one DepthCache
    // uses. Multiple consumers can call requestCamera on the same id, BUT
    // their CameraRequest objects must match (no setting imageSmallerDimension
    // here only) or Spectacles silently drops one. We deliberately request
    // native resolution to stay compatible with DepthCache's request.
    const camID = this.isEditor
      ? CameraModule.CameraId.Default_Color
      : CameraModule.CameraId.Left_Color;
    const req = CameraModule.createCameraRequest();
    req.cameraId = camID;

    this.camTexture = this.camModule.requestCamera(req);
    print("[CameraService] camera requested (id=" + camID + ", camTexture=" + (this.camTexture ? "ok" : "null") + ")");

    this.cropProvider = (this.screenCropTexture as any).control;
    if (!this.cropProvider) {
      print("[CameraService] ERROR: screenCropTexture.control is null — asset must be a ScreenCropTexture");
      return;
    }
    this.cropProvider.inputTexture = this.camTexture;
    print("[CameraService] cropProvider.inputTexture wired");

    const ctrl = (this.camTexture as any).control;
    if (ctrl && ctrl.onNewFrame && ctrl.onNewFrame.add) {
      ctrl.onNewFrame.add(() => this.handleFrame());
      print("[CameraService] onNewFrame subscribed");
    } else {
      print("[CameraService] WARN: camTexture.control.onNewFrame missing");
    }
  }

  private handleFrame(): void {
    this.frameCount++;

    if (!this.isReady) {
      const w = this.camTexture.getWidth();
      const h = this.camTexture.getHeight();
      if (w > 0 && h > 0) {
        this.configureCrop(w, h);
        this.isReady = true;
        print("[CameraService] ready " + w + "x" + h);
        this.onCameraReady.invoke({ width: w, height: h });
      } else if (this.frameCount === 1) {
        print("[CameraService] first onNewFrame but camTexture still 0x0");
      }
    }

    this.onNewFrame.invoke();
  }

  private configureCrop(w: number, h: number): void {
    const dim = Math.min(w, h);
    const imageSize = new vec2(w, h);
    const cropRect = this.cropProvider.cropRect;
    cropRect.setSize(new vec2(dim, dim).div(imageSize).uniformScale(2));

    // Offset the crop to the "inside" half of the world camera so the model
    // sees what's roughly in front of the user. Left_Color is offset to the
    // left eye, so its forward direction sits in the RIGHT half of its frame;
    // Right_Color is the mirror. Editor camera has no offset.
    let xCenter = imageSize.x * 0.5;
    const yCenter = imageSize.y * 0.5;
    if (!this.isEditor) {
      xCenter = Math.floor(imageSize.x - dim * 0.5); // Left_Color: right half
    }
    const center = new vec2(xCenter, yCenter)
      .div(imageSize)
      .uniformScale(2)
      .sub(vec2.one());
    cropRect.setCenter(center);
    this.cropProvider.cropRect = cropRect;
  }

  /**
   * Remap a UV from the cropped texture (what YOLO sees, [0,1]) back into
   * the full camera frame's UV space. Required when projecting model
   * detections to 3D world via DepthCache, since DepthCache works in
   * full-camera pixel coords.
   */
  public uvToUncroppedUV(uv: vec2): vec2 {
    if (!this.cropProvider) return uv;
    const cropRect = this.cropProvider.cropRect;
    // cropRect uses [-1, +1] normalized coords; remap to [0, 1].
    const centerNorm = cropRect.getCenter().add(vec2.one()).uniformScale(0.5);
    const halfSize = cropRect.getSize().uniformScale(0.25);
    const minUV = centerNorm.sub(halfSize);
    const maxUV = centerNorm.add(halfSize);
    return new vec2(
      minUV.x + uv.x * (maxUV.x - minUV.x),
      minUV.y + uv.y * (maxUV.y - minUV.y)
    );
  }

  /**
   * Inverse of uvToUncroppedUV: map a full-camera-frame UV ([0,1]) into the
   * cropped texture's UV space (what YOLO sees / the debug tile shows).
   * Returns null when the point falls outside the crop.
   */
  public uncroppedUVToCropUV(uv: vec2): vec2 | null {
    if (!this.cropProvider) return uv;
    const cropRect = this.cropProvider.cropRect;
    const centerNorm = cropRect.getCenter().add(vec2.one()).uniformScale(0.5);
    const halfSize = cropRect.getSize().uniformScale(0.25);
    const minUV = centerNorm.sub(halfSize);
    const maxUV = centerNorm.add(halfSize);
    const out = new vec2(
      (uv.x - minUV.x) / Math.max(1e-6, maxUV.x - minUV.x),
      (uv.y - minUV.y) / Math.max(1e-6, maxUV.y - minUV.y)
    );
    if (out.x < 0 || out.x > 1 || out.y < 0 || out.y > 1) return null;
    return out;
  }
}
