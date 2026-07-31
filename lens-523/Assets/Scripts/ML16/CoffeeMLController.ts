/**
 * CoffeeMLController — runs coffee.onnx on the live camera feed and emits detections.
 *
 * Responsibilities:
 *   - Request the device camera texture (CameraModule) and bind it to the model input.
 *   - Build the MLComponent, set outputs to Data mode so tensors are readable.
 *   - Drive inference on a frame-skip throttle (keeps it light on the glasses).
 *   - Decode YOLO outputs with CoffeeDetector and hand the result to a callback.
 *
 * Detection is gated by start()/stop() so the orchestrator only scans AFTER the
 * surface has been placed.
 */
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider";
import { Detection } from "./DetectionHelpers";
import { CoffeeDetector } from "./CoffeeDetector";
import { PinholeCameraModel } from "./PinholeCameraModel";

@component
export class CoffeeMLController extends BaseScriptComponent {
  @input
  @hint("Baseline model: the float .onnx export. Runs everywhere, including the editor preview.")
  model: MLAsset;

  @input
  @allowUndefined
  @hint("Some headsets: the quantised .dlc that runs on device. Device-only — the preview falls back to 'model'.")
  modelQuantized: MLAsset;

  @input
  @hint("Device camera to use on-device. OFF = Left color camera. ON = Right color camera. Editor always uses Default_Color.")
  useRightColorCamera: boolean = false;

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("Minimum confidence (objectness * class) to accept a detection.")
  scoreThreshold: number = 0.5;

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("IoU threshold for non-max suppression.")
  iouThreshold: number = 0.45;

  @input
  @hint("Run inference every N frames. Higher = fewer runs = more battery/perf headroom.")
  frameSkip: number = 3;

  @input
  @hint("Apply sigmoid to raw model outputs. Leave OFF for standard SnapML YOLO exports (sigmoid baked in). Turn ON only if no detections ever appear.")
  applySigmoid: boolean = false;

  @input
  @hint("Print per-run detection diagnostics to the log.")
  debugLog: boolean = false;

  private isEditor: boolean = global.deviceInfoSystem.isEditor();
  private cameraModule: CameraModule = require("LensStudio:CameraModule");
  private camTexture: Texture;
  private camId: CameraModule.CameraId;

  private mlComponent: MLComponent;
  private inputs: InputPlaceholder[];
  private outputs: OutputPlaceholder[];
  private detector: CoffeeDetector;

  // Device-camera intrinsics + pose for correct 2D->3D unprojection (see PinholeCameraModel).
  private mainCamera: Camera = WorldCameraFinderProvider.getInstance().getComponent();
  private deviceCamera: DeviceCamera;
  private cameraModel: PinholeCameraModel;
  private viewToWorldMatrix: mat4;
  private cameraModelReady: boolean = false;

  private triedFloat: boolean = false;
  private isRunning: boolean = false;
  private started: boolean = false;
  private modelReady: boolean = false;
  private frame: number = 0;

  private editorDelay: DelayedCallbackEvent | null = null;
  private dbgRuns = 0;
  private dbgHits = 0;
  private dbgBest = 0;
  private dbgLastPrint = 0;

  private onDetectionsCbs: ((dets: Detection[]) => void)[] = [];

  /** Register a callback that receives decoded detections (best-first). Multiple allowed. */
  public onDetections(cb: (dets: Detection[]) => void): void {
    this.onDetectionsCbs.push(cb);
  }

  /** The live camera texture fed to the model — use this for a debug overlay so the boxes line up
   *  with the pixels the model actually saw. Null until the camera is requested. */
  public getDisplayTexture(): Texture {
    return this.camTexture;
  }

  /** True once the device-camera intrinsics are available for unprojection. */
  public isCameraModelReady(): boolean {
    return this.cameraModelReady;
  }

  /** World-space optical center of the device camera (ray origin), at the last saved pose. */
  public getDeviceCameraPosition(): vec3 {
    return this.captureToWorld().multiplyPoint(vec3.zero());
  }

  /**
   * Unproject a normalized detection UV (camera-image space, y-UP — caller flips if needed)
   * into a world-space point along the view ray. Pair with getDeviceCameraPosition() to build
   * the ray, then intersect your surface plane.
   */
  public unprojectToWorld(uv: vec2): vec3 {
    const cameraSpace = this.cameraModel.unprojectFromUV(uv, 1.0);
    return this.captureToWorld().multiplyPoint(cameraSpace);
  }

