/**
 * Detection model + non-max suppression helpers shared by the coffee-cup detector.
 * Boxes are stored as normalized [centerX, centerY, width, height] in 0..1 image space.
 */

export class Detection {
  /** [centerX, centerY, width, height], normalized 0..1 in the model input image. */
  bbox: number[];
  /** Confidence = objectness * classScore. */
  score: number;
  /** Class index. */
  index: number;
  /** Human-readable class label (optional). */
  label: string;

  constructor(bbox: number[], score: number, index: number, label: string = "") {
    this.bbox = bbox;
    this.score = score;
    this.index = index;
    this.label = label;
  }

  get centerX(): number {
    return this.bbox[0];
  }
  get centerY(): number {
    return this.bbox[1];
  }
}

export class DetectionHelpers {
  /** Sort comparator: highest score first. */
  static compareByScoreReversed(a: Detection, b: Detection): number {
    return b.score - a.score;
  }

  /** Intersection-over-union for two center-form boxes. */
  static iou(boxA: number[], boxB: number[]): number {
    const ax1 = boxA[0] - boxA[2] / 2;
    const ay1 = boxA[1] - boxA[3] / 2;
    const ax2 = boxA[0] + boxA[2] / 2;
    const ay2 = boxA[1] + boxA[3] / 2;
    const bx1 = boxB[0] - boxB[2] / 2;
    const by1 = boxB[1] - boxB[3] / 2;
    const bx2 = boxB[0] + boxB[2] / 2;
    const by2 = boxB[1] + boxB[3] / 2;

    const ix1 = Math.max(ax1, bx1);
    const iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);

    const iw = Math.max(ix2 - ix1, 0);
    const ih = Math.max(iy2 - iy1, 0);
    const inter = iw * ih;

    const areaA = boxA[2] * boxA[3];
    const areaB = boxB[2] * boxB[3];
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
  }

  /** Greedy non-max suppression. Returns surviving detections (unsorted by caller). */
  static nms(
    boxes: number[][],
    scores: { cls: number; score: number }[],
    scoreThresh: number,
    iouThresh: number
  ): Detection[] {
    let candidates: Detection[] = [];
    for (let i = 0; i < boxes.length; i++) {
      if (scores[i].score > scoreThresh) {
        candidates.push(new Detection(boxes[i], scores[i].score, scores[i].cls));
      }
    }
    candidates.sort(DetectionHelpers.compareByScoreReversed);

    const result: Detection[] = [];
    while (candidates.length > 0) {
      const current = candidates.shift() as Detection;
      result.push(current);
      candidates = candidates.filter((item) => {
        // Only suppress boxes of the same class that overlap heavily.
        if (current.index === item.index) {
          return DetectionHelpers.iou(current.bbox, item.bbox) < iouThresh;
        }
        return true;
      });
    }
    return result;
  }
}
