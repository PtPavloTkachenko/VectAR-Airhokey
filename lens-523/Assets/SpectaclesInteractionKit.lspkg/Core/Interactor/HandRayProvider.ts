import {RaycastInfo, RayProvider} from "./RayProvider"

import {InteractionPlane} from "../../Components/Interaction/InteractionPlane/InteractionPlane"
import {HandInputData} from "../../Providers/HandInputData/HandInputData"
import {HandType} from "../../Providers/HandInputData/HandType"
import {FieldTargetingMode, HandInteractor} from "../HandInteractor/HandInteractor"
import {FINGERTIP_UP_OFFSET} from "./FingertipConstants"
import {InteractorTriggerType, TargetingMode} from "./Interactor"
import RaycastProxy from "./raycastAlgorithms/RaycastProxy"

// ============================================================================
// PINCH INTENT DETECTION THRESHOLDS
// ============================================================================

/**
 * Pinch strength above which we cache the locus (if velocity detection didn't catch it).
 * Set low so user's relaxed hand position is just below this threshold.
 */
const PINCH_STRENGTH_CACHE_THRESHOLD = 0.1

/**
 * Pinch strength below which the cache is fully released (100% dynamic locus).
 * Between RELEASE and STABLE thresholds, we blend cached ↔ dynamic.
 */
const PINCH_STRENGTH_RELEASE_THRESHOLD = 0.05

/**
 * Pinch strength above which we use 100% cached locus.
 * Between RELEASE and STABLE thresholds, we blend cached ↔ dynamic.
 */
const PINCH_STRENGTH_STABLE_THRESHOLD = 0.4

/**
 * Closing velocity threshold (cm/second) to detect pinch intent.
 * When fingers are closing faster than this AND pinch strength is low, we cache the locus.
 */
const CLOSING_VELOCITY_THRESHOLD_CM_PER_SEC = 15.0

/**
 * Debug visualization colors
 */
const DEBUG_COLOR_FINAL_LOCUS = new vec4(0, 1, 0, 1) // Green - final locus
const DEBUG_COLOR_DYNAMIC_LOCUS = new vec4(1, 1, 0, 1) // Yellow - dynamic (index tip)
const DEBUG_COLOR_CACHED_LOCUS = new vec4(0, 1, 1, 1) // Cyan - cached locus
const DEBUG_COLOR_PALM_CENTER = new vec4(1, 0, 1, 1) // Magenta - palm center
const DEBUG_COLOR_INDEX_TIP = new vec4(1, 0.5, 0, 1) // Orange - index tip
const DEBUG_COLOR_THUMB_TIP = new vec4(1, 0, 0.5, 1) // Pink - thumb tip
const DEBUG_COLOR_RAY = new vec4(0, 0.5, 1, 1) // Blue - ray direction

export type HandRayProviderConfig = {
  handType: HandType
  handInteractor: HandInteractor
  drawDebug?: boolean
}

/**
 * Provides raycasting functionality for hand interactions.
 *
 * In near-field mode, uses velocity-based pinch intent detection to stabilize the locus:
 * - Detects pinch intent by watching closing velocity while pinch strength is low
 * - Caches locus offset from palm center at intent detection
 * - Smoothly blends between cached and dynamic locus based on pinch strength
 * - Cached offset follows hand translation while staying stable during pinch
 */
export class HandRayProvider implements RayProvider {
  private handProvider: HandInputData = HandInputData.getInstance()

  private hand = this.handProvider.getHand(this.config.handType)

  // Inner lerp: stable pinch locus → index tip
  // 0 = fully cached locus, 1 = fully index tip
  // Driven by physical-entry animation (0→1 over PHYSICAL_ENTRY_LERP_DURATION_SEC) or Near↔Direct transition blend
  private innerLerpValue: number = 0

  // Offset to keep locus in front of plane surface
  private offsetDistance: number = 0

