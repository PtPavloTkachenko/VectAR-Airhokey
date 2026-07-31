import {Interactable} from "../../Components/Interaction/Interactable/Interactable"
import {Interactor, InteractorInputType, InteractorTriggerType, TargetingMode} from "../Interactor/Interactor"

import {InteractionPlane} from "../../Components/Interaction/InteractionPlane/InteractionPlane"
import {Singleton} from "../../Decorators/Singleton"
import {ColliderUtils} from "../../Utils/ColliderUtils"
import {LensConfig} from "../../Utils/LensConfig"
import NativeLogger from "../../Utils/NativeLogger"
import {HandInteractor} from "../HandInteractor/HandInteractor"
import BaseInteractor from "../Interactor/BaseInteractor"
import {DispatchableEventArgs} from "../Interactor/InteractorEvent"
import {EventDispatcher} from "./EventDispatcher"

const TAG = "InteractionManager"

/**
 * Manages interactions between {@link Interactor} and {@link Interactable}, and
 * decides if events need to be transmitted to {@link Interactable}
 */
@Singleton
export class InteractionManager {
  public static getInstance: () => InteractionManager

  // Native Logging
  private log = new NativeLogger(TAG)

  private interactors = new Set<Interactor>()
  private _interactables = new Set<Interactable>()
  private _interactionPlanes = new Set<InteractionPlane>()

  public get interactables(): ReadonlySet<Interactable> {
    return this._interactables
  }

  public get interactionPlanes(): ReadonlySet<InteractionPlane> {
    return this._interactionPlanes
  }

  private interactableSceneObjects = new Map<SceneObject, Interactable>()
  private colliderToInteractableMap = new Map<ColliderComponent, Interactable>()
  private _parentPlaneMap = new Map<Interactable, InteractionPlane | null>()
  private _colliderToPlaneMap = new Map<ColliderComponent, InteractionPlane>()
  private eventDispatcher = new EventDispatcher(this.interactableSceneObjects)

  private _debugModeEnabled = false

  private updateDispatcher = LensConfig.getInstance().updateDispatcher

  private _multipleActiveCacheFrame: number = -1
  private _multipleActiveCache: boolean = false

  constructor() {
    this.defineScriptEvents()
  }

  /**
   * Adds an {@link Interactor} to the interaction manager's registry,
   * so it can be used to determine which {interactors} are interacting
   * with interactables.
   * @param interactor The {@link Interactor} to register.
   */
  registerInteractor(interactor: BaseInteractor): void {
    if (isNull(interactor)) {
      this.log.e("Cannot register null or uninitialized interactor.")
      return
    }

    if (this.debugModeEnabled) {
      interactor.drawDebug = this.debugModeEnabled
    }

    this.interactors.add(interactor)
    this.log.d(`Registered interactor "${interactor.sceneObject.name}"`)
  }

  /**
   * Removes an {@link Interactor} from the interaction manager's registry,
   * so that it will no longer be considered when determining which
   * interactors are interacting with interactables.
   * @param interactor The {@link Interactor} to deregister.
   */
  deregisterInteractor(interactor: BaseInteractor): void {
    if (isNull(interactor)) {
      this.log.e("Cannot deregister null or uninitialized interactor.")
      return
    }
    if (this.interactors.delete(interactor)) {
      this.log.d(`Deregistered interactor "${interactor.sceneObject.name}"`)
    }
  }

  /**
   * Returns all interactors of matching interactor type
   * @param inputType The {@link InteractorInputType} to filter interactors by.
   * @returns An array of interactors that match the input type.
   */
  getInteractorsByType(inputType: InteractorInputType): Interactor[] {
    const returnValue: Interactor[] = []
    this.interactors.forEach((interactor: Interactor) => {
      if ((interactor.inputType & inputType) !== 0) {
        returnValue.push(interactor)
      }
    })

    return returnValue
  }

