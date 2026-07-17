/**
 * VFXBursts v2 – GlowKit-based effects:
 * - goal: triple staggered shockwave rings + radial spark burst + floor flash
 * - block: ring + sparks at Vector's body
 * - puck trail: fading glow ghosts
 * - motion sparks: emitted behind the (real or digital) Vector as he drives
 */
import { FieldMath } from "./FieldMath";
import { GlowKit } from "./GlowKit";
import { GameConfig } from "./GameConfig";

interface Anim {
  obj: SceneObject;
  t: number;
  dur: number;
  s0: number;
  s1: number;
  vx: number; // local drift per second (sparks)
  vz: number;
  active: boolean;
}

export class VFXBursts {
  private rings: Anim[] = [];
  private sparks: Anim[] = [];
  private flashes: Anim[] = [];
  private trail: Anim[] = [];
  private columns: Anim[] = [];
  private bolts: { obj: SceneObject; t: number; active: boolean }[] = [];
  private strikes: { obj: SceneObject; t: number }[] = [];
  private pendingStrikes: { x: number; y: number; capIdx: number; delay: number }[] = [];
  private glowRef: GlowKit;
  private trailAccum = 0;
  private motionAccum = 0;
  private edgeAccum = 0;

  constructor(
    private fieldMath: FieldMath,
    private fieldRoot: SceneObject,
    glow: GlowKit
  ) {
    this.glowRef = glow;
    const pool = global.scene.createSceneObject("VFXPool");
    pool.setParent(fieldRoot);
    for (let i = 0; i < 6; i++) {
      const color = i % 2 === 0 ? "pink" : "pinkDim"; // soft pink shockwaves
      const obj = glow.flatQuad(pool, "Ring" + i, 3, 3, color as any, "ring", 0.32);
      obj.enabled = false;
      this.rings.push(this.newAnim(obj));
    }
    for (let i = 0; i < 28; i++) {
      const color = i % 2 === 0 ? "pink" : "green";
      const obj = glow.flatQuad(pool, "Spark" + i, 1.1, 1.1, color as any, "spark", 0.4);
      obj.enabled = false;
      this.sparks.push(this.newAnim(obj));
    }
    for (let i = 0; i < 2; i++) {
      const obj = glow.flatQuad(pool, "Flash" + i, 10, 10,
        i === 0 ? "pink" : "green", "disc", 0.1);
      obj.enabled = false;
      this.flashes.push(this.newAnim(obj));
    }
    for (let i = 0; i < 12; i++) {
      const obj = glow.flatQuad(pool, "Trail" + i, 2.4, 2.4, "pink", "disc", 0.25);
      obj.enabled = false;
      this.trail.push(this.newAnim(obj));
    }
    // lightning bolts for neon-tube contact (like the capacitor tesla arcs)
    for (let i = 0; i < 4; i++) {
      const color = i % 2 === 0 ? "green" : "pink";
      const obj = glow.electricArc(pool, "Bolt" + i, 2.0,
        Math.PI * 0.9, 10, color as any, 0.3, 2.2, 57 + i * 31);
      obj.enabled = false;
      this.bolts.push({ obj, t: 0, active: false });
    }

    // VERTICAL light columns — the volumetric layer (user: "3D spatial scene")
    for (let i = 0; i < 6; i++) {
      const color = i % 2 === 0 ? "green" : "pink";
      const obj = glow.cylinderGlow(pool, "Column" + i, 1.5, 6.0, color as any);
      obj.enabled = false;
      this.columns.push(this.newAnim(obj));
    }
  }