  // ============================================================================
  // PINCH INTENT CACHING STATE
  // ============================================================================

  // Cached offset from palm center in HAND-LOCAL space.
  // Stored relative to the wrist rotation at cache time.
  // When recovering, we use the CURRENT wrist rotation to transform back to world,
  // making the locus follow the hand 1:1 as if parented to it (yaw, pitch, AND roll).
  private cachedLocalOffset: vec3 | null = null

  // Previous frame's finger distance for velocity calculation
  private prevFingerDistance: number | null = null

  // Timestamp of previous frame for velocity calculation
  private prevFrameTime: number | null = null

  // Frame-based caching for velocity calculation (to handle multiple calls per frame)
  private cachedVelocityFrameTime: number | null = null
  private cachedClosingVelocity: number | null = null

  // Whether we're currently in "pinch active" state (using cached locus)
  private isPinchActive: boolean = false

  // Release phase tracking for smooth time-based transition
  private isInReleasePhase: boolean = false
  private releaseStartTime: number = 0 // When release phase started (seconds)
  private hasReachedStableThreshold: boolean = false // Must reach stable before release is allowed

  // Timestamp when physical engagement started (for physical-entry lerp animation)
  private _physicalEntryStartTime: number | null = null

  // Duration for release transition (blend goes from 1.0 to 0.0 over this time)
  private static readonly RELEASE_DURATION_SEC = 0.3

  // Duration for physical-entry lerp (locus animates from cached offset → index tip)
  private static readonly PHYSICAL_ENTRY_LERP_DURATION_SEC = 0.15

  // Debug visualization flag
  private _drawDebug: boolean

  // Scratch vectors for near-field math — avoid per-frame allocations
  private readonly _scratchLerp = new vec3(0, 0, 0)
  private readonly _scratchIndexTip = new vec3(0, 0, 0)
  private readonly _scratchOffset = new vec3(0, 0, 0)

  readonly raycast = new RaycastProxy(this.hand)

  constructor(private config: HandRayProviderConfig) {
    this._drawDebug = config.drawDebug ?? false
  }

  /**
   * Enable/disable debug visualization of locus points
   */
  set drawDebug(enabled: boolean) {
    this._drawDebug = enabled
  }

  get drawDebug(): boolean {
    return this._drawDebug
  }

  /**
   * Calculates the closing velocity of index and thumb tips.
   * Returns positive value when fingers are closing, negative when opening.
   * Returns null if we don't have enough data yet.
   *
   * NOTE: This method caches the result per frame to handle multiple callers
   * within the same frame (e.g., different interactors or debug scripts).
   */
  private calculateClosingVelocity(currentDistance: number, currentTime: number = getTime()): number | null {
    // Check if we've already calculated velocity for this frame
    // Use a small epsilon (0.0001s = 0.1ms) to handle floating point comparison
    if (this.cachedVelocityFrameTime !== null && Math.abs(currentTime - this.cachedVelocityFrameTime) < 0.0001) {
      return this.cachedClosingVelocity
    }

    if (this.prevFingerDistance === null || this.prevFrameTime === null) {
      // First frame - store values and return null
      this.prevFingerDistance = currentDistance
      this.prevFrameTime = currentTime
      this.cachedVelocityFrameTime = currentTime
      this.cachedClosingVelocity = null
      return null
    }

    const deltaTime = currentTime - this.prevFrameTime
    if (deltaTime <= 0) {
      // Same frame as previous calculation but cache wasn't hit (shouldn't happen normally)
      this.cachedVelocityFrameTime = currentTime
      this.cachedClosingVelocity = null
      return null
    }

    // Closing velocity = -(change in distance) / time
    // Positive when distance is decreasing (fingers closing)
    const closingVelocity = -(currentDistance - this.prevFingerDistance) / deltaTime

    // Update for next frame
    this.prevFingerDistance = currentDistance
    this.prevFrameTime = currentTime

    // Cache the result for this frame
    this.cachedVelocityFrameTime = currentTime
    this.cachedClosingVelocity = closingVelocity

    return closingVelocity
  }