  /**
   * Returns all interactors that are currently targeting
   * @returns An array of interactors that are targeting.
   */
  getTargetingInteractors(): Interactor[] {
    const returnValue: Interactor[] = []
    this.interactors.forEach((interactor: Interactor) => {
      if (interactor.isTargeting()) {
        returnValue.push(interactor)
      }
    })

    return returnValue
  }

  /**
   * Checks if there are multiple interactors that are both active and targeting.
   * Result is cached per frame.
   * @returns True if there are 2 or more active and targeting interactors.
   */
  hasMultipleActiveTargetingInteractors(): boolean {
    const frame = this.updateDispatcher.frameCount
    if (frame === this._multipleActiveCacheFrame) {
      return this._multipleActiveCache
    }
    this._multipleActiveCacheFrame = frame

    let count = 0
    for (const interactor of this.interactors) {
      if (interactor.isActive() && interactor.isTargeting()) {
        if (++count > 1) {
          this._multipleActiveCache = true
          return true
        }
      }
    }
    this._multipleActiveCache = false
    return false
  }

  /**
   * Adds an {@link InteractionPlane} to the interaction manager's registry,
   * so it can be used to determine which {interactors} are interacting
   * with interaction planes.
   * @param interactionPlane The {@link InteractionPlane} to register.
   */
  registerInteractionPlane(interactionPlane: InteractionPlane): void {
    if (isNull(interactionPlane)) {
      this.log.e("Cannot register null or uninitialized interaction plane.")
      return
    }
    this._interactionPlanes.add(interactionPlane)
    // Coarse-grained invalidation — acceptable because plane registration is infrequent
    // (setup time and enable/disable transitions, not per-frame).
    this._parentPlaneMap.clear()

    const collider = interactionPlane.collider
    if (collider !== null) {
      this._colliderToPlaneMap.set(collider, interactionPlane)
    }

    if (this.debugModeEnabled) {
      interactionPlane.drawDebug = true
    }

    this.log.d(`Registered interaction plane "${interactionPlane.sceneObject.name}"`)
  }

  /**
   * Removes an {@link InteractionPlane} from the interaction manager's registry.
   * @param interactionPlane The {@link InteractionPlane} to deregister.
   */
  deregisterInteractionPlane(interactionPlane: InteractionPlane): void {
    if (isNull(interactionPlane)) {
      this.log.e("Cannot deregister null or uninitialized interaction plane.")
      return
    }

    /*
     * When an Interactable is deregistered, check our list of Interactors and clear their current InteractionPlane
     * if it is the same as the InteractionPlane that was just deregistered
     */
    const handInteractors = this.getInteractorsByType(InteractorInputType.BothHands) as HandInteractor[]
    for (const handInteractor of handInteractors) {
      handInteractor.clearInteractionPlane(interactionPlane)
    }

    if (this._interactionPlanes.delete(interactionPlane)) {
      // Coarse-grained invalidation — see registerInteractionPlane comment.
      this._parentPlaneMap.clear()

      const collider = interactionPlane.collider
      if (collider !== null) {
        this._colliderToPlaneMap.delete(collider)
      }

      this.log.d(`Deregistered interaction plane "${interactionPlane.sceneObject.name}"`)
    }
  }

  /**
   * Adds an {@link Interactable} to the interaction manager's registry.
   * This registry helps speed up calculations when raycasting
   * objects in the scene.
   * @param interactable The {@link Interactable} to register.
   */
  registerInteractable(interactable: Interactable): void {
    if (isNull(interactable)) {
      this.log.e("Cannot register null or uninitialized interactable.")
      return
    }
    this._interactables.add(interactable)
    this.interactableSceneObjects.set(interactable.sceneObject, interactable)

    const colliders = this.findOrCreateColliderForInteractable(interactable)
    for (let i = 0; i < colliders.length; i++) {
      this.colliderToInteractableMap.set(colliders[i], interactable)
    }

    if (this.debugModeEnabled) {
      for (const collider of colliders) {
        collider.debugDrawEnabled = this.debugModeEnabled
      }
    }

    this.log.d(`Registered interactable "${interactable.sceneObject.name}" with ${colliders.length} colliders`)
  }

