import {ColliderUtils} from "../../../../Utils/ColliderUtils"
import {CachedInteractableData, ConeOverlap, CONE_RADIUS, DebugCalculationState, MIN_LENGTH_THRESHOLD} from "./ConeOverlap"

// Debug overlays consider a cache stale if older than ~1 frame at 55fps.
const DEBUG_STALE_THRESHOLD_S = 1.0 / 55.0

/**
 * Owns all cursor debug-draw routines — cone wireframe, ray line, and per-target
 * cached calculation overlays. The parent class still owns the on/off boolean and
 * forwards through setEnabled().
 */
export class CursorDebugDraw {
  private enabled: boolean = false
  public debugPlaneLines: {intersection: vec3; closest: vec3}[] = []
  public debugColliderLines: {rayPoint: vec3; closest: vec3}[] = []

  constructor(private readonly cone: ConeOverlap) {}

  public setEnabled(value: boolean): void {
    this.enabled = value
  }

  public isEnabled(): boolean {
    return this.enabled
  }

  public clearLines(): void {
    this.debugPlaneLines.length = 0
    this.debugColliderLines.length = 0
  }

  public drawCone(segmentStart: vec3, segmentEnd: vec3): void {
    const CONE_LINE_COLOR = new vec4(1.0, 1.0, 0.0, 0.3)
    const axis = segmentEnd.sub(segmentStart)
    if (axis.length > MIN_LENGTH_THRESHOLD) {
      const rayDir = axis.normalize()
      const up = Math.abs(rayDir.dot(vec3.up())) < 0.99 ? vec3.up() : vec3.right()
      const right = rayDir.cross(up).normalize()
      const orthoUp = right.cross(rayDir).normalize()

      const segments = 16
      const angleStep = (Math.PI * 2) / segments

      for (let i = 0; i < segments; i++) {
        const angle = i * angleStep
        const x = Math.cos(angle) * CONE_RADIUS
        const y = Math.sin(angle) * CONE_RADIUS

        const p1 = segmentEnd.add(right.uniformScale(x)).add(orthoUp.uniformScale(y))

        global.debugRenderSystem.drawLine(segmentStart, p1, CONE_LINE_COLOR)

        const nextAngle = (i + 1) * angleStep
        const nextX = Math.cos(nextAngle) * CONE_RADIUS
        const nextY = Math.sin(nextAngle) * CONE_RADIUS
        const p2 = segmentEnd.add(right.uniformScale(nextX)).add(orthoUp.uniformScale(nextY))

        global.debugRenderSystem.drawLine(p1, p2, CONE_LINE_COLOR)
      }
    }
  }

  public drawRay(segmentStart: vec3, segmentEnd: vec3): void {
    const COLOR_RAY = new vec4(0.1, 0.7, 1.0, 1.0)
    global.debugRenderSystem.drawLine(segmentStart, segmentEnd, COLOR_RAY)
  }

  public drawCachedData(): void {
    const COLOR_CACHED = new vec4(0.85, 0.85, 0.85, 1.0)
    const COLOR_CHEAP = new vec4(0.2, 1.0, 0.2, 1.0)
    const COLOR_BLENDED = new vec4(1.0, 1.0, 0.2, 1.0)
    const COLOR_EXPENSIVE = new vec4(1.0, 0.2, 0.2, 1.0)
    const COLOR_BOUNDING_SPHERE = new vec4(0.6, 0.2, 1.0, 0.5)

    const currentTime = getTime()
    const drawDebugForData = (data: CachedInteractableData) => {
      if (data.score <= 0) return
      if (!data.debugState || !data.debugClosestPointOnRay || !data.debugClosestPointOnCollider) return
      let color = COLOR_CACHED
      if (Math.abs(currentTime - data.lastUpdated) < DEBUG_STALE_THRESHOLD_S) {
        switch (data.debugState) {
          case DebugCalculationState.Cheap:
            color = COLOR_CHEAP
            break
          case DebugCalculationState.Blended:
            color = COLOR_BLENDED
            break
          case DebugCalculationState.Expensive:
            color = COLOR_EXPENSIVE
            break
        }
      }
      global.debugRenderSystem.drawLine(data.debugClosestPointOnRay, data.debugClosestPointOnCollider, color)
      global.debugRenderSystem.drawSphere(data.debugClosestPointOnCollider, 0.5, color)
    }

    const planeEntries = this.cone.overlappingPlaneEntries
    const interactableEntries = this.cone.overlappingInteractableEntries

    for (let i = 0; i < planeEntries.length; i++) {
      drawDebugForData(planeEntries[i].data)
    }
    for (let i = 0; i < interactableEntries.length; i++) {
      drawDebugForData(interactableEntries[i].data)
    }

    for (let i = 0; i < interactableEntries.length; i++) {
      const {interactable, data} = interactableEntries[i]
      if (data.score <= 0) continue
      for (const collider of interactable.colliders || []) {
        const bs = ColliderUtils.getColliderWorldBoundingSphere(collider)
        if (bs) {
          global.debugRenderSystem.drawSphere(bs.center, bs.radius, COLOR_BOUNDING_SPHERE)
        }
      }
    }
  }
}