  /** Vertical energy burst shooting UP from an impact point, with a soft
   * gradient glow circle underlay on the floor. */
  verticalBurst(xMm: number, yMm: number, pinkSide: boolean, power: number = 1) {
    // floor underlay pad + HOT bright core in the middle
    const fl = this.flashes[pinkSide ? 0 : 1];
    this.fire(fl, xMm, yMm, 0.4, 1.1 * power, 0.2);
    const core = this.flashes[pinkSide ? 1 : 0];
    this.fire(core, xMm, yMm, 0.25, 0.45 * power, 0.35);
    // impact sparks: MORE of them, stretched along their velocity
    for (let i = 0; i < 11; i++) {
      const sp = this.grab(this.sparks, pinkSide ? 0 : 1, i * 2);
      const ang = Math.random() * Math.PI * 2;
      const sp2 = 14 + Math.random() * 14;
      this.fire(sp, xMm, yMm, 0.32, 0.85, 0.12,
        Math.cos(ang) * sp2, Math.sin(ang) * sp2);
    }
    const free = this.columns.filter(
      (a, i) => !a.active && (i % 2 === (pinkSide ? 1 : 0)));
    const c = free.length > 0 ? free[0] : this.columns[pinkSide ? 1 : 0];
    c.obj.getTransform().setLocalPosition(
      this.fieldMath.fieldToLocal(xMm, yMm, 0));
    c.obj.getTransform().setLocalScale(new vec3(0.4 * power, 0.15, 0.4 * power));
    c.t = 0;
    c.dur = 0.45;
    c.s0 = 0.15;
    c.s1 = power;      // y-scale target (column shoots up)
    c.vx = -1;         // marker: this anim scales VERTICALLY (see tick)
    c.vz = 0.4 * power; // radial scale, kept constant while rising
    c.active = true;
    c.obj.enabled = true;
  }

  // EXACT capacitor coil positions (FieldBuilder spots, field mm)
  private static CAPS: [number, number][] = [
    [-170, -150], [170, -155], [-160, 155], [160, 150],
  ];

  /** LONG bolts from capacitors striking a point. count=2 (nearest, goals)
   * or 4 (ALL caps, puck summon) with tiny random per-bolt stagger. */
  capacitorStrike(xMm: number, yMm: number, count: number = 2,
                  maxStagger: number = 0.12) {
    const caps = VFXBursts.CAPS.slice();
    caps.sort((a, b) =>
      (Math.abs(a[0] - xMm) + Math.abs(a[1] - yMm)) -
      (Math.abs(b[0] - xMm) + Math.abs(b[1] - yMm)));
    for (let n = 0; n < Math.min(count, caps.length); n++) {
      this.pendingStrikes.push({
        x: xMm, y: yMm,
        capIdx: VFXBursts.CAPS.indexOf(caps[n]),
        delay: n === 0 ? 0 : Math.random() * maxStagger,
      });
    }
    for (const fl of this.flashes) {
      this.fire(fl, xMm, yMm, 0.45, 1.8, 0.25);
    }
  }

  private spawnStrike(xMm: number, yMm: number, capIdx: number) {
    const cap = VFXBursts.CAPS[capIdx];
    // straight FROM the capacitor coil top (5.5 cm up), tight first jag
    const from = this.fieldMath.fieldToLocal(cap[0], cap[1], 5.5);
    const to = this.fieldMath.fieldToLocal(xMm, yMm, 0.4);
    const pts: vec3[] = [from];
    const SEGS = 9;
    for (let i = 1; i < SEGS; i++) {
      const k = i / SEGS;
      const j = Math.sin(k * Math.PI); // no jitter at the endpoints
      pts.push(new vec3(
        from.x + (to.x - from.x) * k + (Math.random() - 0.5) * 2.4 * j,
        from.y + (to.y - from.y) * k + (Math.random() - 0.5) * 1.8 * j,
        from.z + (to.z - from.z) * k + (Math.random() - 0.5) * 2.4 * j));
    }
    pts.push(to);
    const bolt = this.glowRef.boltRibbon(this.fieldRoot,
      "Strike" + capIdx, pts, 0.55, capIdx % 2 === 0 ? "green" : "pink");
    this.strikes.push({ obj: bolt, t: 0 });
  }

  /** Lightning crawling OVER the physical robot: arcs across his body
   * at his live pose — sells the AR overlay knowing his real volume. */
  robotStorm(xMm: number, yMm: number, bolts: number = 6) {
    for (let n = 0; n < bolts; n++) {
      const a = Math.random() * Math.PI * 2;
      const b = a + Math.PI * (0.7 + Math.random() * 0.6); // opposite-ish
      const r1 = 40 + Math.random() * 45;
      const r2 = 40 + Math.random() * 45;
      // varied endpoint heights: some hug the table, some snap mid-air —
      // no uniform "landing line" where every bolt used to end
      const h1 = Math.random() < 0.5 ? 0.4 + Math.random() * 2
        : 2.5 + Math.random() * 5.5;
      const h2 = Math.random() < 0.5 ? 0.4 + Math.random() * 2
        : 2.5 + Math.random() * 5.5;
      const from = this.fieldMath.fieldToLocal(
        xMm + Math.cos(a) * r1, yMm + Math.sin(a) * r1, h1);
      const to = this.fieldMath.fieldToLocal(
        xMm + Math.cos(b) * r2, yMm + Math.sin(b) * r2, h2);
      const topH = 4.5 + Math.random() * 7; // arc height varies wildly too
      const pts: vec3[] = [from];
      const SEGS = 8;
      for (let i = 1; i < SEGS; i++) {
        const k = i / SEGS;
        const lift = Math.sin(k * Math.PI) * topH;
        const j = Math.sin(k * Math.PI);
        pts.push(new vec3(
          from.x + (to.x - from.x) * k + (Math.random() - 0.5) * 2.0 * j,
          from.y + (to.y - from.y) * k + lift,
          from.z + (to.z - from.z) * k + (Math.random() - 0.5) * 2.0 * j));
      }
      pts.push(to);
      const bolt = this.glowRef.boltRibbon(this.fieldRoot,
        "RoboStorm" + n, pts, 0.42, "pink");
      this.strikes.push({ obj: bolt, t: -Math.random() * 0.15 });
    }
  }