  /**
   * Removes an {@link Interactable} from the interaction manager's registry.
   * @param interactable The {@link Interactable} to deregister.
   */
  deregisterInteractable(interactable: Interactable): void {
    if (isNull(interactable)) {
      this.log.e("Cannot deregister null or uninitialized interactable.")
      return
    }

    /*
     * When an Interactable is deregistered, check our list of Interactors and clear their current Interactable
     * if it is the same as the Interactable that was just deregistered
     */
    for (const interactor of this.interactors) {
      if (interactor.currentInteractable !== null && interactable === interactor.currentInteractable) {
        interactor.clearCurrentInteractable()
      }
    }

    if (this._interactables.delete(interactable) && this.interactableSceneObjects.delete(interactable.sceneObject)) {
      this.log.d(`Deregistered interactable "${interactable.sceneObject.name}"`)
    }

    this._parentPlaneMap.delete(interactable)

    for (const collider of interactable.colliders) {
      this.colliderToInteractableMap.delete(collider)
      ColliderUtils.invalidateCacheEntry(collider)
    }
  }

  /**
   * Returns the nearest ancestor {@link InteractionPlane} for the given interactable,
   * or null if none exists. Results are lazily cached; the cache is invalidated when
   * an InteractionPlane is registered or deregistered.
   */
  getParentPlane(interactable: Interactable): InteractionPlane | null {
    let cached = this._parentPlaneMap.get(interactable)
    if (cached !== undefined) {
      return cached
    }
    if (isNull(interactable.sceneObject)) {
      return null
    }
    cached = interactable.sceneObject.getComponentInAncestors(
      InteractionPlane.getTypeName(),
      false,
      true
    ) as InteractionPlane | null
    this._parentPlaneMap.set(interactable, cached)
    return cached
  }

  /**
   * Returns the {@link InteractionPlane} whose collider matches the given collider,
   * or null if the collider does not belong to any registered InteractionPlane.
   * O(1) map lookup — no ancestor traversal needed.
   */
  getInteractionPlaneByCollider(collider: ColliderComponent): InteractionPlane | null {
    return this._colliderToPlaneMap.get(collider) ?? null
  }

  /**
   * Returns an {@link Interactable} by the collider attached to it.
   * This is an optimization to reduce expensive getComponent calls.
   * @param collider The {@link ColliderComponent} to filter interactables by.
   * @returns The interactable that matches the collider.
   */
  getInteractableByCollider(collider: ColliderComponent): Interactable | null {
    const interactable = this.colliderToInteractableMap.get(collider) ?? null
    if (!interactable) {
      return null
    }
    if (isNull(interactable.sceneObject)) {
      this.colliderToInteractableMap.delete(collider)
    }

    if (interactable?.sceneObject.enabled) {
      return interactable
    } else {
      return null
    }
  }

  /**
   * Returns the interactable of the passed {@link SceneObject}.
   * @param sceneObject The {@link SceneObject} to filter interactables by.
   * @returns The interactable that matches the scene object.
   */
  getInteractableBySceneObject(sceneObject: SceneObject): Interactable | null {
    const interactable = this.interactableSceneObjects.get(sceneObject) ?? null

    if (!interactable) {
      return null
    }

    if (isNull(interactable.sceneObject)) {
      this.interactableSceneObjects.delete(sceneObject)
    }

    return interactable
  }

  /**
   * @deprecated use `getInteractablesThatTarget(targetingMode) instead.`
   * @param targetingMode the targeting mode that the interactable(s) are configured to
   */
  getInteractablesByTargetingMode(targetingMode: TargetingMode): Interactable[] {
    return this.getInteractablesThatTarget(targetingMode)
  }