  /**
   * Gets the wrist rotation for locus tracking.
   * Uses the raw wrist rotation - the locus follows the hand 1:1 as if parented to it.
   * No filtering or decomposition, which avoids artifacts from rotation analysis.
   */
  private getWristRotation(): quat {
    return this.hand.wrist.rotation
  }

  /**
   * Detects pinch intent and manages locus caching with ASYMMETRIC BLENDING.
   *
   * IMPORTANT: We cache the offset in hand-local space using raw wrist rotation.
   * The locus follows the hand 1:1 as if parented to it:
   * - Hand translation (palm center moves in world)
   * - Full hand rotation (yaw, pitch, AND roll)
   *
   * Entry behavior (pinch):
   * - On pinch intent detection: immediately use 100% cached locus (no blend)
   * - This avoids the "dip" toward dropping index tip during pinch
   *
   * Release behavior:
   * - Only start lerping toward index when index has risen above cached position
   * - One-way ratchet: blendFactor can only decrease during release (no rubber-band)
   */
  private getStableLocus(
    dynamicLocus: vec3,
    palmCenter: vec3,
    pinchStrength: number,
    fingerDistance: number,
    indexLocalY: number | null,
    plane: InteractionPlane | null,
    suppressCache: boolean
  ): {locus: vec3; cachedWorldPos: vec3 | null; blendFactor: number} {
    const now = getTime()
    const closingVelocity = this.calculateClosingVelocity(fingerDistance, now)
    const wristRotation = this.getWristRotation()

    if (suppressCache) {
      // Freeze existing cache (skip creation and release) so it persists as the lerp
      // source for the physical-entry animation in getRaycastInfo(). Velocity bookkeeping
      // keeps running so re-entry to NearField has an accurate first sample.
      if (this.cachedLocalOffset !== null) {
        const worldOffset = wristRotation.multiplyVec3(this.cachedLocalOffset)
        worldOffset.addInPlace(palmCenter)
        return {locus: worldOffset, cachedWorldPos: worldOffset, blendFactor: 1.0}
      }
      return {locus: dynamicLocus, cachedWorldPos: null, blendFactor: 0}
    }

    // ========================================================================
    // CACHE CREATION
    // Cache locus on pinch intent (velocity-based) or strength threshold.
    // Cache is cleared only after release transition completes (prevents jumps).
    // ========================================================================

    if (this.cachedLocalOffset === null) {
      let shouldCache = false

      // Velocity-based: detect fast closing motion at low strength (early intent)
      if (closingVelocity !== null) {
        const isLowStrength = pinchStrength < PINCH_STRENGTH_CACHE_THRESHOLD
        const isClosingFast = closingVelocity > CLOSING_VELOCITY_THRESHOLD_CM_PER_SEC
        if (isLowStrength && isClosingFast) {
          shouldCache = true
        }
      }

      // Strength-based fallback: cache when strength exceeds threshold
      if (!shouldCache && pinchStrength > PINCH_STRENGTH_CACHE_THRESHOLD) {
        shouldCache = true
      }

      if (shouldCache) {
        const worldOffset = dynamicLocus.sub(palmCenter)
        // Store offset in hand-local space (relative to wrist rotation)
        // The locus will follow the hand 1:1 as if parented to it
        this.cachedLocalOffset = wristRotation.invert().multiplyVec3(worldOffset)
        this.isPinchActive = true
        this.isInReleasePhase = false
        this.releaseStartTime = 0
      }
    }

    // ========================================================================
    // BLEND CALCULATION
    // Entry: immediately 100% cached (no blend zone)
    // Release: smooth time-based transition over 300ms
    // ========================================================================

    let blendFactor = 0.0

    if (this.cachedLocalOffset !== null) {
      // 1:1 HAND ROTATION TRACKING:
      // Use raw wrist rotation to transform cached offset back to world space.
      // The locus follows the hand exactly as if it were parented to it.
      // No filtering = no artifacts from rotation decomposition.
      const worldOffset = wristRotation.multiplyVec3(this.cachedLocalOffset)
      worldOffset.addInPlace(palmCenter)
      const cachedWorldPos = worldOffset

      // Track if pinch reached stable threshold (arms release)
      if (pinchStrength >= PINCH_STRENGTH_STABLE_THRESHOLD && !this.hasReachedStableThreshold) {
        this.hasReachedStableThreshold = true
      }

      // Aborted pinch: velocity triggered cache but user never completed pinch
      if (
        !this.hasReachedStableThreshold &&
        !this.isInReleasePhase &&
        pinchStrength < PINCH_STRENGTH_RELEASE_THRESHOLD
      ) {
        this.isInReleasePhase = true
        this.releaseStartTime = now
      }

      // Normal release: armed and either Y-condition or strength condition met
      if (!this.isInReleasePhase && this.hasReachedStableThreshold) {
        let shouldRelease = false

        // Y-condition: finger rises above cached point (only when strength decreasing)
        // Lazily compute planeOrigin only when needed (optimization: avoids 7+ vec3 ops per frame)
        if (pinchStrength < PINCH_STRENGTH_STABLE_THRESHOLD && indexLocalY !== null && plane !== null) {
          const planeUp = plane.up
          const planeOrigin = plane.planeOrigin
          const cachedLocalY = cachedWorldPos.sub(planeOrigin).dot(planeUp)
          if (indexLocalY >= cachedLocalY) {
            shouldRelease = true
          }
        }

        // Strength condition: strength drops below cache threshold
        if (!shouldRelease && pinchStrength < PINCH_STRENGTH_CACHE_THRESHOLD) {
          shouldRelease = true
        }

        if (shouldRelease) {
          this.isInReleasePhase = true
          this.releaseStartTime = now
        }
      }

      // Calculate blend factor
      if (this.isInReleasePhase) {
        // Re-pinch during release: cancel and return to hold
        if (pinchStrength >= PINCH_STRENGTH_CACHE_THRESHOLD) {
          this.isInReleasePhase = false
          this.releaseStartTime = 0
          blendFactor = 1.0
        } else {
          // Time-based transition: 1.0 → 0.0 over RELEASE_DURATION_SEC
          const elapsed = now - this.releaseStartTime
          const t = Math.min(1.0, elapsed / HandRayProvider.RELEASE_DURATION_SEC)
          blendFactor = 1.0 - t

          // Transition complete: clear cache
          if (t >= 1.0) {
            this.isPinchActive = false
            this.isInReleasePhase = false
            this.releaseStartTime = 0
            this.hasReachedStableThreshold = false
            this.cachedLocalOffset = null
            return {locus: dynamicLocus, cachedWorldPos: null, blendFactor: 0}
          }
        }
      } else {
        // Hold phase: 100% cached
        blendFactor = 1.0
      }

      this._scratchLerp.copyFrom(dynamicLocus)
      this._scratchLerp.lerpInPlace(cachedWorldPos, blendFactor)
      return {locus: this._scratchLerp, cachedWorldPos, blendFactor}
    }

    return {locus: dynamicLocus, cachedWorldPos: null, blendFactor: 0}
  }

