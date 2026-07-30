import {InteractionManager} from "../../../../Core/InteractionManager/InteractionManager"
import {smoothstep} from "../../../../Utils/mathUtils"
import {SpringAnimate1D} from "../../../../Utils/springAnimate"
import {Interactable} from "../../Interactable/Interactable"
import {ConeOverlap, HIDE_ALPHA_THRESHOLD, PLANE_BLEND_ZONE_WIDTH, PLANE_SLOW_ZONE_DISTANCE} from "./ConeOverlap"

/**
 * Owns the depth-spring math for all three cursor paths (direct hit, fallback
 * blend, near-field poke).
 *
 * Spring state is a scalar `_depth` (distance along the active ray). Storing the
 * scalar rather than a world-space anchor avoids the coordinate-frame shift bug
 * that appeared when `indirectStart` animated during poke entry: the old design
 * re-projected the world-space anchor onto the new frame each frame, so a moving
 * origin caused `currentDepth` to jump even when the anchor hadn't moved in world
 * space.
 *
 * Null `_depth` means "snap on next evaluate" (replaces the old boolean
 * `snapNextFrame`). Use `requestSnap()` to arm a snap; `reset()` for a full
 * spring reset with snap armed.
 *
 * `lastResultPosition` is the world-space position of the most recent result,
 * copied from the internal `_result` vec3 each call. Callers that bypass the
 * smooth methods (trigger drag, manipulation, scrolldrag) should call
 * `keepDepthAt()` to keep `_depth` in sync so spring transitions are smooth on exit.
 */
export class DepthSmoother {
  private readonly snappySpring: SpringAnimate1D = SpringAnimate1D.snappy(0.35)
  private readonly slowSpring: SpringAnimate1D = SpringAnimate1D.snappy(0.6)

  // null = snap on next evaluate; number = current spring depth along active ray.
  private _depth: number | null = null

  // World-space position of the last smooth result. Stable copy — safe to hold across calls.
  public lastResultPosition: vec3 = vec3.zero()

  private readonly _result = new vec3(0, 0, 0)
  private readonly _scratch = new vec3(0, 0, 0)

  constructor(
    private readonly cone: ConeOverlap,
    private readonly interactionManager: InteractionManager
  ) {}

  // ----- Snap control --------------------------------------------------------

  /** Arms a one-shot snap: the next smooth call jumps directly to target depth. */
  public requestSnap(): void {
    this._depth = null
  }

  /** Full reset — zeros velocity, arms snap. Use on cursor hide. */
  public reset(): void {
    this._depth = null
    this.snappySpring.reset()
    this.slowSpring.reset()
  }

  /** True when a snap is armed (next evaluate will jump to target). */
  public get isSnapping(): boolean {
    return this._depth === null
  }

  /**
   * Keeps `_depth` in sync for paths that set `_cursorPosition` directly without
   * calling a smooth method (trigger drag, manipulation, scrolldrag). Call this
   * instead of the old `stableAnchorPoint = worldPos` pattern so that when the
   * path exits and a smooth method runs again, it starts from the correct depth
   * rather than snapping.
   */
  public keepDepthAt(worldPos: vec3, rayOrigin: vec3, rayDir: vec3): void {
    this._scratch.copyFrom(worldPos)
    this._scratch.subInPlace(rayOrigin)
    this._depth = this._scratch.dot(rayDir)
    this.lastResultPosition.copyFrom(worldPos)
  }

  // ----- Smooth methods ------------------------------------------------------

