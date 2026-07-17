/**
 * GlowKit – textured glow primitives. Every visual is a quad (or strip) with
 * a soft procedural glow texture on an additive material — no more hard
 * primitive edges. Materials are runtime clones of two @input base materials
 * (green / pink, ImageMaterial with Add blend); textures via requireAsset.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";

const log = new NativeLogger("GlowKit");

export const TEX = {
  strip: requireAsset("../Textures/glow_strip.png") as Texture,
  disc: requireAsset("../Textures/glow_disc.png") as Texture,
  ring: requireAsset("../Textures/glow_ring.png") as Texture,
  spark: requireAsset("../Textures/spark.png") as Texture,
  plate: requireAsset("../Textures/glow_plate.png") as Texture,
  metal: requireAsset("../Textures/metal_gradient.png") as Texture,
  frame: requireAsset("../Textures/glow_frame.png") as Texture,
  pool: requireAsset("../Textures/glow_pool.png") as Texture,
};

export type GlowColor = "green" | "pink" | "greenDim" | "pinkDim";
export type GlowTex = keyof typeof TEX;

export class GlowKit {
  private matCache: Map<string, Material> = new Map();

  constructor(private baseGreen: Material, private basePink: Material) {}

  material(color: GlowColor, tex: GlowTex): Material {
    const key = color + ":" + tex;
    let m = this.matCache.get(key);
    if (!m) {
      const dim = color.indexOf("Dim") >= 0;
      const base = color.indexOf("green") === 0 ? this.baseGreen : this.basePink;
      m = base.clone();
      // 5.15: clones reset graph defaults — set EVERYTHING ourselves
      m.mainPass.blendMode = BlendMode.Add;
      m.mainPass.depthWrite = false;
      m.mainPass.depthTest = true;
      m.mainPass.baseTex = TEX[tex];
      const g = color.indexOf("green") === 0;
      m.mainPass.baseColor = dim
        ? (g ? new vec4(0.08, 0.38, 0.14, 1) : new vec4(0.36, 0.09, 0.27, 1))
        : (g ? new vec4(0.2, 1.15, 0.42, 1) : new vec4(1.1, 0.25, 0.78, 1));

      this.matCache.set(key, m);
    }
    return m;
  }

  /** Opaque graphite-gradient material for metal prop parts (no PBR, no
   * lights — just a vertical gradient texture, per the perf rule). */
  metalMaterial(): Material {
    let m = this.matCache.get("metalGrad");
    if (!m) {
      m = this.baseGreen.clone();
      m.mainPass.baseTex = TEX.metal;
      m.mainPass.baseColor = new vec4(1, 1, 1, 1);
      m.mainPass.blendMode = BlendMode.Normal;
      m.mainPass.depthWrite = true;
      this.matCache.set("metalGrad", m);
    }
    return m;
  }

  /** Depth-only occluder built from ANY working material: color writes
   * off, depth writes on — no dedicated occluder asset needed. */
  occluderMaterial(): Material {
    let m = this.matCache.get("occluder");
    if (!m) {
      m = this.baseGreen.clone();
      m.mainPass.blendMode = BlendMode.Normal;
      m.mainPass.depthWrite = true;
      m.mainPass.depthTest = true;
      m.mainPass.colorMask = new vec4b(false, false, false, false);
      this.matCache.set("occluder", m);
    }
    return m;
  }

  /** Opaque DARK material for casings/IC bodies (not pure black —
   * additive scenes read pure black as transparent). */
  darkMaterial(): Material {
    let m = this.matCache.get("dark");
    if (!m) {
      m = this.baseGreen.clone();
      m.mainPass.baseTex = TEX.metal;
      m.mainPass.baseColor = new vec4(0.31, 0.32, 0.37, 1); // dark gray, not black
      m.mainPass.blendMode = BlendMode.Normal;
      m.mainPass.depthWrite = true;
      this.matCache.set("dark", m);
    }
    return m;
  }

  /** Opaque TINTED body material (ceramic component look): gradient
   * texture + color tint, normal blending — not see-through. */
  solidTinted(colorKey: "green" | "pink"): Material {
    const key = "solid:" + colorKey;
    let m = this.matCache.get(key);
    if (!m) {
      m = (colorKey === "green" ? this.baseGreen : this.basePink).clone();
      m.mainPass.baseTex = TEX.metal;
      m.mainPass.baseColor = colorKey === "green"
        ? new vec4(0.2, 1.1, 0.42, 1)
        : new vec4(1.1, 0.25, 0.78, 1);
      m.mainPass.blendMode = BlendMode.Normal;
      m.mainPass.depthWrite = true;
      this.matCache.set(key, m);
    }
    return m;
  }

  /** Depth-only occluder BOX (cm dims) — AR knows the object's volume. */
  occluderBox(parent: SceneObject, name: string,
              w: number, h: number, d: number): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    const x = w / 2, y = h, z = d / 2;
    // 5 faces (skip the bottom — it sits on the table)
    const v = [
      // top
      -x, y, -z, 0, 0,  -x, y, z, 0, 1,  x, y, z, 1, 1,
      -x, y, -z, 0, 0,  x, y, z, 1, 1,  x, y, -z, 1, 0,
      // +z
      -x, 0, z, 0, 0,  -x, y, z, 0, 1,  x, y, z, 1, 1,
      -x, 0, z, 0, 0,  x, y, z, 1, 1,  x, 0, z, 1, 0,
      // -z
      -x, 0, -z, 0, 0,  x, 0, -z, 1, 0,  x, y, -z, 1, 1,
      -x, 0, -z, 0, 0,  x, y, -z, 1, 1,  -x, y, -z, 0, 1,
      // +x
      x, 0, -z, 0, 0,  x, 0, z, 1, 0,  x, y, z, 1, 1,
      x, 0, -z, 0, 0,  x, y, z, 1, 1,  x, y, -z, 0, 1,
      // -x
      -x, 0, -z, 0, 0,  -x, y, -z, 0, 1,  -x, y, z, 1, 1,
      -x, 0, -z, 0, 0,  -x, y, z, 1, 1,  -x, 0, z, 1, 0,
    ];
    b.appendVerticesInterleaved(v);
    const n = v.length / 5;
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(i);
    b.appendIndices(idx);
    this.finish(obj, b, this.occluderMaterial());
    const rmv = obj.getComponent("Component.RenderMeshVisual");
    if (rmv) (rmv as RenderMeshVisual).setRenderOrder(-10);
    return obj;
  }

  /** MANY floor lines in ONE mesh (one draw call) — for the static
   * circuit net. Geometry identical to line(). */
  batchedLines(parent: SceneObject, name: string,
               segs: { x1: number; z1: number; x2: number; z2: number }[],
               w: number, color: GlowColor, y: number): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    let vc = 0;
    for (const sg of segs) {
      const dx = sg.x2 - sg.x1, dz = sg.z2 - sg.z1;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-4) continue;
      const nx = (-dz / len) * (w / 2);
      const nz = (dx / len) * (w / 2);
      b.appendVerticesInterleaved([
        sg.x1 - nx, y, sg.z1 - nz, 0, 0,
        sg.x1 + nx, y, sg.z1 + nz, 0, 1,
        sg.x2 + nx, y, sg.z2 + nz, 1, 1,
        sg.x1 - nx, y, sg.z1 - nz, 0, 0,
        sg.x2 + nx, y, sg.z2 + nz, 1, 1,
        sg.x2 - nx, y, sg.z2 - nz, 1, 0,
      ]);
      b.appendIndices([vc, vc + 1, vc + 2, vc + 3, vc + 4, vc + 5]);
      vc += 6;
    }
    this.finish(obj, b, this.material(color, "strip"));
    return obj;
  }

  /** MANY discs in ONE mesh — for vias/pads of the static net. */
  batchedDiscs(parent: SceneObject, name: string,
               pts: { x: number; z: number }[], size: number,
               color: GlowColor, y: number): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    const h = size / 2;
    let vc = 0;
    for (const p of pts) {
      b.appendVerticesInterleaved([
        p.x - h, y, p.z - h, 0, 0,
        p.x - h, y, p.z + h, 0, 1,
        p.x + h, y, p.z + h, 1, 1,
        p.x - h, y, p.z - h, 0, 0,
        p.x + h, y, p.z + h, 1, 1,
        p.x + h, y, p.z - h, 1, 0,
      ]);
      b.appendIndices([vc, vc + 1, vc + 2, vc + 3, vc + 4, vc + 5]);
      vc += 6;
    }
    this.finish(obj, b, this.material(color, "disc"));
    return obj;
  }

  /** Vertical light curtain along a closed floor path (x,z pairs):
   * bright at the floor, fading up — for contour-matched burst walls. */
  wallLoop(parent: SceneObject, name: string, pts: vec2[], h: number,
           color: GlowColor): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    let vc = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const A = [a.x, 0, a.y], B = [a.x, h, a.y];
      const C = [c.x, h, c.y], D = [c.x, 0, c.y];
      b.appendVerticesInterleaved([
        ...A, 0, 0.5, ...B, 0, 1, ...C, 1, 1,
        ...A, 0, 0.5, ...C, 1, 1, ...D, 1, 0.5,
      ]);
      b.appendIndices([vc, vc + 1, vc + 2, vc + 3, vc + 4, vc + 5]);
      b.appendVerticesInterleaved([
        ...A, 0, 0.5, ...C, 1, 1, ...B, 0, 1,
        ...A, 0, 0.5, ...D, 1, 0.5, ...C, 1, 1,
      ]);
      b.appendIndices([vc + 6, vc + 7, vc + 8, vc + 9, vc + 10, vc + 11]);
      vc += 12;
    }
    this.finish(obj, b, this.material(color, "strip"));
    return obj;
  }

  /** Jagged 3D lightning ribbon through the given points (double-sided
   * vertical band, strip texture). For capacitor strikes. */
  boltRibbon(parent: SceneObject, name: string, pts: vec3[],
             w: number, color: GlowColor): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    let vc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], c = pts[i + 1];
      const A = [a.x, a.y - w / 2, a.z], B = [a.x, a.y + w / 2, a.z];
      const C = [c.x, c.y + w / 2, c.z], D = [c.x, c.y - w / 2, c.z];
      b.appendVerticesInterleaved([
        ...A, 0, 0.5, ...B, 0, 1, ...C, 1, 1,
        ...A, 0, 0.5, ...C, 1, 1, ...D, 1, 0.5,
      ]);
      b.appendIndices([vc, vc + 1, vc + 2, vc + 3, vc + 4, vc + 5]);
      b.appendVerticesInterleaved([
        ...A, 0, 0.5, ...C, 1, 1, ...B, 0, 1,
        ...A, 0, 0.5, ...D, 1, 0.5, ...C, 1, 1,
      ]);
      b.appendIndices([vc + 6, vc + 7, vc + 8, vc + 9, vc + 10, vc + 11]);
      vc += 12;
    }
    this.finish(obj, b, this.material(color, "strip"));
    return obj;
  }

  /** Flat textured quad lying on the plane (full texture mapped). */
  flatQuad(parent: SceneObject, name: string, w: number, l: number,
           color: GlowColor, tex: GlowTex, y: number = 0.05): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    // quad centered at origin, w along x, l along z, facing up
    const hw = w / 2, hl = l / 2;
    b.appendVerticesInterleaved([
      -hw, y, -hl, 0, 0,
      -hw, y, hl, 0, 1,
      hw, y, hl, 1, 1,
      -hw, y, -hl, 0, 0,
      hw, y, hl, 1, 1,
      hw, y, -hl, 1, 0,
    ]);
    b.appendIndices([0, 1, 2, 3, 4, 5]); // same order as проверенный floorQuad
    this.finish(obj, b, this.material(color, tex));
    return obj;
  }

  /** Soft glow line on the floor from (x1,z1) to (x2,z2), width w. */
  line(parent: SceneObject, name: string, x1: number, z1: number,
       x2: number, z2: number, w: number, color: GlowColor,
       y: number = 0.04): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.sqrt(dx * dx + dz * dz);
    const nx = (-dz / len) * (w / 2);
    const nz = (dx / len) * (w / 2);
    // strip texture: v across the width (0 edge, 0.5 core, 1 edge)
    b.appendVerticesInterleaved([
      x1 - nx, y, z1 - nz, 0, 0,
      x1 + nx, y, z1 + nz, 0, 1,
      x2 + nx, y, z2 + nz, 1, 1,
      x1 - nx, y, z1 - nz, 0, 0,
      x2 + nx, y, z2 + nz, 1, 1,
      x2 - nx, y, z2 - nz, 1, 0,
    ]);
    b.appendIndices([0, 1, 2, 3, 4, 5]);
    this.finish(obj, b, this.material(color, "strip"));
    return obj;
  }

  /** Vertical light wall along X at depth z: bright at floor, fades up. */
  wall(parent: SceneObject, name: string, x1: number, x2: number,
       z: number, h: number, color: GlowColor): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    // strip texture half: v=0.5 (core) at floor -> v=1 (edge) at top
    b.appendVerticesInterleaved([
      x1, 0, z, 0, 0.5,
      x1, h, z, 0, 1,
      x2, h, z, 1, 1,
      x1, 0, z, 0, 0.5,
      x2, h, z, 1, 1,
      x2, 0, z, 1, 0.5,
    ]);
    b.appendIndices([0, 1, 2, 3, 4, 5]);
    // double-sided: mirrored winding copy
    b.appendVerticesInterleaved([
      x1, 0, z, 0, 0.5,
      x2, h, z, 1, 1,
      x1, h, z, 0, 1,
      x1, 0, z, 0, 0.5,
      x2, 0, z, 1, 0.5,
      x2, h, z, 1, 1,
    ]);
    b.appendIndices([6, 7, 8, 9, 10, 11]);
    this.finish(obj, b, this.material(color, "strip"));
    return obj;
  }

  /** Real 3D neon TUBE: horizontal cylinder from (x1,z1) to (x2,z2) at
   * height cy, radius r. Strip texture wraps the circumference so the tube
   * has a hot streak + soft falloff — reads volumetric from any angle. */
  tube(parent: SceneObject, name: string, x1: number, z1: number,
       x2: number, z2: number, cy: number, r: number,
       color: GlowColor): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.sqrt(dx * dx + dz * dz);
    const ux = dx / len, uz = dz / len;      // along-axis
    const px = -uz, pz = ux;                 // perpendicular in plane
    const SEGS = 28;
    let vc = 0;
    for (let i = 0; i < SEGS; i++) {
      const a0 = (i / SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGS) * Math.PI * 2;
      // ring offset: cos -> vertical, sin -> horizontal perpendicular
      const o0y = Math.cos(a0) * r, o0p = Math.sin(a0) * r;
      const o1y = Math.cos(a1) * r, o1p = Math.sin(a1) * r;
      // v: hot streak at the top (a=0 -> v=0.5), edges fade
      const v0 = 0.5 + (a0 > Math.PI ? a0 - 2 * Math.PI : a0) / (Math.PI * 2.2);
      const v1 = 0.5 + (a1 > Math.PI ? a1 - 2 * Math.PI : a1) / (Math.PI * 2.2);
      const A = [x1 + px * o0p, cy + o0y, z1 + pz * o0p];
      const B = [x2 + px * o0p, cy + o0y, z2 + pz * o0p];
      const C = [x2 + px * o1p, cy + o1y, z2 + pz * o1p];
      const D = [x1 + px * o1p, cy + o1y, z1 + pz * o1p];
      b.appendVerticesInterleaved([
        ...A, 0, v0, ...B, 1, v0, ...C, 1, v1,
        ...A, 0, v0, ...C, 1, v1, ...D, 0, v1,
      ]);
      b.appendIndices([vc, vc + 1, vc + 2, vc + 3, vc + 4, vc + 5]);
      // reverse winding copy (visible from inside/any side)
      b.appendVerticesInterleaved([
        ...A, 0, v0, ...C, 1, v1, ...B, 1, v0,
        ...A, 0, v0, ...D, 0, v1, ...C, 1, v1,
      ]);
      b.appendIndices([vc + 6, vc + 7, vc + 8, vc + 9, vc + 10, vc + 11]);
      vc += 12;
    }
    this.finish(obj, b, this.material(color, "strip"));
    return obj;
  }

  /** Vertical glow cylinder (full 360): fades toward the top. For mallet
   * bodies, domes, lamp cores. */
  cylinderGlow(parent: SceneObject, name: string, r: number, h: number,
               color: GlowColor, y0: number = 0): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    const SEGS = 32;
    let vc = 0;
    for (let i = 0; i < SEGS; i++) {
      const a0 = (i / SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGS) * Math.PI * 2;
      const A = [Math.cos(a0) * r, y0, Math.sin(a0) * r];
      const B = [Math.cos(a1) * r, y0, Math.sin(a1) * r];
      const C = [Math.cos(a1) * r, y0 + h, Math.sin(a1) * r];
      const D = [Math.cos(a0) * r, y0 + h, Math.sin(a0) * r];
      // v: bright at base (0.5) fading to edge (1.0) at top
      b.appendVerticesInterleaved([
        ...A, 0, 0.5, ...B, 1, 0.5, ...C, 1, 1,
        ...A, 0, 0.5, ...C, 1, 1, ...D, 0, 1,
      ]);
      b.appendIndices([vc, vc + 1, vc + 2, vc + 3, vc + 4, vc + 5]);
      b.appendVerticesInterleaved([
        ...A, 0, 0.5, ...C, 1, 1, ...B, 1, 0.5,
        ...A, 0, 0.5, ...D, 0, 1, ...C, 1, 1,
      ]);
      b.appendIndices([vc + 6, vc + 7, vc + 8, vc + 9, vc + 10, vc + 11]);
      vc += 12;
    }
    this.finish(obj, b, this.material(color, "strip"));
    return obj;
  }

  /** Jagged electric arc: one mesh of zigzag strip segments wrapped part-way
   * around radius r at height band [y0..y1]. Rotate the object to animate. */
  electricArc(parent: SceneObject, name: string, r: number,
              spanRad: number, segs: number, color: GlowColor,
              y0: number, y1: number, seed: number): SceneObject {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const b = this.newBuilder();
    let s = seed;
    const rnd = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    let vc = 0;
    let a = 0;
    let py = y0 + rnd() * (y1 - y0);
    let pr = r * (0.9 + rnd() * 0.25);
    const w = 0.15;
    for (let i = 0; i < segs; i++) {
      const na = a + spanRad / segs;
      const ny = Math.max(y0, Math.min(y1, py + (rnd() - 0.5) * 2.2));
      const nr = r * (0.9 + rnd() * 0.3);
      const p0 = [Math.cos(a) * pr, py, Math.sin(a) * pr];
      const p1 = [Math.cos(na) * nr, ny, Math.sin(na) * nr];
      // ribbon quad between p0-p1 (vertical width w)
      b.appendVerticesInterleaved([
        p0[0], p0[1] - w, p0[2], 0, 0,
        p0[0], p0[1] + w, p0[2], 0, 1,
        p1[0], p1[1] + w, p1[2], 1, 1,
        p0[0], p0[1] - w, p0[2], 0, 0,
        p1[0], p1[1] + w, p1[2], 1, 1,
        p1[0], p1[1] - w, p1[2], 1, 0,
      ]);
      b.appendIndices([vc, vc + 1, vc + 2, vc + 3, vc + 4, vc + 5]);
      // mirrored copy for double-sided
      b.appendVerticesInterleaved([
        p0[0], p0[1] - w, p0[2], 0, 0,
        p1[0], p1[1] + w, p1[2], 1, 1,
        p0[0], p0[1] + w, p0[2], 0, 1,
        p0[0], p0[1] - w, p0[2], 0, 0,
        p1[0], p1[1] - w, p1[2], 1, 0,
        p1[0], p1[1] + w, p1[2], 1, 1,
      ]);
      b.appendIndices([vc + 6, vc + 7, vc + 8, vc + 9, vc + 10, vc + 11]);
      vc += 12;
      a = na;
      py = ny;
      pr = nr;
    }
    this.finish(obj, b, this.material(color, "strip"));
    return obj;
  }

  /** Empty RenderMeshVisual for dynamic geometry (ribbons etc). */
  emptyVisual(parent: SceneObject, name: string, color: GlowColor,
              tex: GlowTex): RenderMeshVisual {
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    const rmv = obj.createComponent(
      "Component.RenderMeshVisual") as RenderMeshVisual;
    rmv.mainMaterial = this.material(color, tex);
    return rmv;
  }

  /** Public builder factory for dynamic meshes (same vertex layout). */
  dynBuilder(): MeshBuilder {
    return this.newBuilder();
  }

  private newBuilder(): MeshBuilder {
    const b = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "texture0", components: 2 },
    ]);
    b.topology = MeshTopology.Triangles;
    b.indexType = MeshIndexType.UInt16;
    return b;
  }

  private finish(obj: SceneObject, b: MeshBuilder, mat: Material) {
    b.updateMesh();
    const rmv = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    rmv.mesh = b.getMesh();
    rmv.mainMaterial = mat;
  }
}