  private captureToWorld(): mat4 {
    // render(eye)-camera world transform  *  device-camera pose (offset from the eye camera)
    return this.viewToWorldMatrix.mult(this.deviceCamera.pose);
  }

  /** Snapshot the render camera's world transform at the moment of inference, so async ML
   *  results unproject against where the head was when the frame was captured. */
  private saveMatrix(): void {
    this.viewToWorldMatrix = this.mainCamera.getTransform().getWorldTransform();
  }

  /** Acquire the device-camera intrinsics. Requesting the camera activates it so the tracking
   *  camera info is populated; in the editor this is the Default_Color webcam. */
  private setupCameraModel(): void {
    try {
      this.deviceCamera = global.deviceInfoSystem.getTrackingCameraForId(this.camId);
      if (this.deviceCamera) {
        this.cameraModel = PinholeCameraModel.create(this.deviceCamera);
        this.cameraModelReady = true;
        if (this.debugLog) {
          print("[CoffeeML] camera model ready (camId=" + this.camId + ") fov=" + this.cameraModel.fov.toFixed(3) + " res=" + this.deviceCamera.resolution.x + "x" + this.deviceCamera.resolution.y);
        }
      } else {
        print("[CoffeeML] getTrackingCameraForId(" + this.camId + ") returned null — placement unavailable.");
      }
    } catch (e) {
      print("[CoffeeML] camera model setup failed: " + e);
    }
  }

  /** Begin scanning. Safe to call before the model finishes loading. */
  public start(): void {
    this.started = true;
  }

