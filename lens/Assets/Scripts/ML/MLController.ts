import Event from "SpectaclesInteractionKit.lspkg/Utils/Event";
import { Detection, DetectionHelpers } from "./DetectionHelpers";
import { CameraService } from "../CameraService";

type GridEntry = [number, number];

/**
 * Runs a YOLOv7 ONNX model on the world camera feed and emits parsed
 * detections via `onDetections`. Adapted from the phone-defense MLController
 * but stripped of game-phase coupling — gating is via `setEnabled`.
 */
@component
export class MLController extends BaseScriptComponent {
  @input model: MLAsset;

  @input
  @hint("Print model load + detection diagnostics")
  modelInfo: boolean = false;

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  scoreThreshold: number = 0.6;

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  iouThreshold: number = 0.4;

  @input
  @hint("Frames to skip between inferences. 5 ≈ 12 ML runs/sec at 60fps.")
  mlFrameSkip: number = 5;

  // Public detection stream — ToyTracker subscribes and associates detections
  // with spawned GrabbableBoxes.
  public onDetections = new Event<Detection[]>();

  // Single-class toy detector. To extend to per-toy classes, append entries
  // here AND retrain the model — class indices must align with model output.
  private classSettings: { label: string; enabled: boolean }[] = [
    { label: "toy", enabled: true },
  ];
  private classCount: number = this.classSettings.length;

  // YOLOv7 anchors / strides — copied as a starting point from a 1280-input
  // YOLOv7 model. If toys.onnx was trained at a different input shape these
  // will need re-derivation; expose via inspector if tuning becomes frequent.
  private anchors: number[][][] = [
    [[96, 196], [198, 144], [188, 381]],
    [[371, 288], [499, 634], [1194, 1043]],
    [[32, 42], [51, 96], [106, 74]],
  ];
  private strides: number[] = [16, 32, 8];

  private grids: GridEntry[][][] = [];
  private boxes: [number, number, number, number][] = [];
  private scores: { cls: number; score: number }[] = [];
  private boxCount: number = 0;
  private scoreCount: number = 0;
  private inputShape: vec3;
  private mlComponent: MLComponent;
  private outputs: OutputPlaceholder[];
  private inputs: InputPlaceholder[];
  private isRunning: boolean = false;
  private inferenceEnabled: boolean = false;
  private currentFrame: number = 0;
  private modelReady: boolean = false;
  private isEditor: boolean = false;

  onAwake() {
    this.isEditor = global.deviceInfoSystem.isEditor();
    this.createEvent("OnStartEvent").bind(() => this.init());
    // Editor: tick from UpdateEvent. Device: tick from CameraService.onNewFrame
    // (wired in onLoadingFinished, fires only when a fresh camera frame
    // arrives — required because runImmediate on device needs a real frame).
    if (this.isEditor) {
      this.createEvent("UpdateEvent").bind(() => this.onTick());
    }
  }

  /**
   * Toggle inference. Off by default — SceneController flips this on once
   * Gemini detection has spawned at least one box (no point burning GPU
   * before there's anything to track).
   */
  public setEnabled(enabled: boolean): void {
    this.inferenceEnabled = enabled;
    print("[MLController] setEnabled(" + enabled + ") modelReady=" + this.modelReady);
    if (!enabled) {
      this.currentFrame = 0;
    }
  }

  private init(): void {
    print("[MLController] init() starting, isEditor=" + this.isEditor);
    if (!this.model) {
      print("[MLController] No model asset assigned");
      return;
    }

    // Camera acquisition is delegated to CameraService (singleton). It owns
    // the world-camera request + screenCropTexture wiring + onNewFrame
    // subscription. We just wait for it to be ready, then build the model.
    const camService = CameraService.getInstance();
    if (!camService) {
      print("[MLController] ERROR: CameraService instance not found — add a CameraService component to the scene");
      return;
    }

    const onReady = () => {
      print("[MLController] CameraService ready, building model");
      this.buildModel();
    };

    if (camService.isCameraReady()) {
      onReady();
    } else {
      camService.onCameraReady.add(onReady);
    }
  }

