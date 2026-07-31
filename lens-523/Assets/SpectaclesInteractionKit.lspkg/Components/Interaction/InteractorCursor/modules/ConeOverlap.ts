import {InteractionManager} from "../../../../Core/InteractionManager/InteractionManager"
import {TargetingMode} from "../../../../Core/Interactor/Interactor"
import {ColliderUtils} from "../../../../Utils/ColliderUtils"
import {IUpdateDispatcher} from "../../../../Utils/UpdateDispatcher"
import {Interactable, TargetingVisual} from "../../Interactable/Interactable"
import {InteractionPlane} from "../../InteractionPlane/InteractionPlane"

export const CONE_RADIUS = 220.0
export const INV_CONE_RADIUS = 1.0 / CONE_RADIUS
export const INTERACTABLE_FADE_HOTSPOT_RADIUS = 20.0
export const PLANE_FADE_HOTSPOT_RADIUS = 0.0
export const ALPHA_FADE_DISTANCE = 100.0
export const HIDE_ALPHA_THRESHOLD = 0.05
export const MIN_LENGTH_THRESHOLD = 1e-6
export const SCORE_DIVISOR_EPSILON = 1e-3
export const GEOMETRY_EPSILON = 1e-4
export const DOMINANCE_RADIUS = 1.0
export const DOMINANCE_FADE_WIDTH = 20.0
export const PLANE_SLOW_ZONE_DISTANCE = 10.0
export const PLANE_BLEND_ZONE_WIDTH = 5.0
export const PROXIMITY_HOT_ZONE_FACTOR = 2.0
export const PROXIMITY_NEAR_ZONE_FACTOR = 1.0
export const SMALL_SPHERE_RADIUS_THRESHOLD = 2.0

const CONE_OVERLAP_CHUNK_FACTOR = 0.5

export enum DebugCalculationState {
  None,
  Cheap,
  Blended,
  Expensive
}

export type CachedInteractableData = {
  score: number
  targetT: number
  radialDistance: number
  positionalDistance: number
  coneRadiusAtT: number
  hotspotRadius: number
  targetingVisual: number
  dominanceFactor: number
  lastUpdated: number
  lastSeenFrame: number
  isEligible: boolean
  debugState?: DebugCalculationState
  debugClosestPointOnRay?: vec3
  debugClosestPointOnCollider?: vec3
}

export type OverlappingInteractableEntry = {
  interactable: Interactable
  data: CachedInteractableData
}

export type OverlappingPlaneEntry = {
  plane: InteractionPlane
  data: CachedInteractableData
}

export type CachedPlaneTransform = {
  origin: vec3
  normal: vec3
  right: vec3
  up: vec3
  halfWidth: number
  halfHeight: number
}

/**
 * Owns the per-frame "what's in our cone" pass — cone overlap scan, plane caches,
 * and eligibility processing. Holds the canonical overlapping-target lists that
 * downstream scoring/blending consume.
 */
export class ConeOverlap {
  public readonly overlappingInteractableEntries: OverlappingInteractableEntry[] = []
  public readonly overlappingPlaneEntries: OverlappingPlaneEntry[] = []

  public cachedPlanes: InteractionPlane[] = []
  public planeCacheValid = false
  public planeEnabledResults: boolean[] = []
  public planeEligibleResults: boolean[] = []
  public planeTransformResults: (CachedPlaneTransform | null)[] = []

  private coneInteractables: Interactable[] = []
  private coneInteractablesIndex: number = 0

  private eligibilityProcessingList: Interactable[] = []
  private eligibilityProcessingIndex: number = 0

  // Scratch vector used inside getPlaneWorldOriginAndAxes / isPlaneInCone
  private readonly _scratchA = new vec3(0, 0, 0)
  private readonly _scratchD = new vec3(0, 0, 0)
  private readonly _scratchE = new vec3(0, 0, 0)

  constructor(
    private readonly interactionManager: InteractionManager,
    private readonly updateDispatcher: IUpdateDispatcher
  ) {}

  /**
   * Rebuilds cachedPlanes, planeEnabledResults, planeEligibleResults, and planeTransformResults
   * from the current scene state. Called only on frames that need a full plane scan (non-triggering).
   * On triggering frames this is skipped and isPlaneEnabled/isPlaneEligible fall back to direct
   * bridge crossings for the single queried plane, avoiding the cost of iterating all planes.
   */
  public refreshPlaneCaches(): void {
    this.cachedPlanes.length = 0
    for (const p of this.interactionManager.interactionPlanes) {
      this.cachedPlanes.push(p)
    }

    const planeCount = this.cachedPlanes.length
    this.planeEnabledResults.length = planeCount
    this.planeEligibleResults.length = planeCount
    this.planeTransformResults.length = planeCount
    for (let i = 0; i < planeCount; i++) {
      const p = this.cachedPlanes[i]
      const enabled = p.enabled && p.sceneObject.isEnabledInHierarchy
      this.planeEnabledResults[i] = enabled
      this.planeEligibleResults[i] = enabled && p.targetingVisual !== TargetingVisual.None
      this.planeTransformResults[i] = null
    }
  }

