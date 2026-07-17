/**
 * TrailDots (v3) – CONTINUOUS tread ribbons via MeshBuilder: two smooth
 * strips under the left/right treads following the robot's path. The tail
 * TAPERS to nothing — for additive glow, thinner IS dimmer, so the track
 * fades out buttery-smooth with zero extra materials. Rebuilt ~12Hz from a
 * point deque; one mesh per tread.
 */
import { GameConfig } from "./GameConfig";
import { GlowKit } from "./GlowKit";
import { FieldMath } from "./FieldMath";

const TREAD_HALF_MM = 26;   // tread offset from the body centerline
const HALF_W_CM = 2.2;      // fresh tread half-width (cm) — wide skid (2.4x)
const MAX_PTS = 80;
const REBUILD_S = 0.125;

interface TrailPt {
  lx: number; lz: number;   // left tread point, local cm
  rx: number; rz: number;   // right tread point, local cm
  age: number;
}

export class TrailDots {
  private pts: TrailPt[] = [];
  private lastX = 9999;
  private lastY = 9999;
  private leftRmv: RenderMeshVisual;
  private rightRmv: RenderMeshVisual;
  private rebuildT = 0;
  private dirty = false;
  public visible = true;

  constructor(
    private glow: GlowKit,
    private fieldRoot: SceneObject,
    private fieldMath: FieldMath
  ) {
    this.leftRmv = this.makeRibbonObj("TreadL");
    this.rightRmv = this.makeRibbonObj("TreadR");
  }

  private makeRibbonObj(name: string): RenderMeshVisual {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(this.fieldRoot);
    const rmv = obj.createComponent(
      "Component.RenderMeshVisual") as RenderMeshVisual;
    rmv.mainMaterial = this.glow.material("greenDim", "strip");
    return rmv;
  }

  /** Feed the current robot field pose (mm + heading deg) every frame. */
  update(dt: number, x: number, y: number, deg: number, hasPose: boolean) {
    if (hasPose && this.visible) {
      const dx = x - this.lastX;
      const dy = y - this.lastY;
      const step = Math.sqrt(dx * dx + dy * dy);
      if (step > 60) {
        // teleport (placement / delocalize snap) — cut the ribbon
        this.pts = [];
        this.lastX = x;
        this.lastY = y;
        this.dirty = true;
      } else if (step >= GameConfig.TRAIL_STEP_MM) {
        this.lastX = x;
        this.lastY = y;
        const rad = (deg * Math.PI) / 180;
        const px = -Math.sin(rad); // perpendicular (left), field mm
        const py = Math.cos(rad);
        const l = this.fieldMath.fieldToLocal(
          x + px * TREAD_HALF_MM, y + py * TREAD_HALF_MM, 0);
        const r = this.fieldMath.fieldToLocal(
          x - px * TREAD_HALF_MM, y - py * TREAD_HALF_MM, 0);
        this.pts.push({ lx: l.x, lz: l.z, rx: r.x, rz: r.z, age: 0 });
        if (this.pts.length > MAX_PTS) {
          this.pts.shift();
        }
        this.dirty = true;
      }
    }
    let anyAlive = false;
    for (const p of this.pts) {
      p.age += dt;
      if (p.age < GameConfig.TRAIL_FADE_S) {
        anyAlive = true;
      }
    }
    while (this.pts.length > 0
           && this.pts[0].age >= GameConfig.TRAIL_FADE_S) {
      this.pts.shift();
      this.dirty = true;
    }
    this.rebuildT += dt;
    if ((this.dirty || anyAlive) && this.rebuildT >= REBUILD_S) {
      this.rebuildT = 0;
      this.dirty = false;
      this.rebuild();
    }
  }

  /** Ribbon width from age: fresh = full, tail melts away smoothly. */
  private widthAt(age: number): number {
    const k = 1 - age / GameConfig.TRAIL_FADE_S;
    if (k <= 0) {
      return 0;
    }
    return HALF_W_CM * Math.pow(k, 0.75);
  }

  private rebuild() {
    const l = this.buildRibbon(true);
    const r = this.buildRibbon(false);
    this.leftRmv.getSceneObject().enabled = l !== null;
    this.rightRmv.getSceneObject().enabled = r !== null;
    if (l !== null) {
      this.leftRmv.mesh = l;
    }
    if (r !== null) {
      this.rightRmv.mesh = r;
    }
  }

  private buildRibbon(left: boolean): RenderMesh | null {
    const b = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "texture0", components: 2 },
    ]);
    b.topology = MeshTopology.Triangles;
    b.indexType = MeshIndexType.UInt16;
    let vc = 0;
    const y = 0.025;
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i];
      const c = this.pts[i + 1];
      const ax = left ? a.lx : a.rx;
      const az = left ? a.lz : a.rz;
      const cx = left ? c.lx : c.rx;
      const cz = left ? c.lz : c.rz;
      const wa = this.widthAt(a.age);
      const wc = this.widthAt(c.age);
      if (wa <= 0.02 && wc <= 0.02) {
        continue;
      }
      const dx = cx - ax;
      const dz = cz - az;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-4) {
        continue;
      }
      const nx = -dz / len;
      const nz = dx / len;
      // strip texture: v across the ribbon (0 edge, 0.5 core, 1 edge)
      b.appendVerticesInterleaved([
        ax - nx * wa, y, az - nz * wa, 0, 0,
        ax + nx * wa, y, az + nz * wa, 0, 1,
        cx + nx * wc, y, cz + nz * wc, 1, 1,
        ax - nx * wa, y, az - nz * wa, 0, 0,
        cx + nx * wc, y, cz + nz * wc, 1, 1,
        cx - nx * wc, y, cz - nz * wc, 1, 0,
      ]);
      b.appendIndices([vc, vc + 1, vc + 2, vc + 3, vc + 4, vc + 5]);
      vc += 6;
    }
    if (vc === 0) {
      return null; // nothing visible — empty meshes upset the builder
    }
    b.updateMesh();
    return b.getMesh();
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (!v) {
      this.pts = [];
      this.rebuild();
    }
  }
}