  private buildModel(): void {
    this.mlComponent = this.getSceneObject().createComponent("MLComponent");
    this.mlComponent.model = this.model;
    this.mlComponent.onLoadingFinished = this.onLoadingFinished.bind(this);
    this.mlComponent.inferenceMode = MachineLearning.InferenceMode.Accelerator;
    this.mlComponent.build([]);
  }

  private onLoadingFinished(): void {
    this.outputs = this.mlComponent.getOutputs();
    this.inputs = this.mlComponent.getInputs();
    this.printInfo("Model built");

    for (let i = 0; i < this.outputs.length; i++) {
      const shape = this.outputs[i].shape;
      this.grids.push(this.makeGrid(shape.x, shape.y));
    }
    this.inputShape = this.inputs[0].shape;
    const camService = CameraService.getInstance();
    if (!camService) {
      print("[MLController] ERROR: CameraService disappeared between init and model build");
      return;
    }
    this.inputs[0].texture = camService.screenCropTexture;

    this.mlComponent.onRunningFinished = this.onRunningFinished.bind(this);
    this.modelReady = true;

    // On device, inference must be driven by actual camera frames — calling
    // runImmediate from a generic UpdateEvent fires faster than camera frames
    // arrive. CameraService re-broadcasts onNewFrame for all consumers.
    if (!this.isEditor) {
      camService.onNewFrame.add(() => this.onTick());
      print("[MLController] device frame callback wired (via CameraService)");
    }
  }

  private onTick(): void {
    if (!this.inferenceEnabled || !this.modelReady) return;
    if (this.isRunning) return;

    this.currentFrame++;
    if (this.currentFrame < this.mlFrameSkip) return;
    this.currentFrame = 0;

    if (!(this as any)._sawFirstRun) {
      (this as any)._sawFirstRun = true;
      print("[MLController] first inference dispatched");
    }
    this.isRunning = true;
    // Editor: sync runImmediate(true), wrapped in a 1-frame delay so the
    //   crop texture's transformer has time to refresh.
    // Device: async runImmediate(false). The camera-frame callback already
    //   guaranteed a fresh frame is available; sync mode would block on it.
    try {
      if (this.isEditor) {
        const delay = this.createEvent("DelayedCallbackEvent");
        delay.bind(() => {
          try {
            this.mlComponent.runImmediate(true);
          } catch (e) {
            this.isRunning = false;
            this.warnOnce("runImmediate(editor) failed: " + e);
          }
        });
        delay.reset(0.01);
      } else {
        this.mlComponent.runImmediate(false);
      }
    } catch (e) {
      this.isRunning = false;
      this.warnOnce("runImmediate failed: " + e);
    }
  }

  private cropTextureWarned: boolean = false;
  private warnOnce(msg: string): void {
    if (this.cropTextureWarned) return;
    this.cropTextureWarned = true;
    print("[MLController] " + msg);
  }