  /** Stop scanning (no further inference until start() is called again). */
  public stop(): void {
    this.started = false;
  }

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
  }

  private onStart(): void {
    this.setupCamera();
    // Give the camera a beat to deliver its first frame before building the model + reading intrinsics.
    const delay = this.createEvent("DelayedCallbackEvent");
    delay.bind(() => {
      this.setupCameraModel();
      this.buildModel();
    });
    delay.reset(0.5);
  }

  private setupCamera(): void {
    // Which cameras exist is a property of the hardware, not something a Lens
    // can assume. Asking for a camera the headset does not have will
    // throw out of onStart — which kills the whole
    // controller before anything else runs, so the Lens looks like it crashed
    // for no reason. Try the candidates in order of usefulness and take the
    // first the device actually grants.
    const M: any = CameraModule.CameraId;
    const wanted: any[] = this.isEditor
      ? [M.Default_Color]
      : this.useRightColorCamera
        ? [M.Right_Color, M.Left_Color, M.Left_Grayscale, M.Right_Grayscale]
        : [M.Left_Color, M.Right_Color, M.Left_Grayscale, M.Right_Grayscale];

    for (const id of wanted) {
      if (id === undefined || id === null) continue;   // absent on this runtime
      try {
        const request = CameraModule.createCameraRequest();
        request.cameraId = id;
        if (!this.isEditor) request.imageSmallerDimension = 756;
        this.camTexture = this.cameraModule.requestCamera(request);
        this.camId = id;
        if (this.debugLog || id !== wanted[0]) {
          // Worth saying out loud when it is NOT the first choice: the
          // detector was trained on colour, so a grayscale feed is a real
          // difference in input, not just a different constant.
          print("[CoffeeML] camera granted: id=" + id
                + (id === M.Left_Grayscale || id === M.Right_Grayscale
                   ? " (grayscale — detections may differ from the colour model)"
                   : ""));
        }
        return;
      } catch (e) {
        print("[CoffeeML] camera id=" + id + " refused: " + e);
      }
    }
    print("[CoffeeML] no camera could be opened — vision stays off, the game "
          + "still plays on odometry alone.");
  }

  private buildModel(): void {
    // Two exports of the same detector. The .dlc is compiled for the device and
    // does not load on the editor, so the preview keeps running the
    // float ONNX and the glasses get the quantised one. Their input and output
    // shapes are identical, so CoffeeDetector decodes either without knowing which.
    const modelAsset = (!this.isEditor && this.modelQuantized) ? this.modelQuantized : this.model;
    if (!modelAsset) {
      print("[CoffeeML] No model asset assigned — set the 'model' input to the YOLO export.");
      return;
    }
    if (!this.camTexture) {
      print("[CoffeeML] Camera texture not ready — cannot build model.");
      return;
    }
    if (this.debugLog) {
      print("[CoffeeML] model = " + (modelAsset === this.modelQuantized ? "quantised .dlc (device)" : "float .onnx"));
    }

    this.mlComponent = this.getSceneObject().createComponent("MLComponent");
    this.mlComponent.model = modelAsset;
    this.mlComponent.onLoadingFinished = this.onLoadingFinished.bind(this);
    this.mlComponent.onLoadingFailed = (error: string) => {
      print("[CoffeeML] model load failed: " + error);
      // The quantised export is the one that can be refused: on device it is
      // handed to the editor, which does not accept it ("the load is refused"). Reaching the hardware needs the
      // route, which this Lens does not have. Rather than leave vision
      // dead for the whole session, fall back to the float model — it is the
      // same detector, and it is what the preview has been running all along.
      if (modelAsset === this.modelQuantized && this.model && !this.triedFloat) {
        this.triedFloat = true;
        print("[CoffeeML] falling back to the float model");
        this.modelQuantized = null as any;
        this.mlComponent.destroy();
        this.buildModel();
      }
    };
    this.mlComponent.onRunningFailed = (error: string) => print("[CoffeeML] model run failed: " + error);

    // Accelerator on device; leave the editor on its default (FastDnn CPU) backend.
    if (!this.isEditor) {
      this.mlComponent.inferenceMode = MachineLearning.InferenceMode.Accelerator;
    }

    const inputs = this.mlComponent.getInputs();
    const outputs = this.mlComponent.getOutputs();
    for (let i = 0; i < outputs.length; i++) {
      outputs[i].mode = MachineLearning.OutputMode.Data;
    }
    // Bind the camera texture BEFORE build (binding after can feed a blank first frame).
    inputs[0].texture = this.camTexture;

    this.mlComponent.build([...inputs, ...outputs]);
  }

  private onLoadingFinished(): void {
    this.inputs = this.mlComponent.getInputs();
    this.outputs = this.mlComponent.getOutputs();

    this.detector = new CoffeeDetector(["black robot"], this.scoreThreshold, this.iouThreshold, this.applySigmoid);
    this.detector.initialize(this.outputs, this.inputs);

    this.mlComponent.onRunningFinished = this.onRunningFinished.bind(this);

    const updateEvent = this.createEvent("UpdateEvent");
    updateEvent.bind(() => this.onUpdate());

    this.modelReady = true;
    if (this.debugLog) {
      let shapeInfo = "";
      for (let i = 0; i < this.outputs.length; i++) {
        const s = this.outputs[i].shape;
        shapeInfo += ` [${s.x}x${s.y}x${s.z}]`;
      }
      print("[CoffeeML] model built. outputs:" + shapeInfo);
    }
  }

  private onUpdate(): void {
    if (!this.started || !this.modelReady || this.isRunning) return;

    this.frame++;
    if (this.frame < this.frameSkip) return;
    this.frame = 0;

    this.isRunning = true;
    // Snapshot the head pose now so the (async) detection unprojects against the capture-time view.
    if (this.cameraModelReady) this.saveMatrix();
    if (this.isEditor) {
      // In the editor, give the camera texture a beat to populate before running.
      if (!this.editorDelay) {
        this.editorDelay = this.createEvent("DelayedCallbackEvent");
        this.editorDelay.bind(() => this.mlComponent.runImmediate(true));
      }
      this.editorDelay.reset(0.01);
    } else {
      this.mlComponent.runImmediate(false);
    }
  }

  private onRunningFinished(): void {
    this.isRunning = false;
    if (!this.detector) return;

    // Keep thresholds live so they can be tuned from the Inspector during preview.
    this.detector.setThresholds(this.scoreThreshold, this.iouThreshold);

    const detections = this.detector.parse(this.outputs);
    if (this.debugLog) {
      // print() at 15Hz costs real frame time on device — aggregate to 1x/2s
      this.dbgRuns++;
      if (detections.length > 0) {
        this.dbgHits++;
        if (detections[0].score > this.dbgBest) this.dbgBest = detections[0].score;
      }
      const now = getTime();
      if (now - this.dbgLastPrint > 2.0) {
        print("[CoffeeML] " + this.dbgHits + "/" + this.dbgRuns
          + " hits, best=" + (this.dbgHits > 0 ? this.dbgBest.toFixed(2) : "-"));
        this.dbgLastPrint = now;
        this.dbgRuns = 0; this.dbgHits = 0; this.dbgBest = 0;
      }
    }
    for (let i = 0; i < this.onDetectionsCbs.length; i++) {
      this.onDetectionsCbs[i](detections);
    }
  }
}
