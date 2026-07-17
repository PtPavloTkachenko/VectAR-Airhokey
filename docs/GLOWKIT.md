# GlowKit — the procedural neon toolkit

`lens/Assets/Scripts/GlowKit.ts` (~500 lines, zero dependencies beyond SIK's
logger). Everything neon in this game — borders, traces, lightning, pools of
light, the tron floor — is generated at runtime by this one class. It's
deliberately reusable: drop the file + the `Textures/` sprites into any
Spectacles project and you have a code-first neon vocabulary.

## The idea

No neon shaders, no VFX graphs, no lights. Every visual is a **quad or
triangle strip with a soft procedural glow sprite on an additive material**.
Two base materials (green / pink, an ImageMaterial with Add blend) are cloned
and re-tinted at runtime; eight small PNGs (`glow_strip`, `glow_disc`,
`glow_ring`, `spark`, `glow_plate`, `metal_gradient`, `glow_frame`,
`glow_pool`) provide the falloff. This renders everywhere Lens Studio
renders, costs almost nothing, and survives editor↔device parity issues that
kill fancier approaches.

```ts
const glow = new GlowKit(this.matGlowGreen, this.matGlowPink); // 2 @input materials
glow.line(root, "L1", -20, 0, 20, 0, 1.2, "green");        // neon line on the floor
glow.tube(root, "T1", -20, -12, 20, -12, "pink", 2.2, 0.5); // volumetric neon tube
glow.electricArc(root, "Arc", 3.5, "green");                // orbiting tesla arc
```

## Materials (cached clones)

| Method | What you get |
|---|---|
| `material(color, tex)` | additive glow material; `color` ∈ `green · pink · greenDim · pinkDim`, `tex` ∈ the 8 sprites. HDR-ish tints (>1 channels) for bloom-like hotness. |
| `metalMaterial()` | opaque graphite gradient — "metal" without PBR or lights (perf rule: none in the whole scene) |
| `darkMaterial()` | opaque dark-gray for casings/IC bodies. **Not pure black** — additive scenes read pure black as transparent |
| `solidTinted("green"\|"pink")` | opaque tinted ceramic look (component bodies that must not be see-through) |
| `occluderMaterial()` | depth-only: colorMask off, depthWrite on — turn any mesh into an AR occluder |

## Geometry primitives (all: `(parent, name, …) → SceneObject`)

| Method | Use |
|---|---|
| `flatQuad(w, l, color, tex, y?)` | textured floor quad — pools of light, pads, ambient frames |
| `line(x1,z1,x2,z2, w, color, y?)` | glow strip between two floor points — traces, borders |
| `batchedLines(segs[], w, color, y)` / `batchedDiscs(pts[], size, color, y)` | MANY segments/discs merged into ONE mesh = one draw call — use for static networks (our PCB net went ~150 → ~45 draw calls) |
| `wall(x1, x2, z, h, color)` / `wallLoop(pts[], h, color)` | vertical glow curtains — field walls, block-burst perimeters |
| `tube(x1,z1,x2,z2, color, r, coreR)` | volumetric neon tube: soft halo shell + hot core (the field borders) |
| `cylinderGlow(r, h, color)` | vertical light column (puck column, impact bursts) |
| `electricArc(r, color)` | jagged orbiting tesla arc (capacitors) — animate scale/rotation + flicker per frame |
| `boltRibbon(pts[], w, color)` | double-sided jagged lightning ribbon through arbitrary 3D points (goal strikes) |
| `occluderBox(w, h, d)` | 5-face depth-only box (skips the bottom) |
| `emptyVisual(color)` / `dynBuilder()` | escape hatches for custom per-frame meshes |

## The gotchas (earned in ~30 design loops)

1. **Winding order**: up-facing floor quads must be CCW **from above** —
   indices `(0,1,2)(3,4,5)` with the proven vertex order in `flatQuad`.
   Clockwise = back-culled = silently invisible. Trust the existing pattern.
2. **Lens Studio 5.15 `Material.clone()` resets graph property VALUES to
   defaults.** Direct asset uses keep Inspector values; clones go white.
   GlowKit therefore sets `blendMode / depthWrite / depthTest / baseTex /
   baseColor` explicitly on every clone. Do the same for any new material
   path you add.
3. **Pure black reads as transparent** in an additive scene — dark parts use
   0.31-gray, never (0,0,0).
4. **renderOrder discipline**: occluders −10 (depth first), solid/dark prop
   parts −5, neon default, puck & friends +10. Additive glow ignoring
   occluder depth usually means the material has `depthTest:false` — GlowKit
   sets `depthTest:true` on clones for exactly this reason.
5. **Batch static geometry** (`batchedLines`/`batchedDiscs`). Per-segment
   objects are fine for a dozen animated pieces, death by draw calls for a
   trace network.
6. **Brightness ≈ thickness** perceptually — a brighter trace *looks* fatter.
   Unify widths AND tint (use the `*Dim` variants) or the design reads messy.
7. Textures load via `requireAsset("../Textures/…")` — keep the relative
   path if you move the script.

## Porting to your project

Copy `GlowKit.ts` + `Assets/Textures/glow_*.png, spark.png,
metal_gradient.png`, create two ImageMaterial assets (blend **Add**, any
texture), wire them as `@input` materials, and construct
`new GlowKit(green, pink)`. Recolor by editing the two `baseColor` vec4
tables at the top of `material()`. For animated pieces (arcs, pulses, comet
trails) see `DecoAnimator.ts` and `VFXBursts.ts` — they're the choreography
layer on top of these primitives and are equally portable.