  /** Hard cleanup — call on round/game resets so no bolt survives. */
  clearStrikes() {
    for (const st of this.strikes) {
      st.obj.destroy();
    }
    this.strikes = [];
    this.pendingStrikes = [];
  }

  /** Lightning at the neon tube contact point — tesla-style arcs. */
  wallLightning(xMm: number, yMm: number) {
    for (let n = 0; n < 2; n++) {
      const b = this.bolts.find((e) => !e.active) || this.bolts[n];
      b.obj.getTransform().setLocalPosition(
        this.fieldMath.fieldToLocal(xMm, yMm, 0.2));
      b.obj.getTransform().setLocalRotation(
        quat.angleAxis(Math.random() * Math.PI * 2, vec3.up()));
      b.t = 0;
      b.active = true;
      b.obj.enabled = true;
    }
  }

  /** Overexposed goal absorption: the tube "swallows" the puck — blinding
   * stack of flashes + columns at the crossing point. */
  goalAbsorb(xMm: number, yMm: number, vectorSide: boolean) {
    void vectorSide; // the puck's death is ALWAYS pink (its own color)
    // concentric columns at ONE center — diameters match the floor rings
    this.verticalBurst(xMm, yMm, true, 1.6);   // slim hot core
    this.nestedColumn(xMm, yMm, 1.0, 1.2);     // mid ring column
    this.nestedColumn(xMm, yMm, 1.6, 0.9);     // wide outer column
    // stacked flashes = overexposure
    for (const fl of this.flashes) {
      this.fire(fl, xMm, yMm, 0.5, 2.2, 0.3);
    }
    this.goalBurst(xMm, yMm, false); // pink parity rings
  }

  /** Extra column at the same point with an explicit radial scale —
   * used to build concentric ring-matched columns. */
  private nestedColumn(xMm: number, yMm: number, radial: number, h: number) {
    const free = this.columns.find((a) => !a.active);
    const c = free || this.columns[0];
    c.obj.getTransform().setLocalPosition(
      this.fieldMath.fieldToLocal(xMm, yMm, 0));
    c.t = 0;
    c.dur = 0.5;
    c.s0 = 0.12;
    c.s1 = h;
    c.vx = -1;
    c.vz = radial;
    c.active = true;
    c.obj.enabled = true;
  }

  /** Edge hit: paddle slammed the field boundary — sparks + hot point. */
  edgeSparks(xMm: number, yMm: number, dt: number) {
    this.edgeAccum += dt;
    if (this.edgeAccum < 0.18) {
      return;
    }
    this.edgeAccum = 0;
    for (let i = 0; i < 6; i++) {
      const sp = this.grab(this.sparks, 0, i * 3);
      const ang = Math.random() * Math.PI * 2;
      this.fire(sp, xMm, yMm, 0.35, 0.8, 0.12,
        Math.cos(ang) * 14, Math.sin(ang) * 14);
    }
    const fl = this.flashes[0];
    this.fire(fl, xMm, yMm, 0.22, 0.9, 0.25);
  }

  private newAnim(obj: SceneObject): Anim {
    return { obj, t: 0, dur: 1, s0: 1, s1: 1, vx: 0, vz: 0, active: false };
  }

