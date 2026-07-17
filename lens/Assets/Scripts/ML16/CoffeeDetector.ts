/**
 * CoffeeDetector — decodes the coffee.onnx YOLO outputs into Detection[].
 *
 * coffee.onnx (input "images" 224x224x3, normalized x1/255) is a single-class
 * YOLOv5-style detector with three output heads:
 *   - "output" 28x28x18  (stride 8)
 *   - "270"    14x14x18  (stride 16)
 *   - "272"     7x7x18   (stride 32)
 * Each head packs 3 anchors x (x, y, w, h, objectness, 1 class score) = 18 channels.
 *
 * Box CENTERS are anchor-independent — that is what drives the cube placement, so
 * placement is robust even though coffee.onnx's exact training anchors are unknown.
 * Anchors only scale box width/height (used for NMS overlap), so the YOLOv5 defaults
 * below are good enough. Strides are derived from the runtime grid sizes, so head
 * ordering doesn't matter.
 */
import { Detection, DetectionHelpers } from "./DetectionHelpers";

// Standard YOLOv5 anchors keyed by stride.
const ANCHORS_BY_STRIDE: { [stride: number]: number[][] } = {
  8: [
    [10, 13],
    [16, 30],
    [33, 23],
  ],
  16: [
    [30, 61],
    [62, 45],
    [59, 119],
  ],
  32: [
    [116, 90],
    [156, 198],
    [373, 326],
  ],
};

const ANCHORS_PER_CELL = 3;

export class CoffeeDetector {
  private classLabels: string[];
  private scoreThreshold: number;
  private iouThreshold: number;
  private applySigmoid: boolean;

  private inputW = 224;
  private inputH = 224;
  private strides: number[] = [];
  private anchorsPerHead: number[][][] = [];

  constructor(classLabels: string[], scoreThreshold: number, iouThreshold: number, applySigmoid: boolean) {
    this.classLabels = classLabels;
    this.scoreThreshold = scoreThreshold;
    this.iouThreshold = iouThreshold;
    this.applySigmoid = applySigmoid;
  }

  setThresholds(scoreThreshold: number, iouThreshold: number): void {
    this.scoreThreshold = scoreThreshold;
    this.iouThreshold = iouThreshold;
  }

  /** Derive input size, per-head strides and aligned anchors from the built model. */
  initialize(outputs: OutputPlaceholder[], inputs: InputPlaceholder[]): void {
    this.inputW = inputs[0].shape.x;
    this.inputH = inputs[0].shape.y;
    this.strides = [];
    this.anchorsPerHead = [];
    for (let i = 0; i < outputs.length; i++) {
      const stride = Math.round(this.inputW / outputs[i].shape.x);
      this.strides.push(stride);
      this.anchorsPerHead.push(ANCHORS_BY_STRIDE[stride] || ANCHORS_BY_STRIDE[8]);
    }
  }

  private sigmoid(v: number): number {
    return 1 / (1 + Math.exp(-v));
  }

  /** Decode all heads and run NMS. Returns detections sorted by score (best first). */
  parse(outputs: OutputPlaceholder[]): Detection[] {
    const boxes: number[][] = [];
    const scores: { cls: number; score: number }[] = [];
    const classCount = this.classLabels.length;
    const step = classCount + 5; // x,y,w,h,obj + classCount
    const sig = this.applySigmoid;

    for (let i = 0; i < outputs.length; i++) {
      const data = outputs[i].data;
      const nx = outputs[i].shape.x;
      const ny = outputs[i].shape.y;
      const stride = this.strides[i];
      const anchors = this.anchorsPerHead[i];

      for (let dy = 0; dy < ny; dy++) {
        for (let dx = 0; dx < nx; dx++) {
          for (let da = 0; da < ANCHORS_PER_CELL; da++) {
            const idx = (dy * nx * ANCHORS_PER_CELL + dx * ANCHORS_PER_CELL + da) * step;

            let px = data[idx];
            let py = data[idx + 1];
            let pw = data[idx + 2];
            let ph = data[idx + 3];
            let obj = data[idx + 4];
            if (sig) {
              px = this.sigmoid(px);
              py = this.sigmoid(py);
              pw = this.sigmoid(pw);
              ph = this.sigmoid(ph);
              obj = this.sigmoid(obj);
            }

            if (obj <= this.scoreThreshold) continue;

            // YOLOv5 decode → model-input pixels → normalized 0..1.
            const cx = ((px * 2 - 0.5 + dx) * stride) / this.inputW;
            const cy = ((py * 2 - 0.5 + dy) * stride) / this.inputH;
            const w = ((pw * 2) * (pw * 2) * anchors[da][0]) / this.inputW;
            const h = ((ph * 2) * (ph * 2) * anchors[da][1]) / this.inputH;

            let bestCls = 0;
            let bestScore = 0;
            for (let nc = 0; nc < classCount; nc++) {
              let cls = data[idx + 5 + nc];
              if (sig) cls = this.sigmoid(cls);
              const sc = cls * obj;
              if (sc > bestScore) {
                bestScore = sc;
                bestCls = nc;
              }
            }

            if (bestScore > this.scoreThreshold) {
              boxes.push([cx, cy, w, h]);
              scores.push({ cls: bestCls, score: bestScore });
            }
          }
        }
      }
    }

    const detections = DetectionHelpers.nms(boxes, scores, this.scoreThreshold, this.iouThreshold).sort(
      DetectionHelpers.compareByScoreReversed
    );

    for (let i = 0; i < detections.length; i++) {
      const label = this.classLabels[detections[i].index];
      if (label) detections[i].label = label;
    }
    return detections;
  }
}