  /** @inheritdoc */
  getRaycastInfo(): RaycastInfo {
    const ray = this.raycast.getRay()

    if (ray === null) {
      return {
        direction: vec3.zero(),
        locus: vec3.zero()
      }
    }

    // ========================================================================
    // CHECK TRANSITION STATE
    // During a field mode transition, we use the OLD mode's ray until the cursor
    // has fully faded out (shouldUseNewMode becomes true).
    // ========================================================================
    const transitionInfo = this.config.handInteractor.fieldModeTransitionInfo
    const effectiveMode = transitionInfo.shouldUseNewMode ? transitionInfo.toMode : transitionInfo.fromMode

    // Use effective plane (which may be cached during Near→Far transition)
    const effectivePlane = this.config.handInteractor.getEffectiveInteractionPlane()

    // Determine if we should use far-field ray
    const useFarFieldRay =
      effectiveMode === FieldTargetingMode.FarField ||
      // Also use far-field ray if we don't have near-field data
      effectivePlane === null

    // When using far-field ray, return the GestureModule's ray
    if (useFarFieldRay) {
      // Reset near-field state when in far-field mode.
      // isInReleasePhase, releaseStartTime, and hasReachedStableThreshold must also be
      // cleared: if the user leaves near-field mid-pinch, hasReachedStableThreshold stays
      // true, and on the next near-field entry a velocity-based cache (created at low
      // strength) immediately satisfies the "normal release" condition and starts releasing
      // on the very first frame — breaking locus stabilization entirely.
      if (
        this.isPinchActive ||
        this.cachedLocalOffset !== null ||
        this._physicalEntryStartTime !== null ||
        this.isInReleasePhase ||
        this.hasReachedStableThreshold
      ) {
        this.isPinchActive = false
        this.cachedLocalOffset = null
        this._physicalEntryStartTime = null
        this.isInReleasePhase = false
        this.releaseStartTime = 0
        this.hasReachedStableThreshold = false
        this.prevFingerDistance = null
        this.prevFrameTime = null
        this.cachedVelocityFrameTime = null
        this.cachedClosingVelocity = null
      }
      return ray
    }

    // Near field mode: use velocity-based pinch intent detection
    const indexTipRaw = this.hand.indexTip?.position
    const indexTipUp = this.hand.indexTip?.up
    const thumbTip = this.hand.thumbTip?.position

    if (indexTipRaw === undefined || indexTipUp === undefined || thumbTip === undefined) {
      return {
        direction: vec3.zero(),
        locus: vec3.zero()
      }
    }

    // Apply fingertip offset to align raycast locus with poke spherecast endpoint.
    // FINGERTIP_UP_OFFSET shifts DOWN from the top of the fingertip to its center.
    this._scratchIndexTip.copyFrom(indexTipUp)
    this._scratchIndexTip.uniformScaleInPlace(FINGERTIP_UP_OFFSET)
    this._scratchIndexTip.addInPlace(indexTipRaw)
    const indexTip = this._scratchIndexTip

    // Use the effective projection (which may be cached during Near→Far transition)
    const planeProjection = this.config.handInteractor.getEffectiveCachedIndexProjection()

    if (planeProjection === null || effectivePlane === null) {
      return {
        direction: vec3.zero(),
        locus: vec3.zero()
      }
    }

    const planeNormal = effectivePlane.normal
    const physicalZoneDepth = effectivePlane.physicalZoneDepth
    const physicalZoneExitDepth = effectivePlane.physicalZoneExitDepth
    const distance = planeProjection.distance

    // Track direct mode for seamless transitions
    const isInDirectMode = effectiveMode === FieldTargetingMode.Direct
    const isTransitioningToFromDirect =
      transitionInfo.isTransitioning &&
      (transitionInfo.toMode === FieldTargetingMode.Direct || transitionInfo.fromMode === FieldTargetingMode.Direct)

    // Determine if a physical interaction (poke or direct-pinch from PhysicalInteractionProvider)
    // is active. Used to animate the locus from cached wrist-offset → live index tip.
    const currentTrigger = this.config.handInteractor.currentTrigger
    const activeMode = this.config.handInteractor.activeTargetingMode
    // During an active trigger the targeting mode is locked, so isInDirectMode alone must not
    // trigger physical engagement — it would jump the locus during an indirect drag and then
    // get stuck at innerLerpValue=1 when the hand pulls back (the else-if reset is blocked
    // because currentTrigger !== None during a drag).
    const isPhysicallyEngaged =
      (isInDirectMode && currentTrigger === InteractorTriggerType.None) ||
      activeMode === TargetingMode.Poke ||
      activeMode === TargetingMode.Direct

    if (isPhysicallyEngaged) {
      if (this._physicalEntryStartTime === null) {
        this._physicalEntryStartTime = getTime()
        // If physical engagement begins while a pinch release is in progress, clear the
        // release state immediately. Without this, suppressCache=true forces getStableLocus
        // to return blendFactor=1.0 (fully cached offset), snapping the locus backward
        // to the wrist-anchor position before the physical-entry lerp can animate it
        // forward. Clearing the cache lets the physical-entry animation start cleanly
        // from the index tip, which is where the release was already heading.
        if (this.isInReleasePhase) {
          this.cachedLocalOffset = null
          this.isPinchActive = false
          this.isInReleasePhase = false
          this.releaseStartTime = 0
          this.hasReachedStableThreshold = false
        }
      }
    } else {
      if (this._physicalEntryStartTime !== null) {
        // Falling edge: just exited physical engagement. Clear the frozen cache so
        // normal caching starts fresh rather than snapping back to the frozen offset.
        this.cachedLocalOffset = null
        this.isPinchActive = false
        this.isInReleasePhase = false
        this.releaseStartTime = 0
        this.hasReachedStableThreshold = false
      }
      this._physicalEntryStartTime = null
    }

    if (isTransitioningToFromDirect) {
      // Transition blend takes priority over the physical-entry animation so the
      // Near↔Direct mode blend completes uninterrupted.
      //
      // Why priority matters: when effectiveMode flips to Direct mid-transition
      // (shouldUseNewMode becomes true), isInDirectMode becomes true and therefore
      // isPhysicallyEngaged becomes true (guard: isInDirectMode && trigger===None).
      // Without this check, the isPhysicallyEngaged branch would restart the
      // physical-entry animation from elapsed≈0, snapping innerLerpValue back to
      // ~0 mid-transition and visibly jerking the ray locus.
      //
      // blendFactor goes 1→0 for Near→Direct, so innerLerp goes 0→1.
      // blendFactor goes 0→1 for Direct→Near, so innerLerp goes 1→0.
      this.innerLerpValue = 1 - transitionInfo.blendFactor
    } else if (isPhysicallyEngaged) {
      // Animate locus from cached wrist-offset position → live index tip over PHYSICAL_ENTRY_LERP_DURATION_SEC
      const elapsed = getTime() - this._physicalEntryStartTime!
      this.innerLerpValue = Math.min(1.0, elapsed / HandRayProvider.PHYSICAL_ENTRY_LERP_DURATION_SEC)
    } else if (currentTrigger === InteractorTriggerType.None) {
      this.innerLerpValue = 0
    }

    if (isPhysicallyEngaged || currentTrigger === InteractorTriggerType.None) {
      // Offset for poke interactions - use hysteresis-aware threshold
      // When already in Direct mode, use the exit threshold (4cm) to prevent cursor snapping
      // during the 3cm-4cm transition zone
      const effectivePhysicalThreshold = isInDirectMode ? physicalZoneExitDepth : physicalZoneDepth
      this.offsetDistance = distance <= effectivePhysicalThreshold ? effectivePhysicalThreshold - distance : 0
    }

    // ========================================================================
    // PINCH INTENT DETECTION
    // Uses index tip as dynamic locus, caches OFFSET from palm when pinch intent is detected.
    // The cached offset follows hand translation while staying stable during pinch.
    // ========================================================================

    const pinchStrength = this.hand.getPinchStrength() ?? 0
    const fingerDistance = indexTip.distance(thumbTip)
    const palmCenter = this.hand.getPalmCenter()

    // Need palm center for caching offset
    if (palmCenter === null) {
      return {
        direction: vec3.zero(),
        locus: vec3.zero()
      }
    }

    // Dynamic locus: use index tip for accurate targeting
    // (could also use halfway point - this is tunable)
    const dynamicLocus = indexTip

    const suppressCache = isPhysicallyEngaged

    // Get stable locus (blended between dynamic and cached based on pinch strength)
    // Pass plane for lazy Y-condition evaluation (avoids computing planeOrigin every frame)
    const {
      locus: stablePinchLocus,
      cachedWorldPos,
      blendFactor
    } = this.getStableLocus(
      dynamicLocus,
      palmCenter,
      pinchStrength,
      fingerDistance,
      planeProjection.localY,
      effectivePlane,
      suppressCache
    )

    // Calculate index tip with offset (for poke interactions)
    let indexTipWithOffset: vec3
    if (this.offsetDistance === 0) {
      indexTipWithOffset = indexTip
    } else {
      this._scratchOffset.copyFrom(planeNormal)
      this._scratchOffset.uniformScaleInPlace(this.offsetDistance)
      this._scratchOffset.addInPlace(indexTip)
      indexTipWithOffset = this._scratchOffset
    }

    // ========================================================================
    // LOCUS & DIRECTION CALCULATION
    // Blend stable pinch locus → index tip using innerLerpValue.
    // innerLerpValue is 0 in NearField (use cached locus), 1 at full physical engagement.
    // ========================================================================
    this._scratchLerp.copyFrom(stablePinchLocus)
    this._scratchLerp.lerpInPlace(indexTipWithOffset, this.innerLerpValue)
    const finalLocus = this._scratchLerp

    // Direction: points toward plane (opposite of normal)
    const lerpDirection = planeNormal.uniformScale(-1)

    // Debug visualization
    if (this._drawDebug) {
      this.drawDebugVisualization(
        finalLocus,
        dynamicLocus,
        cachedWorldPos,
        palmCenter,
        indexTip,
        thumbTip,
        lerpDirection,
        pinchStrength,
        blendFactor,
        isPhysicallyEngaged
      )
    }

    return {
      direction: lerpDirection,
      locus: finalLocus.clone()
    }
  }