  goalBurst(xMm: number, yMm: number, vectorSide: boolean) {
    // three staggered rings
    for (let i = 0; i < 3; i++) {
      const ring = this.grab(this.rings, vectorSide ? 0 : 1, i);
      this.fire(ring, xMm, yMm, 0.55 + i * 0.18, 0.6 + i * 0.4, 9 + i * 5);
    }
    // radial sparks
    for (let i = 0; i < 16; i++) {
      const sp = this.grab(this.sparks, 0, i);
      const ang = (i / 16) * Math.PI * 2;
      this.fire(sp, xMm, yMm, 0.55, 1.0, 0.15,
        Math.cos(ang) * 22, Math.sin(ang) * 22);
    }
    // floor flash
    const fl = this.flashes[vectorSide ? 0 : 1];
    this.fire(fl, xMm, yMm, 0.4, 1.6, 0.15);
  }

  blockFlash(xMm: number, yMm: number) {
    const ring = this.grab(this.rings, 1, 0);
    this.fire(ring, xMm, yMm, 0.35, 0.7, 5);
    for (let i = 0; i < 5; i++) {
      const sp = this.grab(this.sparks, 1, i);
      const ang = Math.PI + (i - 2) * 0.5; // spray toward player side
      this.fire(sp, xMm, yMm, 0.4, 0.9, 0.12,
        Math.cos(ang) * 18, Math.sin(ang) * 18);
    }
  }

  /** Tread skid RIBBON: one dynamic MeshBuilder mesh for BOTH treads —
   * a single draw call instead of a 44-object quad pool. Width tapers
   * with age, so the line melts away behind the robot. */
  private treadPts: { x: number; y: number; t: number }[][] = [[], []];
  private treadRmv: RenderMeshVisual | null = null;
  private treadLastX = 1e9;
  private treadLastY = 1e9;
  private static TREAD_LIFE = 1.5;

  prewarmTreads() {
    if (!this.treadRmv) {
      this.treadRmv = this.glowRef.emptyVisual(
        this.fieldRoot, "TreadRibbon", "green", "strip");
      this.treadRmv.enabled = false;
    }
  }

  treadTrail(dt: number, xMm: number, yMm: number, degHeading: number,
             speedMmS: number) {
    this.prewarmTreads();
    // age-out old points
    let dirty = false;
    for (const pts of this.treadPts) {
      for (const p of pts) {
        p.t += dt;
      }
      while (pts.length > 0 && pts[0].t > VFXBursts.TREAD_LIFE) {
        pts.shift();
        dirty = true;
      }
    }
    const jump = Math.hypot(xMm - this.treadLastX, yMm - this.treadLastY);
    if (Math.abs(speedMmS) > 420 || jump > 60) {
      // teleport (post placement / delocalize) — cut the ribbon
      this.treadPts[0].length = 0;
      this.treadPts[1].length = 0;
      this.treadLastX = xMm;
      this.treadLastY = yMm;
      this.rebuildTreads();
      return;
    }
    if (Math.abs(speedMmS) >= 35 && jump >= 8) {
      this.treadLastX = xMm;
      this.treadLastY = yMm;
      const rad = (degHeading * Math.PI) / 180;
      const ox = -Math.sin(rad) * 24;
      const oy = Math.cos(rad) * 24;
      for (let s = 0; s < 2; s++) {
        const sg = s === 0 ? -1 : 1;
        const pts = this.treadPts[s];
        pts.push({ x: xMm + ox * sg, y: yMm + oy * sg, t: 0 });
        if (pts.length > 34) {
          pts.shift();
        }
      }
      dirty = true;
    }
    if (dirty || this.treadPts[0].length > 0 || this.treadPts[1].length > 0) {
      this.rebuildTreads(); // width tapers with age -> refresh each frame
    }
  }

