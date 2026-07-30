import {InteractionManager} from "../../../../Core/InteractionManager/InteractionManager"
import WorldCameraFinderProvider from "../../../../Providers/CameraProvider/WorldCameraFinderProvider"
import {ColliderUtils} from "../../../../Utils/ColliderUtils"
import {smoothstep} from "../../../../Utils/mathUtils"
import {Interactable, TargetingVisual} from "../../Interactable/Interactable"
import {InteractionPlane} from "../../InteractionPlane/InteractionPlane"
import {
  ALPHA_FADE_DISTANCE,
  CachedInteractableData,
  ConeOverlap,
  CONE_RADIUS,
  DOMINANCE_FADE_WIDTH,
  DOMINANCE_RADIUS,
  DebugCalculationState,
  GEOMETRY_EPSILON,
  INV_CONE_RADIUS,
  INTERACTABLE_FADE_HOTSPOT_RADIUS,
  MIN_LENGTH_THRESHOLD,
  PLANE_FADE_HOTSPOT_RADIUS,
  PROXIMITY_HOT_ZONE_FACTOR,
  PROXIMITY_NEAR_ZONE_FACTOR,
  SCORE_DIVISOR_EPSILON,
  SMALL_SPHERE_RADIUS_THRESHOLD
} from "./ConeOverlap"

/**
 * Owns the score-and-blend math: per-interactable / per-plane targeting calculations
 * and the multi-target weighted blend that produces a single (targetT, alpha) result.
 * Reads the canonical entry lists from ConeOverlap.
 */
export class InteractableScoring {
  private processingQueue: Interactable[] = []
  private processingIndex: number = 0

  // Pre-allocated return object for blendCachedInteractables(). Callers must read
  // fields immediately — the values are overwritten on the next call.
  private _blendResult = {targetT: 0, cursorAlpha: 0, rayAlpha: 0}

  private readonly _scratchA = new vec3(0, 0, 0)
  private readonly _scratchB = new vec3(0, 0, 0)
  private readonly _scratchC = new vec3(0, 0, 0)

  public debugDrawEnabled: boolean = false

  constructor(
    private readonly cone: ConeOverlap,
    private readonly interactionManager: InteractionManager,
    private readonly camera: WorldCameraFinderProvider
  ) {}

  public getEffectiveTargetingVisual(interactable: Interactable): number {
    const plane = this.interactionManager.getParentPlane(interactable)
    if (!interactable.ignoreInteractionPlane && this.cone.isPlaneEnabled(plane)) {
      return plane.targetingVisual
    }
    return interactable.targetingVisual
  }

  public updateInteractableCacheBatch(segmentStart: vec3, segDirNorm: vec3, segLen: number): void {
    const currentTime = getTime()
    const planeEntries = this.cone.overlappingPlaneEntries
    const interactableEntries = this.cone.overlappingInteractableEntries

    for (let i = 0; i < planeEntries.length; i++) {
      const {plane, data} = planeEntries[i]
      const eligible = this.cone.isPlaneEligible(plane)
      data.isEligible = eligible
      if (!eligible) {
        data.score = 0
        continue
      }
      if (this.updatePlaneTargetingData(plane, data, segmentStart, segDirNorm, segLen)) {
        data.lastUpdated = currentTime
      }
    }

    this.processingQueue.length = 0

    for (let i = 0; i < interactableEntries.length; i++) {
      const {interactable, data} = interactableEntries[i]
      if (data.isEligible) {
        this.processingQueue.push(interactable)
      } else {
        data.score = 0
      }
    }

    const eligibleCount = this.processingQueue.length
    if (eligibleCount === 0) {
      this.processingIndex = 0
      return
    }
    if (this.processingIndex >= this.processingQueue.length) {
      this.processingIndex = 0
    }

    const chunkSize = Math.max(1, Math.floor(Math.sqrt(eligibleCount)))

    for (let i = 0; i < chunkSize; i++) {
      if (this.processingIndex >= this.processingQueue.length) break

      const interactable = this.processingQueue[this.processingIndex]
      const idx = this.cone.findOverlappingInteractable(interactable)

      if (idx >= 0) {
        const cachedData = interactableEntries[idx].data
        this.updateInteractableTargetingData(interactable, cachedData, segmentStart, segDirNorm, segLen)
        cachedData.lastUpdated = currentTime
      }
      this.processingIndex++
    }
  }