  /**
   * Draws debug visualization of locus points and ray direction.
   */
  private drawDebugVisualization(
    finalLocus: vec3,
    dynamicLocus: vec3,
    cachedLocus: vec3 | null,
    palmCenter: vec3 | null,
    indexTip: vec3,
    thumbTip: vec3,
    direction: vec3,
    pinchStrength: number,
    blendFactor: number,
    isPhysicallyEngaged: boolean
  ): void {
    const crossSize = 0.5

    // Draw final locus: GREEN normally, ORANGE when physically engaged
    const finalLocusColor = isPhysicallyEngaged ? new vec4(1, 0.5, 0, 1) : DEBUG_COLOR_FINAL_LOCUS
    this.drawCross(finalLocus, crossSize * 1.5, finalLocusColor)

    // Draw dynamic locus (YELLOW) - the index tip
    this.drawCross(dynamicLocus, crossSize, DEBUG_COLOR_DYNAMIC_LOCUS)

    // Draw cached locus (CYAN) - only when pinch is active
    if (cachedLocus !== null) {
      this.drawCross(cachedLocus, crossSize * 1.2, DEBUG_COLOR_CACHED_LOCUS)

      // Draw line from dynamic to cached
      // RED when in hold phase (not releasing), GREEN when in release phase
      const lineColor = this.isInReleasePhase ? new vec4(0, 1, 0, 0.8) : new vec4(1, 0, 0, 0.8)
      global.debugRenderSystem.drawLine(dynamicLocus, cachedLocus, lineColor)
    }

    // Draw palm center (MAGENTA)
    if (palmCenter !== null) {
      this.drawCross(palmCenter, crossSize * 0.75, DEBUG_COLOR_PALM_CENTER)
    }

    // Draw index tip (ORANGE)
    this.drawCross(indexTip, crossSize * 0.5, DEBUG_COLOR_INDEX_TIP)

    // Draw thumb tip (PINK)
    this.drawCross(thumbTip, crossSize * 0.5, DEBUG_COLOR_THUMB_TIP)

    // Draw ray direction from final locus (BLUE)
    const rayEnd = finalLocus.add(direction.uniformScale(20))
    global.debugRenderSystem.drawLine(finalLocus, rayEnd, DEBUG_COLOR_RAY)

    // Draw pinch strength indicator (yellow to red)
    const pinchIndicatorStart = finalLocus.add(new vec3(0, 2, 0))
    const pinchIndicatorEnd = pinchIndicatorStart.add(new vec3(pinchStrength * 5, 0, 0))
    const pinchColor = new vec4(1, 1 - pinchStrength, 0, 1)
    global.debugRenderSystem.drawLine(pinchIndicatorStart, pinchIndicatorEnd, pinchColor)

    // Draw blend factor indicator (shows how much we're using cached vs dynamic)
    // Green bar when in hold/entry, cyan bar when in release phase
    const blendIndicatorStart = finalLocus.add(new vec3(0, 3, 0))
    const blendIndicatorEnd = blendIndicatorStart.add(new vec3(blendFactor * 5, 0, 0))
    const blendColor = this.isInReleasePhase ? new vec4(0, 1, 1, 1) : new vec4(0, 1, 0, 1)
    global.debugRenderSystem.drawLine(blendIndicatorStart, blendIndicatorEnd, blendColor)

    // Draw inner lerp indicator (shows physical-entry animation progress 0→1)
    // Orange bar when physically engaged (animating), dim grey when inactive
    const innerLerpIndicatorStart = finalLocus.add(new vec3(0, 4, 0))
    const innerLerpIndicatorEnd = innerLerpIndicatorStart.add(new vec3(this.innerLerpValue * 5, 0, 0))
    const innerLerpColor = isPhysicallyEngaged ? new vec4(1, 0.5, 0, 1) : new vec4(0.4, 0.4, 0.4, 0.5)
    global.debugRenderSystem.drawLine(innerLerpIndicatorStart, innerLerpIndicatorEnd, innerLerpColor)

    // Draw release phase indicator - white dot below final locus when releasing
    if (this.isInReleasePhase) {
      const releaseIndicator = finalLocus.add(new vec3(0, -1, 0))
      this.drawCross(releaseIndicator, crossSize * 0.3, new vec4(1, 1, 1, 1))
    }
  }

  /**
   * Draws a 3D cross at the specified position for debug visualization.
   */
  private drawCross(position: vec3, size: number, color: vec4): void {
    global.debugRenderSystem.drawLine(position.add(new vec3(-size, 0, 0)), position.add(new vec3(size, 0, 0)), color)
    global.debugRenderSystem.drawLine(position.add(new vec3(0, -size, 0)), position.add(new vec3(0, size, 0)), color)
    global.debugRenderSystem.drawLine(position.add(new vec3(0, 0, -size)), position.add(new vec3(0, 0, size)), color)
  }

  /** @inheritdoc */
  isAvailable(): boolean {
    return (this.hand.isInTargetingPose() && this.hand.isTracked()) || this.hand.isPinching()
  }

  /** @inheritdoc */
  reset(): void {
    this.raycast.reset()
    this.isPinchActive = false
    this.isInReleasePhase = false
    this.releaseStartTime = 0
    this.hasReachedStableThreshold = false
    this.cachedLocalOffset = null
    this._physicalEntryStartTime = null
    this.prevFingerDistance = null
    this.prevFrameTime = null
    this.cachedVelocityFrameTime = null
    this.cachedClosingVelocity = null
    this.innerLerpValue = 0
    this.offsetDistance = 0
  }
}
