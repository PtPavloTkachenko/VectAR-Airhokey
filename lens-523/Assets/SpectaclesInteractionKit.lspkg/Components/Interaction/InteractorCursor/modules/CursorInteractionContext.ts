import {Interactable} from "../../Interactable/Interactable"

export type DirectHitRecord = {
  interactable: Interactable
  position: vec3
}

/**
 * Holds short-lived state shared across CursorViewModel state-machine handlers:
 * the currently manipulated interactable and its locked-in local-space hit point.
 */
export class CursorInteractionContext {
  manipulationInteractable: Interactable | null = null
  manipulationHitLocal: vec3 | null = null

  get manipulatedInteractable(): Interactable | null {
    return this.manipulationInteractable
  }

  startManipulation(directHit: DirectHitRecord): void {
    const t = directHit.interactable.sceneObject.getTransform()
    this.manipulationInteractable = directHit.interactable
    this.manipulationHitLocal = t.getWorldTransform().inverse().multiplyPoint(directHit.position)
  }

  endManipulation(): void {
    this.manipulationInteractable = null
    this.manipulationHitLocal = null
  }

  updateManipulation(): vec3 | null {
    if (this.manipulationInteractable && this.manipulationHitLocal) {
      const t = this.manipulationInteractable.sceneObject.getTransform()
      return t.getWorldTransform().multiplyPoint(this.manipulationHitLocal)
    }
    return null
  }
}