  private updatePlaneTargetingData(
    plane: InteractionPlane,
    out: CachedInteractableData,
    segmentStart: vec3,
    segDirNorm: vec3,
    segLen: number
  ): boolean {
    if (segLen <= MIN_LENGTH_THRESHOLD) {
      return false
    }

    const baseRadius = CONE_RADIUS
    const invSegLen = 1.0 / segLen

    let targetT = 0,
      radialDistance = Infinity,
      coneRadiusAtT = 0,
      hotspotRadius = 0

    {
      const {origin: planeOrigin, normal, right, up, halfWidth, halfHeight} = this.cone.getPlaneWorldOriginAndAxes(plane)

      const denom = segDirNorm.dot(normal)
      if (Math.abs(denom) <= GEOMETRY_EPSILON) return false

      const toP = this._scratchA
      toP.copyFrom(planeOrigin)
      toP.subInPlace(segmentStart)
      const tWorld = toP.dot(normal) / denom
      if (tWorld < 0 || tWorld > segLen) return false

      const intersection = this._scratchA
      intersection.copyFrom(segDirNorm)
      intersection.uniformScaleInPlace(tWorld)
      intersection.addInPlace(segmentStart)

      const delta = this._scratchB
      delta.copyFrom(intersection)
      delta.subInPlace(planeOrigin)

      const rx = delta.dot(right)
      const ry = delta.dot(up)
      const clampedX = rx < -halfWidth ? -halfWidth : rx > halfWidth ? halfWidth : rx
      const clampedY = ry < -halfHeight ? -halfHeight : ry > halfHeight ? halfHeight : ry

      const closestPoint = this._scratchC
      closestPoint.copyFrom(planeOrigin)

      const s = this._scratchB
      s.copyFrom(right)
      s.uniformScaleInPlace(clampedX)
      closestPoint.addInPlace(s)

      s.copyFrom(up)
      s.uniformScaleInPlace(clampedY)
      closestPoint.addInPlace(s)

      if (this.debugDrawEnabled) {
        out.debugState = DebugCalculationState.Cheap
        out.debugClosestPointOnRay = intersection.clone()
        out.debugClosestPointOnCollider = closestPoint.clone()
      }

      targetT = tWorld * invSegLen
      intersection.subInPlace(closestPoint)
      radialDistance = intersection.length

      coneRadiusAtT = baseRadius * targetT
      hotspotRadius = PLANE_FADE_HOTSPOT_RADIUS
    }

    const score = 1.0 / (radialDistance + SCORE_DIVISOR_EPSILON)
    if (score <= 0) return false

    out.score = score
    out.targetT = targetT
    out.radialDistance = radialDistance
    out.positionalDistance = radialDistance
    out.coneRadiusAtT = coneRadiusAtT
    out.hotspotRadius = hotspotRadius
    out.targetingVisual = plane.targetingVisual

    return true
  }

  private writeFallbackTargetingData(
    out: CachedInteractableData,
    fallbackDistance: number,
    segLen: number,
    targetingVisual: number
  ): void {
    const tVal = segLen > MIN_LENGTH_THRESHOLD ? Math.min(1.0, fallbackDistance / segLen) : 0.1
    out.score = 1.0 / (fallbackDistance + SCORE_DIVISOR_EPSILON)
    out.targetT = tVal
    out.radialDistance = fallbackDistance
    out.positionalDistance = fallbackDistance
    out.coneRadiusAtT = CONE_RADIUS * tVal
    out.hotspotRadius = INTERACTABLE_FADE_HOTSPOT_RADIUS
    out.targetingVisual = targetingVisual
  }