  private rebuildTreads() {
    if (!this.treadRmv) {
      return;
    }
    const b = this.glowRef.dynBuilder();
    const verts: number[] = [];
    const idx: number[] = [];
    let vi = 0;
    for (const pts of this.treadPts) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i], q = pts[i + 1];
        const px = p.x / 10, pz = -p.y / 10;
        const qx = q.x / 10, qz = -q.y / 10;
        let dx = qx - px, dz = qz - pz;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 1e-4) {
          continue;
        }
        dx /= len; dz /= len;
        const nx = -dz, nz = dx;
        const wp = 0.3 * Math.max(0, 1 - p.t / VFXBursts.TREAD_LIFE);
        const wq = 0.3 * Math.max(0, 1 - q.t / VFXBursts.TREAD_LIFE);
        const y = 0.12;
        verts.push(
          px + nx * wp, y, pz + nz * wp, 0, 0,
          px - nx * wp, y, pz - nz * wp, 1, 0,
          qx + nx * wq, y, qz + nz * wq, 0, 1,
          qx - nx * wq, y, qz - nz * wq, 1, 1);
        idx.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
        vi += 4;
      }
    }
    if (vi === 0) {
      this.treadRmv.enabled = false;
      return;
    }
    b.appendVerticesInterleaved(verts);
    b.appendIndices(idx);
    b.updateMesh();
    this.treadRmv.mesh = b.getMesh();
    this.treadRmv.enabled = true;
  }

  private debris: { obj: SceneObject; t: number; life: number;
    x: number; y: number; h: number; vx: number; vy: number;
    vh: number }[] = [];

  motionSparks(dt: number, xMm: number, yMm: number, speedMmS: number) {
    // age existing debris every frame: ballistic arc + shrink fade
    for (const d of this.debris) {
      if (d.t < 0) { continue; }
      d.t += dt;
      if (d.t >= d.life) {
        d.t = -1;
        d.obj.enabled = false;
        continue;
      }
      d.vh -= 26 * dt; // gravity, desk-scale feel
      d.h += d.vh * dt;
      if (d.h < 0.2) { d.h = 0.2; d.vh = 0; }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      const k = 1 - d.t / d.life;
      d.obj.getTransform().setLocalPosition(
        this.fieldMath.fieldToLocal(d.x, d.y, d.h));
      d.obj.getTransform().setLocalScale(new vec3(0.28 * k, 1, 0.28 * k));
    }
    this.motionAccum += dt;
    if (Math.abs(speedMmS) < 40 || Math.abs(speedMmS) > 420
        || this.motionAccum < 0.065) {
      return;
    }
    this.motionAccum = 0;
    // tank-style: particles kicked out from UNDER BOTH TREADS, flying up
    // and sideways like real track debris
    for (const side of [-1, 1]) {
      for (let n = 0; n < 2; n++) {
        let d = this.debris.find((e) => e.t < 0);
        if (!d) {
          if (this.debris.length >= 36) { continue; }
          const obj = this.glowRef.flatQuad(this.fieldRoot,
            "Debris" + this.debris.length, 0.28, 0.28,
            this.debris.length % 2 === 0 ? "green" : "pink", "spark", 0);
          d = { obj, t: -1, life: 1, x: 0, y: 0, h: 0, vx: 0, vy: 0, vh: 0 };
          this.debris.push(d);
        }
        d.t = 0;
        d.life = 0.8 + Math.random() * 0.6;
        d.x = xMm + (Math.random() - 0.5) * 24;
        d.y = yMm + side * (22 + Math.random() * 8);
        d.h = 0.6;
        // outward + a touch of along-track scatter, and UP
        d.vx = (Math.random() - 0.5) * 26;
        d.vy = side * (10 + Math.random() * 22);
        d.vh = 7 + Math.random() * 12;
        d.obj.enabled = true;
      }
    }
  }

  /** Wind streaks: thin long glow lines hanging in the air where the robot
   * just passed — classic racing-game speed lines. */
  private winds: { obj: SceneObject; t: number; life: number }[] = [];
  private windAccum = 0;

  windStreaks(dt: number, xMm: number, yMm: number, speedMmS: number) {
    for (const w of this.winds) {
      if (w.t < 0) { continue; }
      w.t += dt;
      const k = 1 - w.t / w.life;
      if (k <= 0) {
        w.t = -1;
        w.obj.enabled = false;
        continue;
      }
      w.obj.getTransform().setLocalScale(new vec3(k * k, 1, 1));
    }
    this.windAccum += dt;
    if (Math.abs(speedMmS) < 70 || Math.abs(speedMmS) > 420
        || this.windAccum < 0.09) {
      return;
    }
    this.windAccum = 0;
    let w = this.winds.find((e) => e.t < 0);
    if (!w) {
      if (this.winds.length >= 10) { return; }
      const obj = this.glowRef.flatQuad(this.fieldRoot,
        "Wind" + this.winds.length, 0.14, 5.5, "green", "strip", 0);
      w = { obj, t: -1, life: 0.5 };
      this.winds.push(w);
    }
    w.t = 0;
    w.life = 0.4 + Math.random() * 0.25;
    w.obj.enabled = true;
    const tr = w.obj.getTransform();
    // floats beside/above the body at a random height — reads as air flow
    tr.setLocalPosition(this.fieldMath.fieldToLocal(
      xMm + (Math.random() - 0.5) * 70,
      yMm - Math.sign(speedMmS) * (20 + Math.random() * 50),
      1.5 + Math.random() * 4.5));
    // length along the drive axis (robot drives along field Y = local z)
    tr.setLocalRotation(quat.quatIdentity());
    tr.setLocalScale(new vec3(1, 1, 1));
  }


  puckTrail(dt: number, xMm: number, yMm: number, active: boolean) {
    this.trailAccum += dt;
    if (active && this.trailAccum > 0.035) {
      this.trailAccum = 0;
      const d = this.trail.find((e) => !e.active) || this.trail[0];
      // comet taper: born WIDE right behind the puck, shrinks to a point
      this.fire(d, xMm, yMm, 0.5, 0.05, 1.35);
    }
  }

  tick(dt: number) {
    // staggered strikes fire when their tiny delay elapses
    for (let i = this.pendingStrikes.length - 1; i >= 0; i--) {
      const ps = this.pendingStrikes[i];
      ps.delay -= dt;
      if (ps.delay <= 0) {
        this.spawnStrike(ps.x, ps.y, ps.capIdx);
        this.pendingStrikes.splice(i, 1);
      }
    }
    // capacitor strikes: violent flicker, then destroyed
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const st = this.strikes[i];
      st.t += dt;
      st.obj.enabled = Math.random() > 0.35;
      if (st.t > 0.4) {
        st.obj.destroy();
        this.strikes.splice(i, 1);
      }
    }
    // lightning bolts: violent flicker, then gone
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.t += dt;
      b.obj.enabled = Math.random() > 0.3;
      const sc = 1 + b.t * 2.5;
      b.obj.getTransform().setLocalScale(new vec3(sc, 1 + b.t * 1.5, sc));
      if (b.t > 0.32) {
        b.active = false;
        b.obj.enabled = false;
      }
    }
    const all = [this.rings, this.sparks, this.flashes, this.trail, this.columns];
    for (const pool of all) {
      for (const a of pool) {
        if (!a.active) continue;
        a.t += dt;
        const k = Math.min(1, a.t / a.dur);
        const s = a.s0 + (a.s1 - a.s0) * (1 - (1 - k) * (1 - k));
        if (a.vx === -1 && a.vz === 0 && pool === this.columns) {
          // vertical column: a flash going UP — no horizontal scaling
          const rad = a.vz > 0 ? a.vz : 0.45;
          a.obj.getTransform().setLocalScale(new vec3(rad, s, rad));
        } else if ((a.vx !== 0 || a.vz !== 0) && pool === this.sparks) {
          // spark: elongated along its velocity, thin across
          const sp3 = Math.sqrt(a.vx * a.vx + a.vz * a.vz);
          const stretch = 1 + sp3 * 0.09;
          const tr2 = a.obj.getTransform();
          tr2.setLocalScale(new vec3(s * stretch, 1, s * 0.55));
          tr2.setLocalRotation(quat.angleAxis(
            -Math.atan2(a.vz, a.vx), vec3.up()));
          const p = tr2.getLocalPosition();
          tr2.setLocalPosition(new vec3(p.x + a.vx * dt, p.y, p.z + a.vz * dt));
        } else {
          a.obj.getTransform().setLocalScale(new vec3(s, 1, s));
          if (a.vx !== 0 || a.vz !== 0) {
            const p = a.obj.getTransform().getLocalPosition();
            a.obj.getTransform().setLocalPosition(
              new vec3(p.x + a.vx * dt, p.y, p.z + a.vz * dt));
          }
        }
        if (k >= 1) {
          a.active = false;
          a.obj.enabled = false;
        }
      }
    }
  }

  private grab(pool: Anim[], parity: number, salt: number): Anim {
    const free = pool.filter(
      (a, i) => !a.active && i % 2 === parity % 2);
    if (free.length > 0) return free[salt % free.length];
    return pool[(salt * 2 + parity) % pool.length];
  }

  private fire(a: Anim, xMm: number, yMm: number, dur: number,
               s1: number, s0: number, vxCm: number = 0, vzCm: number = 0) {
    a.obj.getTransform().setLocalPosition(
      this.fieldMath.fieldToLocal(xMm, yMm, 0.35));
    a.obj.getTransform().setLocalScale(new vec3(s0, 1, s0));
    a.t = 0;
    a.dur = dur;
    a.s0 = s0;
    a.s1 = s1;
    a.vx = vxCm;
    a.vz = vzCm;
    a.active = true;
    a.obj.enabled = true;
  }
}