  public updateOverlappingPlanes(segmentStart: vec3, rayDir: vec3, rayLength: number): void {
    const tanConeAngle = rayLength > GEOMETRY_EPSILON ? CONE_RADIUS / rayLength : 0.0
    const currentFrame = this.updateDispatcher.frameCount

    for (let i = 0; i < this.cachedPlanes.length; i++) {
      const plane = this.cachedPlanes[i]
      if (!this.isPlaneEligible(plane)) {
        continue
      }

      if (this.isPlaneInCone(plane, segmentStart, rayDir, rayLength, tanConeAngle)) {
        const existingIdx = this.findOverlappingPlane(plane)
        if (existingIdx >= 0) {
          this.overlappingPlaneEntries[existingIdx].data.lastSeenFrame = currentFrame
        } else {
          this.overlappingPlaneEntries.push({
            plane,
            data: {
              score: 0,
              targetT: 0,
              radialDistance: Infinity,
              positionalDistance: Infinity,
              coneRadiusAtT: 0,
              hotspotRadius: 0,
              targetingVisual: TargetingVisual.Cursor,
              dominanceFactor: 0,
              lastUpdated: 0,
              lastSeenFrame: currentFrame,
              isEligible: true
            }
          })
        }
      }
    }

    for (let i = this.overlappingPlaneEntries.length - 1; i >= 0; i--) {
      if (this.overlappingPlaneEntries[i].data.lastSeenFrame !== currentFrame) {
        this.removeOverlappingPlaneAt(i)
      }
    }
  }

  public isPlaneInCone(
    plane: InteractionPlane,
    rayOrigin: vec3,
    rayDir: vec3,
    rayLength: number,
    tanConeAngle: number
  ): boolean {
    const {origin: planeCenter, halfWidth, halfHeight} = this.getPlaneWorldOriginAndAxes(plane)
    const planeRadiusSq = halfWidth * halfWidth + halfHeight * halfHeight

    const vecToCenter = this._scratchE
    vecToCenter.copyFrom(planeCenter)
    vecToCenter.subInPlace(rayOrigin)
    const toCenterDistSq = vecToCenter.dot(vecToCenter)

    const maxDim = Math.max(halfWidth, halfHeight)
    const planeRadiusUpperBound = maxDim * Math.SQRT2

    const maxDistance = rayLength + planeRadiusUpperBound
    if (toCenterDistSq > maxDistance * maxDistance) {
      return false
    }

    const distanceAlongAxis = vecToCenter.dot(rayDir)
    if (distanceAlongAxis < -planeRadiusUpperBound || distanceAlongAxis > rayLength + planeRadiusUpperBound) return false

    const coneRadiusAtPoint = distanceAlongAxis * tanConeAngle
    const distanceToAxisSq = toCenterDistSq - distanceAlongAxis * distanceAlongAxis

    if (distanceToAxisSq < coneRadiusAtPoint * coneRadiusAtPoint) {
      return true
    }

    const planeRadius = Math.sqrt(planeRadiusSq)
    const minSeparationSq = coneRadiusAtPoint * coneRadiusAtPoint + 2 * coneRadiusAtPoint * planeRadius + planeRadiusSq
    return distanceToAxisSq < minSeparationSq
  }

  public findOverlappingInteractable(interactable: Interactable): number {
    for (let i = 0; i < this.overlappingInteractableEntries.length; i++) {
      if (this.overlappingInteractableEntries[i].interactable === interactable) return i
    }
    return -1
  }

  public removeOverlappingInteractableAt(index: number): void {
    const entries = this.overlappingInteractableEntries
    const last = entries.length - 1
    if (index !== last) {
      entries[index] = entries[last]
    }
    entries.pop()
  }

  public findOverlappingPlane(plane: InteractionPlane): number {
    for (let i = 0; i < this.overlappingPlaneEntries.length; i++) {
      if (this.overlappingPlaneEntries[i].plane === plane) return i
    }
    return -1
  }