  private updateInteractableTargetingData(
    interactable: Interactable,
    out: CachedInteractableData,
    segmentStart: vec3,
    segDirNorm: vec3,
    segLen: number
  ): void {
    const baseRadius = CONE_RADIUS
    const invSegLen = 1.0 / segLen

    if (segLen <= MIN_LENGTH_THRESHOLD) {
      const fallbackDistance = interactable.sceneObject.getTransform().getWorldPosition().distance(segmentStart)
      this.writeFallbackTargetingData(out, fallbackDistance, segLen, this.getEffectiveTargetingVisual(interactable))
      return
    }

    let targetT = 0,
      alphaDistance = Infinity,
      coneRadiusAtT = 0,
      hotspotRadius = 0

    const primaryCollider = interactable.colliders ? interactable.colliders[0] : null
    if (!primaryCollider) {
      const fallbackDistance = interactable.sceneObject.getTransform().getWorldPosition().distance(segmentStart)
      this.writeFallbackTargetingData(out, fallbackDistance, segLen, this.getEffectiveTargetingVisual(interactable))
      return
    }

    const worldSphere = ColliderUtils.getColliderWorldBoundingSphere(primaryCollider)

    if (!worldSphere) {
      const fallbackDistance = interactable.sceneObject.getTransform().getWorldPosition().distance(segmentStart)
      this.writeFallbackTargetingData(out, fallbackDistance, segLen, this.getEffectiveTargetingVisual(interactable))
      return
    }

    const planePoint = worldSphere.center
    const cameraPos = this.camera.getWorldPosition()
    const planeNormal = this._scratchA
    planeNormal.copyFrom(cameraPos)
    planeNormal.subInPlace(planePoint)
    if (planeNormal.dot(planeNormal) <= GEOMETRY_EPSILON) {
      const fwd = this.camera.forward()
      planeNormal.copyFrom(fwd)
    } else {
      planeNormal.uniformScaleInPlace(1.0 / Math.sqrt(planeNormal.dot(planeNormal)))
    }
    const toCenter = this._scratchB
    toCenter.copyFrom(planePoint)
    toCenter.subInPlace(segmentStart)
    const denominator = planeNormal.dot(segDirNorm)

    let clampedTWorld: number
    if (Math.abs(denominator) > GEOMETRY_EPSILON) {
      const numerator = planeNormal.dot(toCenter)
      const tWorld = numerator / denominator
      clampedTWorld = tWorld < 0 ? 0 : tWorld > segLen ? segLen : tWorld
    } else {
      const tAlongRay = toCenter.dot(segDirNorm)
      clampedTWorld = Math.max(0, Math.min(segLen, tAlongRay))
    }

    const closestPointOnRayVec = this._scratchC
    closestPointOnRayVec.copyFrom(segDirNorm)
    closestPointOnRayVec.uniformScaleInPlace(clampedTWorld)
    closestPointOnRayVec.addInPlace(segmentStart)
    if (this.debugDrawEnabled) {
      out.debugClosestPointOnRay = closestPointOnRayVec.clone()
    }

    closestPointOnRayVec.subInPlace(worldSphere.center)
    const distanceToCenterSq = closestPointOnRayVec.dot(closestPointOnRayVec)
    closestPointOnRayVec.addInPlace(worldSphere.center)
    const distanceToCenter = Math.sqrt(distanceToCenterSq)
    alphaDistance = Math.max(0, distanceToCenter - worldSphere.radius)

    let positionalDistance: number
    targetT = clampedTWorld * invSegLen
    coneRadiusAtT = baseRadius * targetT
    hotspotRadius = INTERACTABLE_FADE_HOTSPOT_RADIUS

    if (worldSphere.radius <= SMALL_SPHERE_RADIUS_THRESHOLD) {
      positionalDistance = distanceToCenter
      if (this.debugDrawEnabled) {
        out.debugState = DebugCalculationState.Cheap
        out.debugClosestPointOnCollider = worldSphere.center
      }
    } else {
      const fastDistance = distanceToCenter - worldSphere.radius
      const hotZoneStart = worldSphere.radius * PROXIMITY_HOT_ZONE_FACTOR

      if (fastDistance > hotZoneStart) {
        positionalDistance = fastDistance
        if (this.debugDrawEnabled) {
          out.debugState = DebugCalculationState.Cheap
          if (distanceToCenter > GEOMETRY_EPSILON) {
            const directionToRay = worldSphere.center.sub(closestPointOnRayVec).normalize()
            const cheapClosestPoint = worldSphere.center.sub(directionToRay.uniformScale(worldSphere.radius))
            out.debugClosestPointOnCollider = cheapClosestPoint
          } else {
            out.debugClosestPointOnCollider = worldSphere.center
          }
        }
      } else {
        const preciseClosestPoint = ColliderUtils.getClosestPointOnColliderToPoint(
          primaryCollider,
          closestPointOnRayVec
        )

        const projScratch = this._scratchA
        projScratch.copyFrom(preciseClosestPoint)
        projScratch.subInPlace(segmentStart)
        const projection = projScratch.dot(segDirNorm)
        const s = projection < 0 ? 0 : projection > segLen ? segLen : projection
        const pointOnRay = this._scratchA
        pointOnRay.copyFrom(segDirNorm)
        pointOnRay.uniformScaleInPlace(s)
        pointOnRay.addInPlace(segmentStart)
        const preciseDistance = preciseClosestPoint.distance(pointOnRay)

        const nearZoneEnd = worldSphere.radius * PROXIMITY_NEAR_ZONE_FACTOR

        if (fastDistance <= nearZoneEnd) {
          positionalDistance = preciseDistance
          targetT = s * invSegLen
          coneRadiusAtT = baseRadius * targetT
          if (this.debugDrawEnabled) {
            out.debugState = DebugCalculationState.Expensive
            out.debugClosestPointOnCollider = preciseClosestPoint
            out.debugClosestPointOnRay = pointOnRay.clone()
          }
        } else {
          const denom = hotZoneStart - nearZoneEnd
          const rawBlend = denom > GEOMETRY_EPSILON ? (hotZoneStart - fastDistance) / denom : 1.0
          const blendAmount = rawBlend < 0 ? 0 : rawBlend > 1 ? 1 : rawBlend
          positionalDistance = MathUtils.lerp(fastDistance, preciseDistance, blendAmount)

          const blendedTWorld = MathUtils.lerp(clampedTWorld, s, blendAmount)
          targetT = blendedTWorld * invSegLen
          coneRadiusAtT = baseRadius * targetT

          if (this.debugDrawEnabled) {
            out.debugState = DebugCalculationState.Blended
            const directionToRay = worldSphere.center.sub(closestPointOnRayVec).normalize()
            const cheapClosestPoint = worldSphere.center.sub(directionToRay.uniformScale(worldSphere.radius))
            out.debugClosestPointOnCollider = vec3.lerp(cheapClosestPoint, preciseClosestPoint, blendAmount)
            out.debugClosestPointOnRay = vec3.lerp(closestPointOnRayVec, pointOnRay, blendAmount)
          }
        }
      }
    }

    const baseScore = 1.0 / (positionalDistance + SCORE_DIVISOR_EPSILON)

    let t = coneRadiusAtT > 1e-4 ? positionalDistance / coneRadiusAtT : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    let linearBonus = 1 - t
    linearBonus = linearBonus < 0 ? 0 : linearBonus
    const radialBonus = smoothstep(0.0, 1.0, linearBonus)

    out.score = baseScore * (1.0 + radialBonus)
    out.targetT = targetT
    out.radialDistance = alphaDistance
    out.positionalDistance = positionalDistance
    out.coneRadiusAtT = coneRadiusAtT
    out.hotspotRadius = hotspotRadius
    out.targetingVisual = this.getEffectiveTargetingVisual(interactable)
  }