  /**
   * Direct-hit smoothing along the interactor ray. Plane-aware: blends the snappy
   * and slow springs based on world-space distance to the parent plane's surface.
   */
  public smoothDirectHit(rayOrigin: vec3, rayDir: vec3, interactable: Interactable, rawTargetPosition: vec3): vec3 {
    this._scratch.copyFrom(rawTargetPosition)
    this._scratch.subInPlace(rayOrigin)
    const targetDepth = this._scratch.dot(rayDir)

    let smoothedDepth: number
    if (this._depth === null) {
      this.snappySpring.reset()
      this.slowSpring.reset()
      smoothedDepth = targetDepth
    } else {
      const parentPlane = this.interactionManager.getParentPlane(interactable)
      if (this.cone.isPlaneEnabled(parentPlane) && !interactable.ignoreInteractionPlane) {
        const currentDepth = this._depth
        const snappyDepth = this.snappySpring.evaluate(currentDepth, targetDepth)
        const slowDepth = this.slowSpring.evaluate(currentDepth, targetDepth)

        const {origin: planeOrigin, normal: planeNormal} = this.cone.getPlaneWorldOriginAndAxes(parentPlane)
        // lastResultPosition is the world-space anchor from the previous frame —
        // read it before _result is overwritten below.
        this._scratch.copyFrom(this.lastResultPosition)
        this._scratch.subInPlace(planeOrigin)
        const worldDistance = Math.abs(this._scratch.dot(planeNormal))

        const blendFactor = smoothstep(
          PLANE_SLOW_ZONE_DISTANCE + PLANE_BLEND_ZONE_WIDTH,
          PLANE_SLOW_ZONE_DISTANCE,
          worldDistance
        )
        smoothedDepth = snappyDepth * (1.0 - blendFactor) + slowDepth * blendFactor
      } else {
        smoothedDepth = this.snappySpring.evaluate(this._depth, targetDepth)
      }
    }

    this._depth = smoothedDepth
    this._result.copyFrom(rayDir)
    this._result.uniformScaleInPlace(smoothedDepth)
    this._result.addInPlace(rayOrigin)
    this.lastResultPosition.copyFrom(this._result)
    return this._result
  }

  /**
   * Fallback (multi-target blend) smoothing. Arms a snap automatically when the
   * cursor becomes effectively invisible (overallAlpha ≤ HIDE_ALPHA_THRESHOLD) so
   * re-appearance snaps cleanly to the new hover depth.
   */
  public smoothFallback(rayOrigin: vec3, rayVector: vec3, rayDir: vec3, targetT: number, overallAlpha: number): vec3 {
    // targetT is a blend parameter along rayVector; project to depth along rayDir.
    this._scratch.copyFrom(rayVector)
    this._scratch.uniformScaleInPlace(targetT)
    const targetDepth = this._scratch.dot(rayDir)

    if (overallAlpha <= HIDE_ALPHA_THRESHOLD) {
      this.snappySpring.reset()
      this._depth = null
    }

    let smoothedDepth: number
    if (this._depth === null) {
      this.snappySpring.reset()
      smoothedDepth = targetDepth
    } else {
      smoothedDepth = this.snappySpring.evaluate(this._depth, targetDepth)
    }

    this._depth = smoothedDepth
    this._result.copyFrom(rayDir)
    this._result.uniformScaleInPlace(smoothedDepth)
    this._result.addInPlace(rayOrigin)
    this.lastResultPosition.copyFrom(this._result)
    return this._result
  }

  /**
   * Near-field smoothing — spring-smooths depth along the indirect ray toward the
   * latched poke contact point.
   *
   * KEY FIX: `_depth` is a stored scalar advanced by the spring each frame.
   * It does NOT re-project a world-space anchor onto the current frame, so an
   * animating `indirectStart` (HandRayProvider locus lerp on poke entry) no longer
   * causes a visible depth jump. When `indirectStart` moves laterally the cursor
   * follows it in world space; the depth value itself only changes by the spring's
   * damping each frame.
   */
  public smoothNearField(indirectStart: vec3, indirectDir: vec3, targetHit: vec3): vec3 {
    this._scratch.copyFrom(targetHit)
    this._scratch.subInPlace(indirectStart)
    const targetDepth = this._scratch.dot(indirectDir)

    let smoothedDepth: number
    if (this._depth === null) {
      this.snappySpring.reset()
      this.slowSpring.reset()
      smoothedDepth = targetDepth
    } else {
      smoothedDepth = this.snappySpring.evaluate(this._depth, targetDepth)
    }

    this._depth = smoothedDepth
    this._result.copyFrom(indirectDir)
    this._result.uniformScaleInPlace(smoothedDepth)
    this._result.addInPlace(indirectStart)
    this.lastResultPosition.copyFrom(this._result)
    return this._result
  }
}
