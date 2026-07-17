import Event from "SpectaclesInteractionKit.lspkg/Utils/Event";
import { Detection, DetectionHelpers } from "./DetectionHelpers";
import { MLController } from "./MLController";

/**
 * 2D-IoU multi-object tracker sitting between MLController (raw YOLO
 * detections, no identity) and ToyTracker (world-space association to
 * GrabbableBoxes). Stamps a persistent `trackId` on each detection by
 * linking it to the highest-IoU detection from the previous frame.
 *
 * Why: GrabbableBox↔detection re-association every frame is fragile when
 * toys are physically close — distance/size costs alone can flip identity.
 * 2D bbox IoU between consecutive frames of the SAME physical toy is huge
 * (>0.8) while IoU between two different toys is typically 0, so IDs are
 * a near-perfect identity signal at frame-to-frame timescales.
 *
 * Tracks survive `maxAgeFrames` of unmatched frames before being dropped,
 * which gives a tolerance window for brief occlusion or detector dropouts.
 * After that, the toy gets a fresh ID and the dependent GrabbableBox falls
 * back to distance-based re-claiming via ToyTracker's existing recovery
 * pass.
 *
 * No Kalman predictor — tracks stay at last-seen bbox. With ~12 inferences/sec,
 * a toy moving at hand-carry speeds still has plenty of IoU overlap between
 * frames. If detection rate drops or motion gets faster, add prediction.
 */

interface Track {
  bbox: [number, number, number, number];
  lastSeenFrame: number;
}

@component
export class DetectionTracker extends BaseScriptComponent {
  @input mlController: MLController;

  @input
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("Minimum IoU between this frame's detection and a live track to count as the same toy. Lower = more tolerant of motion between frames; higher = stricter identity. 0.2 is a good starting point.")
  minIou: number = 0.2;

  @input
  @hint("Frames a track survives without a matched detection before being dropped. At ~12 inferences/sec, 10 frames ≈ 0.8s of tolerance for occlusion/dropouts. Higher = more forgiving, but stale tracks may capture a different toy if one wanders into the old bbox.")
  maxAgeFrames: number = 10;

  @input
  @hint("Print per-frame track lifecycle diagnostics")
  debug: boolean = false;

  // Re-emits the same Detection[] array, but with trackId stamped on each
  // entry. Consumers (ToyTracker) subscribe here instead of MLController
  // when ID-stable association is needed.
  public onDetections = new Event<Detection[]>();

  private tracks: Map<number, Track> = new Map();
  private nextId: number = 1;
  private frameCounter: number = 0;

  onAwake() {
    this.createEvent("OnStartEvent").bind(() => {
      if (!this.mlController) {
        print("[DetectionTracker] No MLController assigned");
        return;
      }
      this.mlController.onDetections.add((dets) => this.step(dets));
    });
  }

  /** Drop all tracks. Call when the scene resets. */
  public clearTracks(): void {
    this.tracks.clear();
    this.nextId = 1;
    this.frameCounter = 0;
  }

  private step(detections: Detection[]): void {
    this.frameCounter++;

    // Reset incoming trackIds — defensive in case NMS reuses Detection objects
    for (let i = 0; i < detections.length; i++) detections[i].trackId = 0;

    // Build all candidate (track, detection) pairs with IoU >= minIou.
    // Then greedy-assign by descending IoU. Greedy is fine here because IoU
    // between the same physical toy across one frame dwarfs IoU between
    // different toys — the cost landscape isn't ambiguous.
    type Pair = { trackId: number; detIdx: number; iou: number };
    const pairs: Pair[] = [];
    this.tracks.forEach((track, trackId) => {
      for (let d = 0; d < detections.length; d++) {
        const iou = DetectionHelpers.iou(track.bbox, detections[d].bbox);
        if (iou >= this.minIou) {
          pairs.push({ trackId, detIdx: d, iou });
        }
      }
    });
    pairs.sort((a, b) => b.iou - a.iou);

    const claimedTracks = new Set<number>();
    const claimedDets = new Set<number>();
    let reassigned = 0;
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      if (claimedTracks.has(p.trackId) || claimedDets.has(p.detIdx)) continue;
      claimedTracks.add(p.trackId);
      claimedDets.add(p.detIdx);
      detections[p.detIdx].trackId = p.trackId;
      const t = this.tracks.get(p.trackId);
      if (t) {
        t.bbox = detections[p.detIdx].bbox;
        t.lastSeenFrame = this.frameCounter;
      }
      reassigned++;
    }

    // Unmatched detections → mint a new track ID. This is how new toys
    // entering the scene get identity, and also how toys returning after
    // a track expiry get a fresh ID (ToyTracker's recovery pass picks
    // them back up via distance/size).
    let created = 0;
    for (let d = 0; d < detections.length; d++) {
      if (claimedDets.has(d)) continue;
      const id = this.nextId++;
      const b = detections[d].bbox;
      this.tracks.set(id, {
        bbox: [b[0], b[1], b[2], b[3]],
        lastSeenFrame: this.frameCounter,
      });
      detections[d].trackId = id;
      created++;
    }

    // Age out tracks unseen for > maxAgeFrames
    const dead: number[] = [];
    this.tracks.forEach((track, trackId) => {
      if (this.frameCounter - track.lastSeenFrame > this.maxAgeFrames) {
        dead.push(trackId);
      }
    });
    for (let i = 0; i < dead.length; i++) this.tracks.delete(dead[i]);

    if (this.debug) {
      print(
        "[DetectionTracker] f" + this.frameCounter +
        ": " + reassigned + " re-assigned, " +
        created + " new, " +
        dead.length + " expired, " +
        this.tracks.size + " active tracks"
      );
    }

    this.onDetections.invoke(detections);
  }
}