  /**
   * Returns all interactables that are set to the passed targeting mode.
   * @param targetingMode - {@link TargetingMode} to filter interactables by
   * @returns an array of interactables that match the targeting mode
   */
  getInteractablesThatTarget(targetingMode: TargetingMode): Interactable[] {
    const returnArray: Interactable[] = []
    this._interactables.forEach((interactable: Interactable) => {
      if ((interactable.targetingMode & targetingMode) !== 0) {
        returnArray.push(interactable)
      }
    })
    return returnArray
  }

  /**
   * Dispatches an event in 3 phases:
   * - Trickle-down: the event descends the hierarchy, from the first
   * interactable ancestor of the target to its parent
   * - Target: the event is sent to the target
   * - Bubble-up: the event ascends the hierarchy, from the target's parent
   * to its first interactable ancestor
   *
   * The {@link DispatchableEventArgs | eventArgs.origin} is not included in the propagation path and
   * the dispatch starts at {@link DispatchableEventArgs | eventArgs.origin} child.
   * @param eventArgs The event arguments to dispatch.
   */
  dispatchEvent(eventArgs: DispatchableEventArgs): void {
    this.eventDispatcher.dispatch(eventArgs)
  }

  set debugModeEnabled(enabled: boolean) {
    this._debugModeEnabled = enabled

    for (const interactor of this.interactors.keys()) {
      interactor.drawDebug = enabled
    }

    for (const collider of this.colliderToInteractableMap.keys()) {
      collider.debugDrawEnabled = enabled
    }

    for (const plane of this._interactionPlanes.keys()) {
      plane.drawDebug = enabled
    }
  }

  get debugModeEnabled(): boolean {
    return this._debugModeEnabled
  }

  private defineScriptEvents(): void {
    this.updateDispatcher.createUpdateEvent("InteractionManagerUpdateEvent").bind(() => this.update())
  }

  /**
   * Iterates through all the interactors, determine which interactables
   * are being interacted with, and send events to them
   */
  private update() {
    // Update interactors
    this.updateInteractors()

    // Process interactor events
    this.interactors.forEach((interactor) => this.processEvents(interactor))
  }

  private processEvents(interactor: Interactor) {
    if (!interactor.enabled) {
      /**
       * Check to see if we were triggering an interactable before
       * losing tracking / being disabled. If we were, send a cancel
       * event to keep the interactable up to date.
       */

      if (interactor.previousInteractable && !isNull(interactor.previousInteractable)) {
        if ((InteractorTriggerType.Select & interactor.previousTrigger) !== 0) {
          this.dispatchEvent({
            target: interactor.previousInteractable,
            interactor: interactor,
            eventName: "TriggerCanceled"
          })
        }

        // [Secondary Trigger] Cancel secondary trigger if the interactor was disabled mid-secondary-trigger.
        if (interactor.previousSecondaryTrigger !== InteractorTriggerType.None) {
          this.dispatchEvent({
            target: interactor.previousInteractable,
            interactor: interactor,
            eventName: "SecondaryTriggerCanceled"
          })
        }

        if ((interactor.inputType & interactor.previousInteractable.hoveringInteractor) !== 0) {
          this.dispatchEvent({
            target: interactor.previousInteractable,
            interactor: interactor,
            eventName: "HoverExit"
          })
        }
      }

      return
    }

    // Process events
    if (interactor.currentInteractable && !isNull(interactor.currentInteractable)) {
      this.processHoverEvents(interactor)

      // [Secondary Trigger] Skip primary trigger processing when secondary trigger is active.
      // On the frame the hold timer elapses, BaseInteractor.processSecondaryTriggerEvents() already
      // canceled the primary trigger (interactor-level), and processSecondaryTriggerEvents() below
      // dispatches TriggerCanceled + SecondaryTriggerStart to the Interactable.
      if (!interactor.isSecondaryTriggering) {
        this.processTriggerEvents(interactor)
      }

      // [Secondary Trigger] Dispatches SecondaryTriggerStart/Update/End/EndOutside to the Interactable
      // based on the interactor's currentSecondaryTrigger vs previousSecondaryTrigger state.
      this.processSecondaryTriggerEvents(interactor)
    } else if (interactor.previousInteractable) {
      if ((interactor.inputType & interactor.previousInteractable.hoveringInteractor) !== 0) {
        this.dispatchEvent({
          target: interactor.previousInteractable,
          interactor: interactor,
          eventName: "HoverExit"
        })
      }

      // If the interactor is no longer interacting with an interactable that it was previously interacting,
      // the trigger has been cancelled rather than ending fully.
      if (interactor.previousTrigger !== InteractorTriggerType.None) {
        this.dispatchEvent({
          target: interactor.previousInteractable,
          interactor: interactor,
          eventName: "TriggerCanceled"
        })
      }

      // [Secondary Trigger] Cancel secondary trigger if the Interactable was lost (disabled/destroyed)
      // while secondary trigger was active.
      if (interactor.previousSecondaryTrigger !== InteractorTriggerType.None) {
        this.dispatchEvent({
          target: interactor.previousInteractable,
          interactor: interactor,
          eventName: "SecondaryTriggerCanceled"
        })
      }
    }
  }

