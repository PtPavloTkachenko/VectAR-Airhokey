/**
 * FieldBuilder v2 – circuit-board world, all soft glow textures (GlowKit):
 * - field borders/walls (green light walls), goal lines (pink)
 * - PCB trace pattern on the floor (Manhattan traces with via dots)
 * - procedural circuit components scattered OUTSIDE the field:
 *   capacitors (glow cylinders), resistors (striped boxes), chips (pin rows)
 * - puck / paddle / pad as textured glow sprites
 * - Vector avatar: official vector.obj (SDK model) if present, else box;
 *   plus the depth-only occluder
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger";
import { GameConfig } from "./GameConfig";
import { GlowKit, TEX } from "./GlowKit";
import { IntroAssembler } from "./IntroAssembler";

const log = new NativeLogger("FieldBuilder");

const MM = 0.1;
// GLB unit calibration: Blender units -> glTF meters -> LS cm (x100) AND the
// imported prefab carries another x100 root scale, so 0.0001 restores the
// modeled "1 unit = 1 cm". Verified via runtime bounds.
const TUBE_UNIT = 1.0;
const TRACE_W = 0.25; // ONE trace width for the whole circuit
const CAP_UNIT = 1.0;

export interface FieldVisuals {
  fieldRoot: SceneObject;
  puckObj: SceneObject;
  paddleObj: SceneObject;
  avatarRoot: SceneObject;
  padObj: SceneObject;
  blockBurstObj: SceneObject;
  rimObj: SceneObject | null;
  rimMat: Material | null;
  dustMat: Material | null;
  paddleGlowObj: SceneObject;
  headPivotObj: SceneObject | null;
  liftPivotObj: SceneObject | null;
  carriagePivotObj: SceneObject | null;
  cubePadObj: SceneObject | null;
}

export class FieldBuilder {
  /** collected for DecoAnimator (pinball liveliness) */
  public animRings: SceneObject[] = [];
  public arcs: SceneObject[] = [];
  public blinkers: SceneObject[] = [];
  public tracePaths: { points: vec3[]; length: number }[] = [];
  /** the board assembles itself — nothing pops in */
  public intro = new IntroAssembler();

  constructor(
    private scene: SceneObject,
    private glow: GlowKit,
    private matOccluder: Material,
    private vectorModel: ObjectPrefab | undefined,
    private tubeModel: ObjectPrefab | undefined,
    private capModel: ObjectPrefab | undefined,
    private resModel: ObjectPrefab | undefined,
    private chipModel: ObjectPrefab | undefined,
    private puckModel: ObjectPrefab | undefined,
    private malletModel: ObjectPrefab | undefined,
    private matNeonGreen: Material,
    private matNeonPink: Material,
    private matMetal: Material,
    private matRim?: Material
  ) {}

  /** Re-material a GLB prop by part-name convention:
   * glow_*Glass -> textured gradient glow, glow_* -> solid additive neon,
   * metal_* -> dark PBR. Optionally hide all glow_ parts (hideGlow) when
   * the glass is rendered by our own gradient tube instead. */
  private materializeProp(obj: SceneObject, neon: Material,
                          colorKey: "green" | "pink", hideGlow: boolean) {
    const rmvs = obj.getComponents("Component.RenderMeshVisual");
    const n = obj.name;
    for (let i = 0; i < rmvs.length; i++) {
      const rmv = rmvs[i] as RenderMeshVisual;
      if (n.indexOf("glow_") === 0) {
        if (hideGlow) {
          obj.enabled = false;
        } else if (n.indexOf("Glass") >= 0) {
          rmv.mainMaterial = this.glow.material(colorKey, "strip");
        } else {
          rmv.mainMaterial = neon;
        }
      } else if (n.indexOf("metal_") === 0) {
        rmv.mainMaterial = this.glow.metalMaterial(); // gradient graphite
        rmv.setRenderOrder(-5);
      } else if (n.indexOf("dark_") === 0) {
        rmv.mainMaterial = this.glow.darkMaterial();
        rmv.setRenderOrder(-5);
      } else if (n.indexOf("solid_") === 0) {
        rmv.mainMaterial = this.glow.solidTinted(colorKey); // opaque body
        rmv.setRenderOrder(-5); // depth first, neon stripes draw over
      }
    }
    for (let i = 0; i < obj.getChildrenCount(); i++) {
      this.materializeProp(obj.getChild(i), neon, colorKey, hideGlow);
    }
  }

  /** Neon tube: GLB provides the metal end caps; the glass itself is our
   * gradient tube (strip UV around circumference = soft rim falloff) with
   * a thin hot core inside — real volumetric lamp look. */
  private placeTube(parent: SceneObject, name: string,
                    cx: number, cz: number, lengthCm: number,
                    yawRad: number, neon: Material,
                    colorKey: "green" | "pink"): SceneObject {
    const y = 1.1;
    const holder = global.scene.createSceneObject(name);
    holder.setParent(parent);
    holder.getTransform().setLocalPosition(new vec3(cx, 0, cz));
    holder.getTransform().setLocalRotation(quat.angleAxis(yawRad, vec3.up()));
    const half = lengthCm / 2;
    // gradient glass + hot core (local X axis)
    this.glow.tube(holder, name + "Glass", -half + 1.2, 0, half - 1.2, 0,
      y, 0.5, colorKey);
    this.glow.tube(holder, name + "Core", -half + 1.4, 0, half - 1.4, 0,
      y, 0.22, colorKey);
    if (this.tubeModel) {
      const m = this.tubeModel.instantiate(holder);
      m.name = name + "Caps";
      const tr = m.getTransform();
      tr.setLocalPosition(new vec3(0, y, 0));
      const k = lengthCm / 40.0;
      tr.setLocalScale(new vec3(k * TUBE_UNIT, TUBE_UNIT, TUBE_UNIT));
      this.materializeProp(m, neon, colorKey, true); // caps only
    }
    return holder;
  }

  private placeCapacitor(parent: SceneObject, name: string,
                         x: number, z: number, neon: Material,
                         arcColor: "green" | "pink") {
    if (!this.capModel) {
      return;
    }
    const m = this.capModel.instantiate(parent);
    m.name = name;
    const tr = m.getTransform();
    tr.setLocalPosition(new vec3(x, 0, z)); // v2 model: legs reach the board
    tr.setLocalScale(new vec3(CAP_UNIT, CAP_UNIT, CAP_UNIT));
    this.materializeProp(m, neon, arcColor === "green" ? "pink" : "green", false);
    // base glow + tesla arcs around it
    const g = this.glow;
    const holder = global.scene.createSceneObject(name + "Fx");
    holder.setParent(parent);
    holder.getTransform().setLocalPosition(new vec3(x, 0, z));
    const base = g.flatQuad(holder, name + "base", 8.5, 8.5, arcColor, "disc", 0.04);
    for (let k = 0; k < 2; k++) {
      const arc = g.electricArc(holder, name + "arc" + k, 2.4,
        Math.PI * (0.6 + Math.random() * 0.5), 10, arcColor,
        1.2 + k * 1.6, 2.4 + k * 1.6,
        23 + k * 41 + Math.floor(Math.random() * 100));
      this.arcs.push(arc);
    }
    // SOLDER PADS under the capacitor's two legs (GLB legs at local x±0.63)
    for (const sx of [-0.63, 0.63]) {
      const pad = g.flatQuad(parent, name + "pad" + (sx < 0 ? "A" : "B"),
        1.3, 1.3, "green", "disc", 0.025);
      pad.getTransform().setLocalPosition(new vec3(x + sx, 0, z));
    }
  }

  /** Real 3D resistor (Blender GLB) at any angle; returns leg-tip contacts. */
  private placeResistor3D(parent: SceneObject, name: string,
                          x: number, z: number, rotY: number,
                          colorKey: "green" | "pink"
                          ): { tipA: vec2; tipB: vec2 } | null {
    if (!this.resModel) {
      return null;
    }
    const m = this.resModel.instantiate(parent);
    m.name = name;
    const tr = m.getTransform();
    tr.setLocalPosition(new vec3(x, 0, z)); // legs reach the board themselves
    tr.setLocalRotation(quat.angleAxis(rotY, vec3.up()));
    tr.setLocalScale(new vec3(1, 1, 1)); // GLB prefab root carries x100
    const neon = colorKey === "green" ? this.matNeonGreen : this.matNeonPink;
    this.materializeProp(m, neon, colorKey, false);
    const dx = Math.cos(rotY), dz = -Math.sin(rotY);
    const tipA = new vec2(x - dx * 2.2, z - dz * 2.2);
    const tipB = new vec2(x + dx * 2.2, z + dz * 2.2);
    const g = this.glow;
    for (const pair of [[tipA, "A"], [tipB, "B"]] as [vec2, string][]) {
      const pad = g.flatQuad(parent, name + "pad" + pair[1], 1.2, 1.2,
        colorKey, "disc", 0.025);
      pad.getTransform().setLocalPosition(new vec3(pair[0].x, 0, pair[0].y));
    }
    return { tipA, tipB };
  }

  /** Public: re-material the score chip GLB (metal body + green bezel). */
  public materializeChip(obj: SceneObject) {
    this.materializeProp(obj, this.matNeonGreen, "green", false);
  }

  public rimObj: SceneObject | null = null;
  public headPivotObj: SceneObject | null = null;
  public liftPivotObj: SceneObject | null = null;
  public carriagePivotObj: SceneObject | null = null;
  public cubePadObj: SceneObject | null = null;
  public axleOffsetMm = 15; // set by GameController before build()

  private fieldToLocalStatic(xMm: number, yMm: number): vec3 {
    return new vec3(xMm / 10, 0, -yMm / 10);
  }

  public getRimMaterial(): Material | null {
    return this.rimMatPrepared;
  }

  private rimMatPrepared: Material | null = null;

  private applyRimRecursive(obj: SceneObject) {
    const rmv = obj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    if (rmv) {
      if (this.matRim && !this.rimMatPrepared) {
        // hand-authored graph; code drives ONLY rimBoost (0 = invisible)
        this.rimMatPrepared = this.matRim.clone();
        this.rimMatPrepared.mainPass.blendMode = BlendMode.Add;
        this.rimMatPrepared.mainPass.depthWrite = false;
        this.rimMatPrepared.mainPass.rimBoost = 0.0;
        this.rimMatPrepared.mainPass.rimTint = new vec4(0.35, 1.0, 0.5, 1.0);
      }
      rmv.mainMaterial = this.rimMatPrepared
        ? this.rimMatPrepared
        : this.glow.material("green", "strip");
      rmv.setRenderOrder(5); // after the occluder writes depth
    }
    for (let i = 0; i < obj.getChildrenCount(); i++) {
      this.applyRimRecursive(obj.getChild(i));
    }
  }

  private applyOccluderRecursive(obj: SceneObject) {
    const rmv = obj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    if (rmv) {
      rmv.mainMaterial = this.matOccluder
        ? this.matOccluder
        : this.glow.occluderMaterial();
      rmv.setRenderOrder(-10);
    }
    for (let i = 0; i < obj.getChildrenCount(); i++) {
      this.applyOccluderRecursive(obj.getChild(i));
    }
  }

  build(): FieldVisuals {
    const fieldRoot = global.scene.createSceneObject("FieldRoot");
    fieldRoot.setParent(this.scene);
    const g = this.glow;

    const hl = (GameConfig.FIELD_L / 2) * MM;
    const hw = (GameConfig.FIELD_W / 2) * MM;
    const wallH = GameConfig.WALL_H_CM;

    // --- field frame: real GLB NEON TUBES with metal end caps ---
    // long sides: green tubes + soft floor halo under each
    let tubeIdx = 0;
    for (const z of [-hw, hw]) {
      const tag = z < 0 ? "A" : "B";
      const tube = this.placeTube(fieldRoot, "Tube" + tag, 0, z,
        GameConfig.FIELD_L / 10, 0, this.matNeonGreen, "green");
      this.intro.add(tube, 0.7 + tubeIdx * 0.18, "drop", 0.6);
      const halo = g.line(fieldRoot, "TubeFloorHalo" + tag, -hl, z, hl, z, 6.5, "greenDim", 0.06);
      this.intro.add(halo, 0.6 + tubeIdx * 0.18, "grow");
      tubeIdx++;
    }
    // short ends: pink tubes (goal lines)
    for (const x of [-hl, hl]) {
      const tag = x < 0 ? "P" : "V";
      const tube = this.placeTube(fieldRoot, "Goal" + tag, x, 0,
        GameConfig.FIELD_W / 10, Math.PI / 2, this.matNeonPink, "pink");
      this.intro.add(tube, 0.7 + tubeIdx * 0.18, "drop", 0.6);
      const halo = g.line(fieldRoot, "GoalFloorHalo" + tag, x, -hw, x, hw, 6.5, "pinkDim", 0.06);
      this.intro.add(halo, 0.6 + tubeIdx * 0.18, "grow");
      tubeIdx++;
    }
    g.line(fieldRoot, "CenterLine", 0, -hw, 0, hw, 0.5, "greenDim");
    const centerRing = g.flatQuad(fieldRoot, "CenterRing", 9, 9, "greenDim", "ring", 0.045);
    centerRing.getTransform().setLocalPosition(new vec3(0, 0, 0));
    this.animRings.push(centerRing);

    // --- PCB traces on the floor (deterministic pseudo-random Manhattan) ---
    this.buildTraces(fieldRoot, hl, hw);

    // --- circuit components OUTSIDE the field, both sides ---
    this.buildComponents(fieldRoot, hl, hw);

    // --- Vector start pad ---
    const padObj = global.scene.createSceneObject("VectorPad");
    padObj.setParent(fieldRoot);
    // CENTERED placement mark (pad object itself is positioned by state):
    // ring footprint + nose arrow toward the PLAYER (-X)
    g.flatQuad(padObj, "PadRing", 14, 14, "pink", "ring", 0.05);
    g.flatQuad(padObj, "PadCore", 9, 9, "pinkDim", "disc", 0.03);
    g.line(padObj, "PadArrowShaft", 2.5, 0, -4.5, 0, 0.7, "pink", 0.06);
    g.line(padObj, "PadArrowL", -4.5, 0, -3.2, 1.2, 0.6, "pink", 0.06);
    g.line(padObj, "PadArrowR", -4.5, 0, -3.2, -1.2, 0.6, "pink", 0.06);
    padObj.enabled = false;

    // CUBE spot: square outline in the player-side right corner + a
    // depth-only 5.2cm occluder so AR respects the real cube's volume
    const cubePadObj = global.scene.createSceneObject("CubePad");
    cubePadObj.enabled = false;
    if (!GameConfig.CUBE_ENABLED) {
      this.cubePadObj = cubePadObj; // exists but stays dark forever
    }
    cubePadObj.setParent(fieldRoot);
    cubePadObj.getTransform().setLocalPosition(
      this.fieldToLocalStatic(GameConfig.CUBE_FIELD_X,
                              GameConfig.CUBE_FIELD_Y));
    const CP = 3.1; // half-size of the 6.2cm square outline (cm)
    g.batchedLines(cubePadObj, "CubePadFrame", [
      { x1: -CP, z1: -CP, x2: CP, z2: -CP },
      { x1: CP, z1: -CP, x2: CP, z2: CP },
      { x1: CP, z1: CP, x2: -CP, z2: CP },
      { x1: -CP, z1: CP, x2: -CP, z2: -CP },
    ], 0.5, "green", 0.05);
    g.flatQuad(cubePadObj, "CubePadCore", 4.6, 4.6, "greenDim", "disc", 0.03);
    cubePadObj.enabled = false;
    this.cubePadObj = cubePadObj;
    // occluder lives on fieldRoot — must survive when the pad marker hides
    const cubeOccl = g.occluderBox(fieldRoot, "CubeOccluder",
                                   5.2, 5.2, 5.2);
    cubeOccl.enabled = GameConfig.CUBE_ENABLED;
    cubeOccl.getTransform().setLocalPosition(
      this.fieldToLocalStatic(GameConfig.CUBE_FIELD_X,
                              GameConfig.CUBE_FIELD_Y));

    // ambient dust: the hand-placed Helix Emitter is ADOPTED by
    // GameController.adoptDustEmitter() — nothing to build here

    // soft ambience: pink frame gradient under the WHOLE scene —
    // transparent center, glow toward the edges, soft outer falloff
    const ambient = g.flatQuad(fieldRoot, "SceneAmbient",
      (2 * hl + 34) * 0.75, (2 * hw + 34) * 0.75, "pinkDim", "frame", 0.008);
    this.intro.add(ambient, 0.3, "pop", 0.8);

    // --- puck (battery-to-be): layered glow disc ---
    const puckObj = global.scene.createSceneObject("Puck");
    puckObj.setParent(fieldRoot);
    const prCore = GameConfig.PUCK_R * MM; // 1.5 cm true radius
    // BATTERY-CELL puck: dark casing GLB + neon window, halo + light column
    const pg = g.flatQuad(puckObj, "PuckHalo", prCore * 5.2, prCore * 5.2, "pinkDim", "disc", 0.028);
    const pgc = g.flatQuad(puckObj, "PuckHaloCore", prCore * 3.2, prCore * 3.2, "pink", "disc", 0.042);
    const pu = g.flatQuad(puckObj, "PuckUnder", prCore * 2.1, prCore * 2.1, "pink", "disc", 0.015);
    if (this.puckModel) {
      const pm = this.puckModel.instantiate(puckObj);
      pm.name = "PuckModel";
      pm.getTransform().setLocalScale(new vec3(1, 1, 1)); // GLB root x100
      this.materializeProp(pm, this.matNeonPink, "pink", false);
    }
    const pc = g.cylinderGlow(puckObj, "PuckColumn", prCore * 1.15, 10.5, "pinkDim", 0.1);
    for (const o of [pg, pgc, pu, pc]) {
      const rmv = o.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
      rmv.setRenderOrder(10);
    }
    puckObj.enabled = false;

    // --- paddle: air-hockey MALLET (base puck + dome handle, all glow) ---
    const paddleObj = global.scene.createSceneObject("Paddle");
    paddleObj.setParent(fieldRoot);
    const par = GameConfig.PADDLE_R * MM; // 2.5 cm
    // capacitor-style pool ON THE TABLE that follows the mallet's x/z
    // (child discs would fly up with the hand)
    const paddleGlow = global.scene.createSceneObject("PaddleGlowFloor");
    paddleGlow.setParent(fieldRoot);
    g.flatQuad(paddleGlow, "PgWide", par * 4.6, par * 4.6, "greenDim", "disc", 0.028);
    g.flatQuad(paddleGlow, "PgCore", par * 2.9, par * 2.9, "green", "disc", 0.042);
    if (this.malletModel) {
      const mm = this.malletModel.instantiate(paddleObj);
      mm.name = "MalletModel";
      mm.getTransform().setLocalScale(new vec3(1, 1, 1)); // GLB root x100
      this.materializeProp(mm, this.matNeonGreen, "green", false);
    }

    // --- Vector avatar: official model AS THE OCCLUDER (depth-only) ---
    const avatarRoot = global.scene.createSceneObject("VectorAvatar");
    avatarRoot.setParent(fieldRoot);
    let modelOk = false;
    if (this.vectorModel) {
      const model = this.vectorModel.instantiate(avatarRoot);
      model.name = "VectorModel";
      const tr = model.getTransform();
      // SDK obj: Z-up — stand it up (-90 X); nose lands on avatar +X with
      // no extra yaw (dialed in live with red-channel occluder debug)
      tr.setLocalRotation(quat.angleAxis(-Math.PI / 2, vec3.right()));
      tr.setLocalScale(new vec3(1.09, 1.09, 1.09)); // dialed to the real robot on-glass
      // shift so the REAL rotation center (axle) sits on the pose origin
      tr.setLocalPosition(new vec3(-this.axleOffsetMm / 10, 0, 0));
      // depth-only: swap every material for the occluder
      this.applyOccluderRecursive(model);
      // RIM LIGHT shell: slightly larger additive copy — only the thin
      // silhouette band survives the occluder's depth => neon rim
      const rim = this.vectorModel.instantiate(avatarRoot);
      rim.name = "VectorRim";
      const rtr = rim.getTransform();
      rtr.setLocalRotation(quat.angleAxis(-Math.PI / 2, vec3.right()));
      rtr.setLocalScale(new vec3(1.098, 1.098, 1.098));
      // SAME axle shift as the occluder — the shells were visibly split
      rtr.setLocalPosition(new vec3(-this.axleOffsetMm / 10, 0, 0));
      this.applyRimRecursive(rim);
      rim.enabled = true; // always on — intensity is driven via rimBoost
      this.rimObj = rim;

      // ARTICULATION: gather head/lift parts under pivots so the model
      // mirrors the real robot's head angle and lift height
      const headPivot = global.scene.createSceneObject("HeadPivot");
      headPivot.setParent(model);
      headPivot.getTransform().setLocalPosition(new vec3(1.2, 0, 4.2));
      const liftPivot = global.scene.createSceneObject("LiftPivot");
      liftPivot.setParent(model);
      liftPivot.getTransform().setLocalPosition(new vec3(-0.6, 0, 4.4));
      // parallelogram linkage: the FORK rides the arm arc but COUNTER-
      // rotates so it always stays vertical (real Vector mechanics)
      const carriagePivot = global.scene.createSceneObject("CarriagePivot");
      carriagePivot.setParent(liftPivot);
      carriagePivot.getTransform().setLocalPosition(new vec3(2.4, 0, 0));
      const isHead = (n: string) =>
        n.indexOf("head") >= 0 || n.indexOf("eye") >= 0 ||
        n.indexOf("Screen") >= 0 || n.indexOf("screen") >= 0;
      const isFork = (n: string) => n.indexOf("fork") >= 0;
      const isLift = (n: string) =>
        n.indexOf("Arm") >= 0 || n.indexOf("arm") >= 0 ||
        n.indexOf("lift") >= 0;
      const gather = (o: SceneObject) => {
        const kids: SceneObject[] = [];
        for (let i = 0; i < o.getChildrenCount(); i++) {
          kids.push(o.getChild(i));
        }
        for (const k of kids) {
          if (k === headPivot || k === liftPivot) {
            continue;
          }
          if (isHead(k.name)) {
            k.setParentPreserveWorldTransform(headPivot);
          } else if (isFork(k.name)) {
            k.setParentPreserveWorldTransform(carriagePivot);
          } else if (isLift(k.name)) {
            k.setParentPreserveWorldTransform(liftPivot);
          } else {
            gather(k);
          }
        }
      };
      gather(model);
      this.headPivotObj = headPivot;
      this.liftPivotObj = liftPivot;
      this.carriagePivotObj = carriagePivot;
      modelOk = true;
      log.i("vector.obj instantiated as occluder");
    }
    if (!modelOk) {
      const occ = this.buildOccluder(avatarRoot);
      occ.name = "Occluder";
    }
    // digital "hit zone" under the robot — robot-FOOTPRINT shaped
    // (rounded-rect plate ~ body 100x60mm with a glow margin), rotates
    // with him since it's a child of avatarRoot
    // square-based contour zone: glow outline + low light walls around
    // the robot footprint (centered on the body, slight back offset —
    // the obj pivot sits at the nose axis)
    const zc = global.scene.createSceneObject("HitZone");
    zc.setParent(avatarRoot);
    zc.getTransform().setLocalPosition(
      new vec3(-0.8 - this.axleOffsetMm / 10, 0, 0)); // ride with the model
    zc.getTransform().setLocalScale(new vec3(1.45, 1, 1.45));
    // soft frame-gradient pool under the robot (like the scene ambience,
    // green) — replaces the old hard outline
    const zw = 4.6, zl = 3.1;
    g.flatQuad(zc, "hzFrame", zw * 2.6, zl * 2.6, "green", "pool", 0.045); // rounded
    this.animRings.push(zc);
    // block-burst: taller wall rect flashed on puck contact (perimeter VFX)
    const bb = global.scene.createSceneObject("BlockBurst");
    bb.setParent(avatarRoot);
    bb.getTransform().setLocalPosition(new vec3(-0.8, 0, 0));
    // curtain follows the SAME rounded-rect as the pool texture band
    const bh = 6.5;
    const rw = 3.7, rl = 2.5, rr = 1.3; // half-extents + corner radius
    const loop: vec2[] = [];
    const corners: [number, number, number][] = [
      [rw - rr, rl - rr, 0], [-(rw - rr), rl - rr, Math.PI / 2],
      [-(rw - rr), -(rl - rr), Math.PI], [rw - rr, -(rl - rr), Math.PI * 1.5],
    ];
    for (const [ccx, ccz, a0] of corners) {
      for (let k = 0; k <= 4; k++) {
        const a = a0 + (k / 4) * (Math.PI / 2);
        loop.push(new vec2(ccx + Math.cos(a) * rr, ccz + Math.sin(a) * rr));
      }
    }
    g.wallLoop(bb, "bbLoop", loop, bh, "greenDim");
    bb.enabled = false;

    log.i("Field v2 built (circuit world)");
    return { fieldRoot, puckObj, paddleObj, avatarRoot, padObj,
             blockBurstObj: bb, rimObj: this.rimObj,
             rimMat: this.rimMatPrepared, dustMat: null,
             paddleGlowObj: paddleGlow,
             headPivotObj: this.headPivotObj,
             liftPivotObj: this.liftPivotObj,
             carriagePivotObj: this.carriagePivotObj,
             cubePadObj: this.cubePadObj };
  }

  /** Manhattan PCB traces with via dots, deterministic layout. */
  private buildTraces(root: SceneObject, hl: number, hw: number) {
    const g = this.glow;
    const traces = global.scene.createSceneObject("Traces");
    traces.setParent(root);
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const w = TRACE_W;
    const y = 0.02;
    // REAL-PCB rule: traces NEVER cross (acid-etched, single layer).
    // Each trace is confined to its own vertical strip and advances
    // monotonically inward -> crossings are impossible by construction.
    const STRIPS = 12;
    const stripW = (2 * hl - 4) / STRIPS;
    const stripSegs: { x1: number; z1: number; x2: number; z2: number }[] = [];
    const stripVias: { x: number; z: number }[] = [];
    for (let i = 0; i < STRIPS; i++) {
      const sx0 = -hl + 2 + i * stripW + 0.5;
      const sx1 = sx0 + stripW - 1.0;
      const fromTop = i % 2 === 0;
      let x = sx0 + rnd() * (sx1 - sx0);
      let z = (fromTop ? 1 : -1) * (hw - 1.2);
      const dirIn = fromTop ? -1 : 1;
      const pts: vec3[] = [new vec3(x, y, z)];
      stripVias.push({ x, z });
      const segs = 3 + Math.floor(rnd() * 2);
      for (let sgi = 0; sgi < segs; sgi++) {
        if (sgi % 2 === 0) {
          // advance inward (monotone in z — no self-crossing)
          const nz = z + dirIn * (1.6 + rnd() * 3.2);
          const zc = fromTop ? Math.max(nz, 1.0) : Math.min(nz, -1.0);
          stripSegs.push({ x1: x, z1: z, x2: x, z2: zc });
          z = zc;
        } else {
          // jog sideways, clamped INSIDE the strip
          const nx = Math.max(sx0, Math.min(sx1, x + (rnd() - 0.5) * stripW));
          stripSegs.push({ x1: x, z1: z, x2: nx, z2: z });
          x = nx;
        }
        pts.push(new vec3(x, y, z));
      }
      stripVias.push({ x, z });
      let plen = 0;
      for (let k = 0; k < pts.length - 1; k++) {
        plen += pts[k].distance(pts[k + 1]);
      }
      if (plen > 2) {
        this.tracePaths.push({ points: pts, length: plen });
      }
    }
    g.batchedLines(traces, "StripLines", stripSegs, w, "greenDim", y);
    g.batchedDiscs(traces, "StripVias", stripVias, 0.9, "greenDim", y + 0.005);
  }


  /** REAL-PCB generative router: walkers start at COMPONENT CONTACTS, walk
   * a 1cm occupancy grid (occupied cells are impassable -> traces can never
   * cross), and terminate with a via. Every trace starts somewhere real and
   * ends somewhere real. */
  private buildCircuitNet(parent: SceneObject, hl: number, hw: number,
                          contacts: { x: number; z: number;
                                      dx: number; dz: number }[]) {
    const g = this.glow;
    const CELL = 1.0;
    const X0 = -hl - 12, X1 = hl + 12, Z0 = -hw - 14, Z1 = hw + 14;
    const NX = Math.ceil((X1 - X0) / CELL);
    const NZ = Math.ceil((Z1 - Z0) / CELL);
    const occ: boolean[] = new Array(NX * NZ);
    const idx = (cx: number, cz: number) => cz * NX + cx;
    const toCx = (x: number) => Math.round((x - X0) / CELL);
    const toCz = (z: number) => Math.round((z - Z0) / CELL);
    let seed = 1234;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    // block component footprints (tubes frame ±hl/±hw handled by bounds pull-in)
    const block = (x: number, z: number, r: number) => {
      for (let cx = toCx(x - r); cx <= toCx(x + r); cx++) {
        for (let cz = toCz(z - r); cz <= toCz(z + r); cz++) {
          if (cx >= 0 && cx < NX && cz >= 0 && cz < NZ) {
            occ[idx(cx, cz)] = true;
          }
        }
      }
    };
    for (const c of contacts) {
      block(c.x - c.dx * 2, c.z - c.dz * 2, 1.2); // the component body side
    }
    // PERF: the whole static net renders as TWO meshes (lines + vias)
    const netSegs: { x1: number; z1: number; x2: number; z2: number }[] = [];
    const netVias: { x: number; z: number }[] = [];
    for (const c of contacts) {
      // snap the walker start to the grid, but connect the REAL contact to
      // it with axis-aligned stubs (no diagonals — acid doesn't do curves)
      let cx = toCx(c.x), cz = toCz(c.z);
      const sxp = X0 + cx * CELL, szp = Z0 + cz * CELL;
      if (Math.abs(sxp - c.x) > 0.03) {
        netSegs.push({ x1: c.x, z1: c.z, x2: sxp, z2: c.z });
      }
      if (Math.abs(szp - c.z) > 0.03) {
        netSegs.push({ x1: sxp, z1: c.z, x2: sxp, z2: szp });
      }
      let dx = Math.sign(c.dx), dz = Math.sign(c.dz);
      const pts: vec3[] = [new vec3(sxp, 0.02, szp)];
      let px = sxp, pz2 = szp;
      let steps = 8 + Math.floor(rnd() * 16);
      let runX = px, runZ = pz2;
      while (steps-- > 0) {
        // prefer straight; sometimes turn 90
        let ndx = dx, ndz = dz;
        if (rnd() < 0.3) {
          if (dx !== 0) { ndx = 0; ndz = rnd() < 0.5 ? 1 : -1; }
          else { ndz = 0; ndx = rnd() < 0.5 ? 1 : -1; }
        }
        const tx = cx + ndx, tz = cz + ndz;
        const nx2 = X0 + tx * CELL, nz2 = Z0 + tz * CELL;
        const inBounds = tx > 0 && tx < NX - 1 && tz > 0 && tz < NZ - 1;
        if (!inBounds || occ[idx(tx, tz)]) {
          // blocked: try the other turn once, else stop
          const adx = ndz !== 0 ? 0 : ndx, adz = ndz !== 0 ? -ndz : 0;
          const ax = cx + adx, az = cz + adz;
          if (ax > 0 && ax < NX - 1 && az > 0 && az < NZ - 1 && !occ[idx(ax, az)]) {
            ndx = adx; ndz = adz;
          } else {
            break;
          }
        }
        // direction change -> flush the straight run into one line
        if (ndx !== dx || ndz !== dz) {
          if (runX !== px || runZ !== pz2) {
            netSegs.push({ x1: runX, z1: runZ, x2: px, z2: pz2 });
            pts.push(new vec3(px, 0.02, pz2));
          }
          runX = px; runZ = pz2;
          dx = ndx; dz = ndz;
        }
        cx += ndx; cz += ndz;
        px = X0 + cx * CELL; pz2 = Z0 + cz * CELL;
        occ[idx(cx, cz)] = true;
      }
      if (runX !== px || runZ !== pz2) {
        netSegs.push({ x1: runX, z1: runZ, x2: px, z2: pz2 });
        pts.push(new vec3(px, 0.02, pz2));
      }
      // terminate with a via — the trace ENDS somewhere real
      netVias.push({ x: px, z: pz2 });
      let plen = 0;
      for (let k = 0; k < pts.length - 1; k++) {
        plen += pts[k].distance(pts[k + 1]);
      }
      if (plen > 2 && pts.length > 1) {
        this.tracePaths.push({ points: pts, length: plen });
      }
    }
    g.batchedLines(parent, "NetLines", netSegs, TRACE_W, "greenDim", 0.02);
    g.batchedDiscs(parent, "NetVias", netVias, 0.9, "greenDim", 0.025);
  }

  /** Clean deco: only GLB capacitors near the four corners (concept look —
   * no resistor/chip scatter noise). */
  private buildComponents(root: SceneObject, hl: number, hw: number) {
    const deco = global.scene.createSceneObject("Decorations");
    deco.setParent(root);
    const spots: [number, number, "green" | "pink"][] = [
      [-hl + 3, hw + 5, "pink"],
      [hl - 3, hw + 5.5, "green"],
      [-hl + 4, -hw - 5.5, "green"],
      [hl - 4, -hw - 5, "pink"],
    ];
    let n = 0;
    const contacts: { x: number; z: number; dx: number; dz: number }[] = [];
    for (const [x, z, c] of spots) {
      const neon = c === "green" ? this.matNeonGreen : this.matNeonPink;
      const capHolder = global.scene.createSceneObject("CapGroup" + n);
      capHolder.setParent(deco);
      this.placeCapacitor(capHolder, "Cap" + n, x, z, neon,
        c === "green" ? "pink" : "green");
      this.intro.add(capHolder, 1.2 + n * 0.15, "drop", 0.55);
      // both metal legs are circuit contacts
      const away = z > 0 ? 1 : -1;
      contacts.push({ x: x - 0.63, z, dx: 0, dz: away });
      contacts.push({ x: x + 0.63, z, dx: 0, dz: -away });
      n++;
    }
    const resSpots: [number, number, "green" | "pink", number][] = [
      [-hl * 0.42, hw + 3.2, "green", 0],
      [hl * 0.42, hw + 3.2, "pink", 0],
      [-hl * 0.42, -hw - 3.2, "pink", 0],
      [hl * 0.42, -hw - 3.2, "green", 0],
    ];
    for (const [rx, rz, rc, rrot] of resSpots) {
      const rGroup = global.scene.createSceneObject("ResGroup" + n);
      rGroup.setParent(deco);
      const tips = this.placeResistor3D(rGroup, "Res" + n, rx, rz, rrot, rc);
      this.intro.add(rGroup, 1.8 + (n % 4) * 0.12, "drop", 0.55);
      if (tips !== null) {
        contacts.push({ x: tips.tipA.x, z: tips.tipA.y, dx: -1, dz: 0 });
        contacts.push({ x: tips.tipB.x, z: tips.tipB.y, dx: 1, dz: 0 });
      }
      n++;
    }
    // LED chip pins (7 per side, rows at x = ±2.2 after the 90° yaw)
    const pinChipZ = -(hw + 7);
    for (let pi = 0; pi < 7; pi++) {
      const pz = pinChipZ + (-3.3 + pi * 1.1);
      contacts.push({ x: -2.2, z: pz, dx: -1, dz: 0 });
      contacts.push({ x: 2.2, z: pz, dx: 1, dz: 0 });
    }
    // START button pads
    contacts.push({ x: -1.8, z: 16.5, dx: -1, dz: 0 });
    contacts.push({ x: 1.8, z: 16.5, dx: 1, dz: 0 });
    // ONE connected acid-etched net for the whole circuit
    this.buildCircuitNet(deco, hl, hw, contacts);
  }

  /** REAL-PCB generative router: walkers start at COMPONENT CONTACTS, walk
   * a 1cm occupancy grid (occupied cells are impassable -> traces can never
   * cross), and terminate with a via. Every trace starts somewhere real and
   * ends somewhere real. */

  /** Clean deco: only GLB capacitors near the four corners (concept look —
   * no resistor/chip scatter noise). */

  /** Outside-the-field feeder trace: L-shaped dim line + via dots, recorded
   * for the DecoAnimator energy pulses. */
  private outerTrace(parent: SceneObject, name: string,
                     x0: number, z0: number, x1: number, z1: number): SceneObject {
    const holder = global.scene.createSceneObject(name);
    holder.setParent(parent);
    parent = holder;
    const g = this.glow;
    const y = 0.02;
    // real-PCB 45° routing: straight run, then a mitered diagonal into the pad
    const dxT = x1 - x0;
    const dzT = z1 - z0;
    const diag = Math.min(Math.abs(dxT), Math.abs(dzT) * 0.5);
    const midZ = z1 - Math.sign(dzT || 1) * Math.max(0.8, diag);
    const bendX = x0;
    g.line(parent, name + "s1", x0, z0, bendX, midZ, TRACE_W, "greenDim", y);
    g.line(parent, name + "s2", bendX, midZ, x1, z1, TRACE_W, "greenDim", y);
    const viaA = g.flatQuad(parent, name + "va", 0.9, 0.9, "greenDim", "disc", y);
    viaA.getTransform().setLocalPosition(new vec3(x0, 0, z0));
    const viaB = g.flatQuad(parent, name + "vb", 0.9, 0.9, "greenDim", "disc", y);
    viaB.getTransform().setLocalPosition(new vec3(x1, 0, z1));
    const pts = [
      new vec3(x0, y, z0), new vec3(bendX, y, midZ), new vec3(x1, y, z1),
    ];
    let plen = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      plen += pts[k].distance(pts[k + 1]);
    }
    this.tracePaths.push({ points: pts, length: plen });
    return holder;
  }

  /** Capacitor: circle of light-wall segments + glowing top ring + base pad. */
  private capacitor(parent: SceneObject, name: string, x: number, z: number,
                    r: number, h: number, color: "green" | "pink") {
    const g = this.glow;
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    obj.getTransform().setLocalPosition(new vec3(x, 0, z));
    const segs = 8;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 0.7) / segs) * Math.PI * 2;
      const wallSeg = g.wall(obj, name + "w" + i,
        -r * 0.38, r * 0.38, 0, h, color);
      const mid = (a0 + a1) / 2;
      const tr = wallSeg.getTransform();
      tr.setLocalPosition(new vec3(Math.cos(mid) * r, 0, Math.sin(mid) * r));
      tr.setLocalRotation(quat.angleAxis(-mid + Math.PI / 2, vec3.up()));
    }
    const top = g.flatQuad(obj, name + "top", r * 3.4, r * 3.4, color, "ring", h);
    const base = g.flatQuad(obj, name + "base", r * 3.8, r * 3.8, color, "disc", 0.03);
    this.animRings.push(top);
    // TESLA ARCS — electric energy orbiting the capacitor (concept-approved)
    const other = color === "green" ? "pink" : "green";
    for (let k = 0; k < 2; k++) {
      const arc = g.electricArc(obj, name + "arc" + k, r * 1.5,
        Math.PI * (0.6 + Math.random() * 0.5), 7, other as any,
        h * 0.25 + k * h * 0.35, h * 0.55 + k * h * 0.35,
        17 + k * 31 + Math.floor(Math.random() * 100));
      this.arcs.push(arc);
    }
  }

  /** Resistor: body line + colored stripes + two leg traces. */
  private resistor(parent: SceneObject, name: string, x: number, z: number,
                   color: "green" | "pink", rot: number) {
    const g = this.glow;
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    obj.getTransform().setLocalPosition(new vec3(x, 0, z));
    obj.getTransform().setLocalRotation(quat.angleAxis(rot, vec3.up()));
    g.line(obj, name + "body", -2.2, 0, 2.2, 0, 1.6, color, 0.25);
    const other = color === "green" ? "pink" : "green";
    for (let i = -1; i <= 1; i++) {
      g.line(obj, name + "stripe" + i, i * 1.1, -0.9, i * 1.1, 0.9, 0.35,
             other as any, 0.3);
    }
    g.line(obj, name + "legA", -4.2, 0, -2.2, 0, 0.3, color, 0.03);
    g.line(obj, name + "legB", 2.2, 0, 4.2, 0, 0.3, color, 0.03);
  }

  /** Chip: square plate + pin stubs on two sides. */
  private chip(parent: SceneObject, name: string, x: number, z: number,
               color: "green" | "pink") {
    const g = this.glow;
    const obj = global.scene.createSceneObject(name);
    obj.setParent(parent);
    obj.getTransform().setLocalPosition(new vec3(x, 0, z));
    const plate = g.flatQuad(obj, name + "plate", 4.6, 4.6, color, "plate", 0.22);
    this.blinkers.push(plate);
    const other = color === "green" ? "pink" : "green";
    for (let i = 0; i < 4; i++) {
      const p = -1.5 + i;
      g.line(obj, name + "pinA" + i, p, -2.2, p, -3.2, 0.28, other as any, 0.05);
      g.line(obj, name + "pinB" + i, p, 2.2, p, 3.2, 0.28, other as any, 0.05);
    }
  }

  private buildOccluder(parent: SceneObject): SceneObject {
    const obj = global.scene.createSceneObject("OccluderBox");
    obj.setParent(parent);
    const b = new MeshBuilder([{ name: "position", components: 3 }]);
    b.topology = MeshTopology.Triangles;
    b.indexType = MeshIndexType.UInt16;
    let vc = 0;
    const box = (x1: number, y1: number, z1: number,
                 x2: number, y2: number, z2: number) => {
      const quads = [
        [[x1,y1,z1],[x1,y2,z1],[x2,y2,z1],[x2,y1,z1]],
        [[x2,y1,z2],[x2,y2,z2],[x1,y2,z2],[x1,y1,z2]],
        [[x1,y1,z2],[x1,y2,z2],[x1,y2,z1],[x1,y1,z1]],
        [[x2,y1,z1],[x2,y2,z1],[x2,y2,z2],[x2,y1,z2]],
        [[x1,y2,z1],[x1,y2,z2],[x2,y2,z2],[x2,y2,z1]],
        [[x1,y1,z2],[x1,y1,z1],[x2,y1,z1],[x2,y1,z2]],
      ];
      for (const q of quads) {
        b.appendVerticesInterleaved([
          ...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]]);
        b.appendIndices([vc, vc+1, vc+2, vc+3, vc+4, vc+5]);
        vc += 6;
      }
    };
    box(-5, 0, -3, 5, 5, 3);       // body
    box(1.5, 3.2, -2.75, 6.0, 6.7, 2.75); // head
    b.updateMesh();
    const rmv = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    rmv.mesh = b.getMesh();
    rmv.mainMaterial = this.matOccluder;
    return obj;
  }
}