  public removeOverlappingPlaneAt(index: number): void {
    const entries = this.overlappingPlaneEntries
    const last = entries.length - 1
    if (index !== last) {
      entries[index] = entries[last]
    }
    entries.pop()
  }

  /**
   * Returns cached plane transform data (origin, axes, half-extents).
   * Offset is applied via in-place vec3 ops using scratch vectors to avoid allocations.
   */
  public getPlaneWorldOriginAndAxes(plane: InteractionPlane): CachedPlaneTransform {
    if (this.planeCacheValid) {
      for (let i = 0; i < this.cachedPlanes.length; i++) {
        if (this.cachedPlanes[i] === plane) {
          const cached = this.planeTransformResults[i]
          if (cached) return cached
          const result = this.computePlaneWorldOriginAndAxes(plane)
          this.planeTransformResults[i] = result
          return result
        }
      }
    }
    return this.computePlaneWorldOriginAndAxes(plane)
  }

  /**
   * Computes plane transform data (origin, axes, half-extents).
   * Offset is applied via in-place vec3 ops using scratch vectors to avoid allocations.
   */
  public computePlaneWorldOriginAndAxes(plane: InteractionPlane): CachedPlaneTransform {
    const planeXform = plane.cachedTransform
    const normal = planeXform.forward
    const right = planeXform.right
    const up = planeXform.up
    const scale = planeXform.getWorldScale()
    const origin = planeXform.getWorldPosition()
    const offset = plane.offset

    const s = this._scratchA

    s.copyFrom(right)
    s.uniformScaleInPlace(offset.x * scale.x)
    origin.addInPlace(s)

    s.copyFrom(up)
    s.uniformScaleInPlace(offset.y * scale.y)
    origin.addInPlace(s)

    s.copyFrom(normal)
    s.uniformScaleInPlace(offset.z * scale.z)
    origin.addInPlace(s)

    const halfWidth = Math.max(0, plane.planeSize.x * 0.5 * scale.x)
    const halfHeight = Math.max(0, plane.planeSize.y * 0.5 * scale.y)

    return {origin: origin, normal, right, up, halfWidth, halfHeight}
  }

  public isPlaneEnabled(plane: InteractionPlane | null): plane is InteractionPlane {
    if (!plane) return false
    if (!this.planeCacheValid) {
      return plane.enabled && plane.sceneObject.isEnabledInHierarchy
    }
    for (let i = 0; i < this.cachedPlanes.length; i++) {
      if (this.cachedPlanes[i] === plane) return this.planeEnabledResults[i]
    }
    return plane.enabled && plane.sceneObject.isEnabledInHierarchy
  }

  public isPlaneEligible(plane: InteractionPlane | null): plane is InteractionPlane {
    if (!plane) return false
    if (!this.planeCacheValid) {
      return plane.enabled && plane.sceneObject.isEnabledInHierarchy && plane.targetingVisual !== TargetingVisual.None
    }
    for (let i = 0; i < this.cachedPlanes.length; i++) {
      if (this.cachedPlanes[i] === plane) return this.planeEligibleResults[i]
    }
    return plane.enabled && plane.sceneObject.isEnabledInHierarchy && plane.targetingVisual !== TargetingVisual.None
  }

  public isInteractableEligible(interactable: Interactable | null): interactable is Interactable {
    if (
      isNull(interactable) ||
      !interactable ||
      !interactable.enabled ||
      interactable.targetingVisual === TargetingVisual.None ||
      (interactable.targetingMode & TargetingMode.Indirect) === 0 ||
      !interactable.sceneObject.isEnabledInHierarchy
    ) {
      return false
    }

    const parentPlane = this.interactionManager.getParentPlane(interactable)
    if (parentPlane) {
      if (!interactable.ignoreInteractionPlane && this.isPlaneEnabled(parentPlane)) {
        return false
      }
    }

    return true
  }

  public updateEligibilityCache(): void {
    if (this.eligibilityProcessingList.length === 0 && this.overlappingInteractableEntries.length > 0) {
      this.eligibilityProcessingList.length = 0
      for (let i = 0; i < this.overlappingInteractableEntries.length; i++) {
        this.eligibilityProcessingList.push(this.overlappingInteractableEntries[i].interactable)
      }
      this.eligibilityProcessingIndex = 0
    }

    const eligibleCount = this.eligibilityProcessingList.length
    if (eligibleCount === 0) {
      this.eligibilityProcessingIndex = 0
      return
    }

    if (this.eligibilityProcessingIndex >= eligibleCount) {
      this.eligibilityProcessingIndex = 0
    }

    const chunkSize = Math.max(1, Math.floor(Math.sqrt(eligibleCount)))

    for (let i = 0; i < chunkSize; i++) {
      if (this.eligibilityProcessingIndex >= this.eligibilityProcessingList.length) {
        break
      }

      const interactable = this.eligibilityProcessingList[this.eligibilityProcessingIndex]
      const idx = this.findOverlappingInteractable(interactable)

      if (idx >= 0) {
        this.overlappingInteractableEntries[idx].data.isEligible = this.isInteractableEligible(interactable)
        this.eligibilityProcessingIndex++
      } else {
        const lastIndex = this.eligibilityProcessingList.length - 1
        this.eligibilityProcessingList[this.eligibilityProcessingIndex] = this.eligibilityProcessingList[lastIndex]
        this.eligibilityProcessingList.pop()
      }
    }
  }