  private updateInteractors() {
    this.interactors.forEach((interactor: Interactor) => {
      interactor.updateState()

      const interactable = interactor.currentInteractable
      // Flush any disabled Interactables from Interactors.
      if (!isNull(interactable) && !(interactable?.sceneObject.isEnabledInHierarchy && interactable.enabled)) {
        interactor.clearCurrentInteractable()
      }

      if (interactor.currentInteractable !== interactor.previousInteractable) {
        interactor.currentInteractableChanged()
      }

      if (!interactor.isActive()) {
        /**
         * Check to see if we were triggering an interactable before
         * losing tracking / being disabled. If we were, send a cancel
         * event to keep the interactable up to date.
         */
        if (interactor.previousInteractable && !isNull(interactor.previousInteractable)) {
          if ((InteractorTriggerType.Select & interactor.previousTrigger) !== 0) {
            this.dispatchEvent({
              target: interactor.previousInteractable,
              interactor: interactor,
              eventName: "TriggerCanceled"
            })
          }

          // [Secondary Trigger] Cancel secondary trigger if the interactor lost tracking
          // (e.g. hand lost) while secondary trigger was active.
          if (interactor.previousSecondaryTrigger !== InteractorTriggerType.None) {
            this.dispatchEvent({
              target: interactor.previousInteractable,
              interactor: interactor,
              eventName: "SecondaryTriggerCanceled"
            })
          }

          if ((interactor.inputType & interactor.previousInteractable.hoveringInteractor) !== 0) {
            this.dispatchEvent({
              target: interactor.previousInteractable,
              interactor: interactor,
              eventName: "HoverExit"
            })
          }
        }
        return
      }
    })
  }

  private processHoverEvents(interactor: Interactor) {
    if (!interactor.currentInteractable || isNull(interactor.currentInteractable)) {
      return
    }

    // If first time targeted
    if (interactor.previousInteractable !== interactor.currentInteractable) {
      // Alert previous interactable that we've left it
      if (interactor.previousInteractable && !isNull(interactor.previousInteractable)) {
        if ((interactor.inputType & interactor.previousInteractable.hoveringInteractor) !== 0) {
          this.dispatchEvent({
            target: interactor.previousInteractable,
            interactor: interactor,
            eventName: "HoverExit"
          })
        }
      }

      this.dispatchEvent({
        target: interactor.currentInteractable,
        interactor: interactor,
        eventName: "HoverEnter"
      })
    } else {
      this.dispatchEvent({
        target: interactor.currentInteractable,
        interactor: interactor,
        eventName: "HoverUpdate"
      })
    }
  }