  private onRunningFinished(): void {
    if (!(this as any)._sawFirstResult) {
      (this as any)._sawFirstResult = true;
      print("[MLController] first inference RESULT arrived");
    }
    (this as any)._lastMaxConf = (this as any)._maxConf || 0;
    (this as any)._maxConf = 0;
    (this as any)._runsSeen = ((this as any)._runsSeen || 0) + 1;
    if ((this as any)._runsSeen % 40 === 1 && (this as any)._runsSeen > 1) {
      print("[MLController] raw maxConf(prev frame)=" +
            ((this as any)._lastMaxConf || 0).toFixed(3) +
            " thr=" + this.scoreThreshold);
    }
    this.parseYolo7Outputs(this.outputs);

    const result = DetectionHelpers.nms(
      this.boxes,
      this.scores,
      this.boxCount,
      this.scoreCount,
      this.scoreThreshold,
      this.iouThreshold
    );

    for (let i = 0; i < result.length; i++) {
      if (this.classSettings.length > result[i].index) {
        result[i].label = this.classSettings[result[i].index].label;
      }
    }

    // Heartbeat every Nth inference so we can tell YOLO is alive even when
    // it's finding nothing. modelInfo=true bumps to per-frame logging.
    this.heartbeatCount++;
    if (this.modelInfo) {
      print("[MLController] inference #" + this.heartbeatCount + ": " + result.length + " detection(s)");
    } else if (this.heartbeatCount % 5 === 0) {
      print("[MLController] heartbeat #" + this.heartbeatCount + ": " + result.length + " detection(s) (last 5 inferences)");
    }

    this.onDetections.invoke(result);
    this.isRunning = false;
  }

  private heartbeatCount: number = 0;

  private parseYolo7Outputs(outputs: OutputPlaceholder[]): void {
    this.boxCount = 0;
    this.scoreCount = 0;

    for (let i = 0; i < outputs.length; i++) {
      const output = outputs[i];
      const data = output.data;
      const shape = output.shape;
      const nx = shape.x;
      const ny = shape.y;
      const step = this.classCount + 4 + 1;

      for (let dy = 0; dy < ny; dy++) {
        for (let dx = 0; dx < nx; dx++) {
          for (let da = 0; da < this.anchors.length; da++) {
            const idx =
              dy * nx * this.anchors.length * step +
              dx * this.anchors.length * step +
              da * step;

            let x = data[idx];
            let y = data[idx + 1];
            let w = data[idx + 2];
            let h = data[idx + 3];
            const conf = data[idx + 4];
            if (conf > (this as any)._maxConf) {
              (this as any)._maxConf = conf;
            }

            if (conf <= this.scoreThreshold) continue;

            x = (x * 2 - 0.5 + this.grids[i][dy][dx][0]) * this.strides[i];
            y = (y * 2 - 0.5 + this.grids[i][dy][dx][1]) * this.strides[i];
            w = w * w * this.anchors[i][da][0];
            h = h * h * this.anchors[i][da][1];

            // Drop micro-boxes — typical YOLO false positives that cause
            // NMS jitter on otherwise stable detections.
            const boxWidth = w / this.inputShape.x;
            const boxHeight = h / this.inputShape.y;
            if (boxWidth < 0.01 || boxHeight < 0.01) continue;

            const box: [number, number, number, number] = [
              x / this.inputShape.x,
              y / this.inputShape.y,
              w / this.inputShape.y,
              h / this.inputShape.y,
            ];

            const res = { cls: 0, score: 0 };
            for (let nc = 0; nc < this.classCount; nc++) {
              if (!this.classSettings[nc].enabled) continue;
              const class_score = data[idx + 5 + nc] * conf;
              if (class_score > this.scoreThreshold && class_score > res.score) {
                res.cls = nc;
                res.score = class_score;
              }
            }

            if (res.score > 0) {
              if (this.boxCount < this.boxes.length) {
                this.boxes[this.boxCount] = box;
                this.scores[this.scoreCount] = res;
              } else {
                this.boxes.push(box);
                this.scores.push(res);
              }
              this.boxCount++;
              this.scoreCount++;
            }
          }
        }
      }
    }
  }

  private makeGrid(nx: number, ny: number): GridEntry[][] {
    const grids: GridEntry[][] = [];
    for (let dy = 0; dy < ny; dy++) {
      const grid: GridEntry[] = [];
      for (let dx = 0; dx < nx; dx++) {
        grid.push([dx, dy]);
      }
      grids.push(grid);
    }
    return grids;
  }

  private printInfo(msg: string): void {
    if (this.modelInfo) print("[MLController] " + msg);
  }
}