/** AirTrails — the tread ribbons' airborne siblings: four DELICATE glow
 * ribbons streaming from the body corners at different heights. Same
 * geometry as TrailDots, thinner and shorter-lived — volumetric speed
 * lines that hang in the air behind the robot. */
const AIR_TRACKS = [
  { lat: -27, h: 2.2 },
  { lat: 27, h: 2.2 },
  { lat: -30, h: 3.8 },
  { lat: 30, h: 3.8 },
  { lat: -20, h: 5.2 },
  { lat: 20, h: 5.2 },
  { lat: -11, h: 7.0 },
  { lat: 11, h: 7.0 },
];
const AIR_HALF_W = 0.22;
const AIR_FADE_S = 0.75;

interface AirPt {
  x: number[]; z: number[]; // per-track local cm
  age: number;
}

export class AirTrails {
  private pts: AirPt[] = [];
  private lastX = 9999;
  private lastY = 9999;
  private rmv: RenderMeshVisual;
  private rebuildT = 0;

  constructor(
    private glow: GlowKit,
    private fieldRoot: SceneObject,
    private fieldMath: FieldMath
  ) {
    const obj = global.scene.createSceneObject("AirTrails");
    obj.setParent(fieldRoot);
    this.rmv = obj.createComponent(
      "Component.RenderMeshVisual") as RenderMeshVisual;
    this.rmv.mainMaterial = this.glow.material("greenDim", "strip");
    this.rmv.getSceneObject().enabled = false;
  }

  update(dt: number, x: number, y: number, deg: number, active: boolean) {
    if (active) {
      const dx = x - this.lastX;
      const dy = y - this.lastY;
      const step = Math.sqrt(dx * dx + dy * dy);
      if (step > 60) {
        this.pts = [];
        this.lastX = x;
        this.lastY = y;
      } else if (step >= 7) {
        this.lastX = x;
        this.lastY = y;
        const rad = (deg * Math.PI) / 180;
        const px = -Math.sin(rad);
        const py = Math.cos(rad);
        const xs: number[] = [], zs: number[] = [];
        for (const tk of AIR_TRACKS) {
          const l = this.fieldMath.fieldToLocal(
            x + px * tk.lat, y + py * tk.lat, 0);
          xs.push(l.x);
          zs.push(l.z);
        }
        this.pts.push({ x: xs, z: zs, age: 0 });
        if (this.pts.length > 26) {
          this.pts.shift();
        }
      }
    }
    let alive = false;
    for (const p of this.pts) {
      p.age += dt;
      if (p.age < AIR_FADE_S) {
        alive = true;
      }
    }
    while (this.pts.length > 0 && this.pts[0].age >= AIR_FADE_S) {
      this.pts.shift();
    }
    this.rebuildT += dt;
    if (this.rebuildT >= 0.125) {
      this.rebuildT = 0;
      if (this.pts.length < 2) {
        if (this.rmv.getSceneObject().enabled) {
          this.rmv.getSceneObject().enabled = false;
        }
      } else {
        this.rebuild();
      }
    }
  }

  private rebuild() {
    const b = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "texture0", components: 2 },
    ]);
    b.topology = MeshTopology.Triangles;
    b.indexType = MeshIndexType.UInt16;
    let vc = 0;
    for (let tki = 0; tki < AIR_TRACKS.length; tki++) {
      const h = AIR_TRACKS[tki].h;
      for (let i = 0; i + 1 < this.pts.length; i++) {
        const a = this.pts[i], c = this.pts[i + 1];
        const wa = AIR_HALF_W * Math.max(0, 1 - a.age / AIR_FADE_S);
        const wc = AIR_HALF_W * Math.max(0, 1 - c.age / AIR_FADE_S);
        if (wa <= 0.015 && wc <= 0.015) {
          continue;
        }
        const ax = a.x[tki], az = a.z[tki];
        const cx = c.x[tki], cz = c.z[tki];
        const ddx = cx - ax, ddz = cz - az;
        const len = Math.sqrt(ddx * ddx + ddz * ddz);
        if (len < 1e-4) {
          continue;
        }
        const nx = -ddz / len, nz = ddx / len;
        b.appendVerticesInterleaved([
          ax - nx * wa, h, az - nz * wa, 0, 0,
          ax + nx * wa, h, az + nz * wa, 0, 1,
          cx + nx * wc, h, cz + nz * wc, 1, 1,
          ax - nx * wa, h, az - nz * wa, 0, 0,
          cx + nx * wc, h, cz + nz * wc, 1, 1,
          cx - nx * wc, h, cz - nz * wc, 1, 0,
        ]);
        b.appendIndices([vc, vc + 1, vc + 2, vc + 3, vc + 4, vc + 5]);
        vc += 6;
      }
    }
    if (vc === 0) {
      this.rmv.getSceneObject().enabled = false;
      return;
    }
    b.updateMesh();
    this.rmv.mesh = b.getMesh();
    this.rmv.getSceneObject().enabled = true;
  }
}