  private processTriggerEvents(interactor: Interactor) {
    if (!interactor.currentInteractable || isNull(interactor.currentInteractable)) {
      return
    }

    const previousTrigger = interactor.previousTrigger
    const currentTrigger = interactor.currentTrigger

    const eventArgs = {
      target: interactor.currentInteractable,
      interactor: interactor
    }

    if (previousTrigger === InteractorTriggerType.None && (InteractorTriggerType.Select & currentTrigger) !== 0) {
      this.dispatchEvent({
        ...eventArgs,
        eventName: "TriggerStart"
      })
    } else if (previousTrigger !== InteractorTriggerType.None && currentTrigger !== InteractorTriggerType.None) {
      const wasHoveringCurrentInteractable = interactor.wasHoveringCurrentInteractable
      const isHoveringCurrentInteractable = interactor.isHoveringCurrentInteractable

      // Whenever we detect a change in hover during a trigger, send HoverEnter and HoverExit events.
      if (isHoveringCurrentInteractable && !wasHoveringCurrentInteractable) {
        this.dispatchEvent({
          target: interactor.currentInteractable,
          interactor: interactor,
          eventName: "HoverEnter"
        })
      } else if (!isHoveringCurrentInteractable && wasHoveringCurrentInteractable) {
        this.dispatchEvent({
          target: interactor.currentInteractable,
          interactor: interactor,
          eventName: "HoverExit"
        })
      }

      this.dispatchEvent({
        ...eventArgs,
        eventName: "TriggerUpdate"
      })
    } else if (
      previousTrigger !== InteractorTriggerType.None &&
      // This check ensures that the interactor being in a 'triggering' state only invokes onTriggerEnd of an Interactable
      // if the trigger was actually applied to the Interactable in a previous update.
      !isNull(interactor.previousInteractable)
    ) {
      if (interactor.isHoveringCurrentInteractable) {
        this.dispatchEvent({
          ...eventArgs,
          eventName: "TriggerEnd",
          endedInsideInteractable: (interactor as BaseInteractor).endedInsideInteractable ?? undefined
        })
      } else {
        this.dispatchEvent({
          ...eventArgs,
          eventName: "TriggerEndOutside",
          endedInsideInteractable: (interactor as BaseInteractor).endedInsideInteractable ?? undefined
        })
      }
    }
  }

  /**
   * [Secondary Trigger] Mirrors processTriggerEvents() for the secondary trigger lifecycle.
   * Dispatches SecondaryTriggerStart/Update/End/EndOutside to the Interactable based on
   * the interactor's currentSecondaryTrigger vs previousSecondaryTrigger transition.
   *
   * On the start frame, also dispatches TriggerCanceled to the Interactable (on previousInteractable)
   * to formally end the primary trigger that was active before the hold timer elapsed.
   */
  private processSecondaryTriggerEvents(interactor: Interactor) {
    const previousSecondary = interactor.previousSecondaryTrigger
    const currentSecondary = interactor.currentSecondaryTrigger

    if (previousSecondary === InteractorTriggerType.None && currentSecondary === InteractorTriggerType.None) {
      return
    }

    // SecondaryTriggerStart: first cancel the primary trigger on the Interactable (the hold timer
    // just elapsed, so the primary trigger needs a formal TriggerCanceled), then dispatch
    // SecondaryTriggerStart to begin the secondary trigger lifecycle.
    if (previousSecondary === InteractorTriggerType.None && currentSecondary !== InteractorTriggerType.None) {
      // Dispatch TriggerCanceled on previousInteractable to end the primary trigger.
      // Uses previousInteractable because the primary trigger was started on that target.
      if (interactor.previousInteractable && !isNull(interactor.previousInteractable)) {
        this.dispatchEvent({
          target: interactor.previousInteractable,
          interactor: interactor,
          eventName: "TriggerCanceled"
        })
      }

      // Dispatch SecondaryTriggerStart on currentInteractable to begin secondary trigger.
      if (interactor.currentInteractable && !isNull(interactor.currentInteractable)) {
        this.dispatchEvent({
          target: interactor.currentInteractable,
          interactor: interactor,
          eventName: "SecondaryTriggerStart"
        })
      }
    }
    // SecondaryTriggerUpdate: secondary trigger held for another frame.
    else if (previousSecondary !== InteractorTriggerType.None && currentSecondary !== InteractorTriggerType.None) {
      if (interactor.currentInteractable && !isNull(interactor.currentInteractable)) {
        this.dispatchEvent({
          target: interactor.currentInteractable,
          interactor: interactor,
          eventName: "SecondaryTriggerUpdate"
        })
      }
    }
    // SecondaryTriggerEnd / SecondaryTriggerEndOutside: user released while secondary trigger was active.
    // Uses currentInteractable if available, falls back to previousInteractable.
    else if (previousSecondary !== InteractorTriggerType.None && currentSecondary === InteractorTriggerType.None) {
      const target = interactor.currentInteractable ?? interactor.previousInteractable
      if (target && !isNull(target)) {
        if (interactor.isHoveringCurrentInteractable) {
          this.dispatchEvent({
            target: target,
            interactor: interactor,
            eventName: "SecondaryTriggerEnd"
          })
        } else {
          this.dispatchEvent({
            target: target,
            interactor: interactor,
            eventName: "SecondaryTriggerEndOutside"
          })
        }
      }
    }
  }