  public blendCachedInteractables(rayLength: number): {targetT: number; cursorAlpha: number; rayAlpha: number} | null {
    const segLen = rayLength
    if (segLen <= MIN_LENGTH_THRESHOLD) {
      return null
    }

    const planeEntries = this.cone.overlappingPlaneEntries
    const interactableEntries = this.cone.overlappingInteractableEntries

    if (interactableEntries.length + planeEntries.length === 0) {
      return null
    }

    let maxDominanceFactor = 0.0

    const calculateDominance = (data: CachedInteractableData) => {
      if (data.score <= 0) {
        data.dominanceFactor = 0
        return
      }
      const scale = data.coneRadiusAtT * INV_CONE_RADIUS
      const scaledDominanceRadius = DOMINANCE_RADIUS * scale
      const scaledFadeWidth = DOMINANCE_FADE_WIDTH * scale
      data.dominanceFactor = smoothstep(
        scaledDominanceRadius + scaledFadeWidth,
        scaledDominanceRadius,
        data.positionalDistance
      )
      maxDominanceFactor = Math.max(maxDominanceFactor, data.dominanceFactor)
    }

    for (let i = 0; i < planeEntries.length; i++) {
      const data = planeEntries[i].data
      if (!data.isEligible) {
        continue
      }
      calculateDominance(data)
    }
    for (let i = 0; i < interactableEntries.length; i++) {
      const data = interactableEntries[i].data
      if (!data.isEligible) {
        data.score = 0
        continue
      }
      calculateDominance(data)
    }

    let totalPositioningScore = 0.0,
      blendedT = 0.0,
      overallAlphaMax = 0.0,
      alphaWeightedCursorScore = 0.0,
      alphaWeightedRayScore = 0.0

    const processBlendData = (data: CachedInteractableData) => {
      if (data.score <= 0 || data.targetingVisual === TargetingVisual.None) {
        return
      }

      const dominanceInfluence = 1.0 - maxDominanceFactor
      const finalScore = data.score * (data.dominanceFactor > 0 ? 1.0 : dominanceInfluence)
      if (finalScore <= 0) return

      totalPositioningScore += finalScore
      blendedT += data.targetT * finalScore

      const scale = data.coneRadiusAtT * INV_CONE_RADIUS
      const fadeStart = data.hotspotRadius * scale
      const fadeDistance = ALPHA_FADE_DISTANCE * scale
      let individualAlpha = 0.0

      if (fadeDistance > GEOMETRY_EPSILON) {
        const a = 1.0 - (data.radialDistance - fadeStart) / fadeDistance
        individualAlpha = a < 0 ? 0 : a > 1 ? 1 : a
      } else if (data.radialDistance <= fadeStart) {
        individualAlpha = 1.0
      }

      overallAlphaMax = Math.max(overallAlphaMax, individualAlpha)

      const alphaWeightedScore = finalScore * individualAlpha
      if (data.targetingVisual === TargetingVisual.Cursor) {
        alphaWeightedCursorScore += alphaWeightedScore
      } else if (data.targetingVisual === TargetingVisual.Ray) {
        alphaWeightedRayScore += alphaWeightedScore
      }
    }

    for (let i = 0; i < planeEntries.length; i++) {
      const {plane, data} = planeEntries[i]
      if (!data.isEligible) {
        continue
      }
      data.targetingVisual = plane.targetingVisual
      processBlendData(data)
    }
    for (let i = 0; i < interactableEntries.length; i++) {
      const {interactable, data} = interactableEntries[i]
      if (!data.isEligible) {
        continue
      }
      data.targetingVisual = this.getEffectiveTargetingVisual(interactable)
      processBlendData(data)
    }

    if (totalPositioningScore <= GEOMETRY_EPSILON) {
      return null
    }

    const finalT = blendedT / totalPositioningScore
    const overallAlpha = overallAlphaMax

    const totalAlphaWeightedScore = alphaWeightedCursorScore + alphaWeightedRayScore
    const rayInfluence =
      totalAlphaWeightedScore > GEOMETRY_EPSILON ? alphaWeightedRayScore / totalAlphaWeightedScore : 0.0

    const finalRayAlpha = overallAlpha * rayInfluence
    const finalCursorAlpha = overallAlpha * (1.0 - rayInfluence)

    this._blendResult.targetT = finalT
    this._blendResult.cursorAlpha = finalCursorAlpha
    this._blendResult.rayAlpha = finalRayAlpha
    return this._blendResult
  }
}