  public updateConeOverlap(rayStart: vec3, rayDir: vec3, rayLength: number): void {
    if (this.coneInteractablesIndex === 0) {
      const interactablesSet = this.interactionManager.interactables

      const setSize = interactablesSet.size
      if (this.coneInteractables.length !== setSize) {
        this.coneInteractables.length = setSize
      }

      let idx = 0
      for (const interactable of interactablesSet) {
        this.coneInteractables[idx++] = interactable
      }
    }

    const totalCount = this.coneInteractables.length
    const frameCount = this.updateDispatcher.frameCount
    const coneScale = rayLength > GEOMETRY_EPSILON ? CONE_RADIUS / rayLength : 0.0

    const chunkSize = Math.max(1, Math.floor(Math.sqrt(totalCount) * CONE_OVERLAP_CHUNK_FACTOR))
    let processedCount = 0

    while (processedCount < chunkSize && this.coneInteractablesIndex < totalCount) {
      const interactable = this.coneInteractables[this.coneInteractablesIndex]
      this.coneInteractablesIndex++
      processedCount++

      const existingIdx = this.findOverlappingInteractable(interactable)

      if (isNull(interactable) || !interactable.enabled) {
        if (existingIdx >= 0) this.removeOverlappingInteractableAt(existingIdx)
        continue
      }

      const collider = interactable.colliders && interactable.colliders.length > 0 ? interactable.colliders[0] : null
      if (isNull(collider)) {
        if (existingIdx >= 0) this.removeOverlappingInteractableAt(existingIdx)
        continue
      }

      const sphere = ColliderUtils.getColliderWorldBoundingSphere(collider!)
      if (!sphere) {
        if (existingIdx >= 0) this.removeOverlappingInteractableAt(existingIdx)
        continue
      }

      const center = sphere.center
      const radius = sphere.radius

      const toCenter = this._scratchD
      toCenter.copyFrom(center)
      toCenter.subInPlace(rayStart)
      const distSq = toCenter.dot(toCenter)

      const actualBroadPhaseThres = rayLength + radius
      const actualBroadPhaseThresSq = actualBroadPhaseThres * actualBroadPhaseThres

      if (distSq > actualBroadPhaseThresSq) {
        if (existingIdx >= 0) this.removeOverlappingInteractableAt(existingIdx)
        continue
      }

      const distOnAxis = toCenter.dot(rayDir)

      if (distOnAxis < -radius || distOnAxis > rayLength + radius) {
        if (existingIdx >= 0) this.removeOverlappingInteractableAt(existingIdx)
        continue
      }

      const coneRadiusAtDepth = distOnAxis * coneScale
      const perpDistSq = distSq - distOnAxis * distOnAxis
      const maxDist = coneRadiusAtDepth + radius

      if (perpDistSq < maxDist * maxDist) {
        if (!interactable.sceneObject.isEnabledInHierarchy) {
          if (existingIdx >= 0) this.removeOverlappingInteractableAt(existingIdx)
          continue
        }

        if (existingIdx >= 0) {
          this.overlappingInteractableEntries[existingIdx].data.lastSeenFrame = frameCount
        } else {
          this.overlappingInteractableEntries.push({
            interactable,
            data: {
              score: 0,
              targetT: 0,
              radialDistance: Infinity,
              positionalDistance: Infinity,
              coneRadiusAtT: 0,
              hotspotRadius: 0,
              targetingVisual: TargetingVisual.Cursor,
              dominanceFactor: 0,
              lastUpdated: 0,
              lastSeenFrame: frameCount,
              isEligible: false
            }
          })
          this.eligibilityProcessingList.push(interactable)
        }
      } else {
        if (existingIdx >= 0) this.removeOverlappingInteractableAt(existingIdx)
      }
    }

    if (this.coneInteractablesIndex >= totalCount) {
      this.coneInteractablesIndex = 0
    }
  }
}
