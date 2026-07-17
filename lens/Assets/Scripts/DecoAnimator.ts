/**
 * DecoAnimator – the "pinball liveliness" layer:
 * - electric arcs orbit capacitors with random speeds + flicker
 * - deco rings breathe (scale pulse, phased)
 * - chip plates blink occasionally
 * - energy pulses travel along the PCB trace paths
 */
import { FieldMath } from "./FieldMath";
import { GlowKit } from "./GlowKit";

export interface TracePath {
  points: vec3[]; // local cm points on fieldRoot
  length: number;
}

export class DecoAnimator {
  private t = 0;
  private arcSpeeds: number[] = [];
  private arcFlicker: number[] = [];
  private pulses: { obj: SceneObject; path: number; dist: number; speed: number }[] = [];

  constructor(
    glow: GlowKit,
    fieldRoot: SceneObject,
    private arcs: SceneObject[],
    private rings: SceneObject[],
    private blinkers: SceneObject[],
    private paths: TracePath[]
  ) {
    for (let i = 0; i < arcs.length; i++) {
      this.arcSpeeds.push((1.5 + Math.random() * 3.0) * (i % 2 === 0 ? 1 : -1));
      this.arcFlicker.push(Math.random());
    }
    // energy pulse pool: dim sparks traveling the traces
    const pool = global.scene.createSceneObject("TracePulses");
    pool.setParent(fieldRoot);
    const n = Math.min(10, paths.length);
    for (let i = 0; i < n; i++) {
      const obj = glow.flatQuad(pool, "Pulse" + i, 1.5, 1.5, "green", "spark", 0.06);
      this.pulses.push({
        obj,
        path: i % Math.max(1, paths.length),
        dist: Math.random(),
        speed: 3.5 + Math.random() * 3.0, // cm/s
      });
    }
  }

  tick(dt: number) {
    this.t += dt;

    // arcs: orbit + flicker
    for (let i = 0; i < this.arcs.length; i++) {
      const a = this.arcs[i];
      const tr = a.getTransform();
      const rot = quat.angleAxis(this.arcSpeeds[i] * dt, vec3.up());
      tr.setLocalRotation(rot.multiply(tr.getLocalRotation()));
      this.arcFlicker[i] += dt;
      if (this.arcFlicker[i] > 0.07) {
        this.arcFlicker[i] = 0;
        a.enabled = Math.random() > 0.25; // 75% duty electric flicker
      }
    }

    // rings breathe
    for (let i = 0; i < this.rings.length; i++) {
      const s = 1.0 + Math.sin(this.t * 2.2 + i * 1.7) * 0.10;
      this.rings[i].getTransform().setLocalScale(new vec3(s, 1, s));
    }

    // chips blink: mostly on, occasional quick double-blink
    for (let i = 0; i < this.blinkers.length; i++) {
      const phase = this.t * 0.7 + i * 2.9;
      const blink = Math.sin(phase * 7.0) > 0.985 || Math.sin(phase * 3.1) > 0.995;
      const sc = blink ? 1.25 : 1.0;
      this.blinkers[i].getTransform().setLocalScale(new vec3(sc, 1, sc));
    }

    // energy pulses run the traces
    for (const p of this.pulses) {
      if (this.paths.length === 0) break;
      const path = this.paths[p.path % this.paths.length];
      p.dist += (p.speed * dt) / Math.max(1e-3, path.length);
      if (p.dist >= 1) {
        p.dist = 0;
        p.path = Math.floor(Math.random() * this.paths.length);
      }
      const pos = samplePath(path, p.dist);
      p.obj.getTransform().setLocalPosition(pos);
    }
  }
}

function samplePath(path: TracePath, t: number): vec3 {
  const pts = path.points;
  if (pts.length < 2) return pts[0] || new vec3(0, 0, 0);
  const target = t * path.length;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const seg = a.distance(b);
    if (acc + seg >= target && seg > 1e-5) {
      const k = (target - acc) / seg;
      return new vec3(
        a.x + (b.x - a.x) * k,
        a.y + (b.y - a.y) * k + 0.05,
        a.z + (b.z - a.z) * k
      );
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}