  /**
   * Looks for colliders in the descendants of the param {@link Interactable}
   * if not collider is found, one is created.
   * @param interactable the interactable for which to find or create the collider
   * @returns an array of {@link ColliderComponent}
   */
  private findOrCreateColliderForInteractable(interactable: Interactable): ColliderComponent[] {
    let colliders = interactable.colliders
    const sceneObject = interactable.sceneObject
    if (colliders.length === 0) {
      colliders = this.findCollidersForSceneObject(sceneObject, colliders, true)
    }
    if (colliders.length === 0) {
      this.log.e(
        `No ColliderComponent in ${sceneObject.name}'s hierarchy. Creating temporary collider. Please create a ColliderComponent for this SceneObject.`
      )

      colliders.push(sceneObject.createComponent("Physics.ColliderComponent"))
    }
    interactable.colliders = colliders
    return colliders
  }

  /**
   * Finds all colliders in the descendants of an {@link SceneObject} with the following rules:
   * - If the current {@link SceneObject} is not root and has an {@link Interactable} component,
   * we stop the search as we do not want to associate this child's colliders.
   * - Else we accumulate all {@link ColliderComponent} and return them
   * @param sceneObject the {@link SceneObject} for which to look for colliders
   * - If some colliders are already registered
   * @param colliders the current array of colliders
   * @param isRoot whether the sceneObject is the root of the search
   * @returns an array of {@link ColliderComponent}
   */
  private findCollidersForSceneObject(
    sceneObject: SceneObject,
    colliders: ColliderComponent[],
    isRoot: boolean = false
  ): ColliderComponent[] {
    const interactable = sceneObject.getComponent(Interactable.getTypeName())

    if (interactable !== null && !isRoot) {
      return colliders
    }

    const foundColliders = sceneObject.getComponents("Physics.ColliderComponent")
    const collidersRegistered =
      foundColliders.find((collider: ColliderComponent) => this.colliderToInteractableMap.has(collider)) !== undefined

    if (collidersRegistered) {
      this.log.w(`Some colliders in ${sceneObject.name} were already registered with an Interactable object.`)
    }

    colliders.push(...foundColliders)

    const childrenCount = sceneObject.getChildrenCount()
    for (let i = 0; i < childrenCount; i++) {
      this.findCollidersForSceneObject(sceneObject.getChild(i), colliders)
    }

    return colliders
  }
}
