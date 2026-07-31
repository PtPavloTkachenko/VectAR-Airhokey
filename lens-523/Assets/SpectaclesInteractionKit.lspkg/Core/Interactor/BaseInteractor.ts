import {DragType, Interactor, InteractorInputType, InteractorTriggerType, TargetingMode} from "./Interactor"

import {Interactable} from "../../Components/Interaction/Interactable/Interactable"
import WorldCameraFinderProvider from "../../Providers/CameraProvider/WorldCameraFinderProvider"
import TargetProvider, {InteractableHitInfo} from "../../Providers/TargetProvider/TargetProvider"
import Event from "../../Utils/Event"
import {validate} from "../../Utils/validate"
import {InteractionManager} from "../InteractionManager/InteractionManager"
import {PokeTargetProvider} from "../Interactor/PokeTargetProvider"
import {DragProvider} from "./DragProvider"

/** Time (ms) the primary trigger must be held before secondary trigger activates. */
const DEFAULT_SECONDARY_TRIGGER_HOLD_THRESHOLD_MS = 800

/** Plane-distance threshold (cm) at the reference distance. */
const DEFAULT_SECONDARY_TRIGGER_PLANE_DISTANCE_THRESHOLD_CM = 2.5

/** Distance (cm) at which the plane-distance threshold is defined without scaling. */
const DEFAULT_SECONDARY_TRIGGER_REFERENCE_DISTANCE_CM = 110.0

/** Floor multiplier -- prevents threshold from shrinking too much at close range. */
const DEFAULT_SECONDARY_TRIGGER_MIN_DISTANCE_SCALE = 0.5

/** Ceiling multiplier -- prevents threshold from growing too large at far range. */
const DEFAULT_SECONDARY_TRIGGER_MAX_DISTANCE_SCALE = 3.0

/** Minimum vector length to treat as non-degenerate (avoids divide-by-zero on normalize). */
const NEAR_ZERO_LENGTH_EPSILON = 1e-3

const HOLD_DEBUG_ZONE_COLOR = new vec4(1, 0.1, 0.1, 0.8)
const HOLD_DEBUG_ZONE_ACTIVE_COLOR = new vec4(0.2, 1, 0.4, 0.8)
const HOLD_DEBUG_DRIFT_SAFE_COLOR = new vec4(0.3, 1, 0.3, 0.9)
const HOLD_DEBUG_DRIFT_WARN_COLOR = new vec4(1, 0.6, 0, 0.9)
const HOLD_DEBUG_DRIFT_DANGER_COLOR = new vec4(1, 0.15, 0.15, 0.9)
const HOLD_DEBUG_PROGRESS_BG_COLOR = new vec4(0.3, 0.3, 0.3, 0.5)
const HOLD_DEBUG_PROGRESS_FG_COLOR = new vec4(1, 0.9, 0, 1)
const HOLD_DEBUG_HIT_COLOR = new vec4(1, 1, 1, 0.8)
const HOLD_DEBUG_CIRCLE_SEGMENTS = 32

/**
 * Defines API for {@link Interactor} type
 */
export default abstract class BaseInteractor extends BaseScriptComponent implements Interactor {
  /**
   * @internal
   * The maximum distance at which the interactor can target interactables.
   */
  _maxRaycastDistance: number = 500

  /**
   * @internal
   * A multiplier applied to spherecast radii when using indirect targeting. Larger values create wider targeting
   * areas, making it easier to target objects at the expense of precision. Smaller values provide more precise
   * targeting.
   */
  indirectTargetingVolumeMultiplier: number = 1

  /**
   * @internal
   * Should use spherecast for targeting when raycast does not register a hit.
   */
  sphereCastEnabled: boolean = false

  /**
   * @internal
   * Defines the radii (in cm) used for progressive spherecasting when raycast fails to hit a target. Used in
   * sequence with spherecastDistanceThresholds to perform increasingly larger sphere casts until a target is found.
   * Smaller radii provide more precise targeting while larger radii help target small or distant objects. Must have the
   * same array length as spherecastDistanceThresholds.
   */
  spherecastRadii: number[] = [0.5, 2.0, 4.0]

  /**
   * @internal
   * Defines distance offsets (in cm) from the ray origin for performing sphere casts. Each value creates a sphere
   * cast starting point at [ray origin + (direction * offset)]. Used in sequence with spherecastRadii, with the system
   * trying progressively larger sphere casts until a target is found. Helps improve targeting of small or distant
   * objects. Must have the same array length as spherecastRadii.
   */
  spherecastDistanceThresholds: number[] = [0, 12, 30]

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Drag Configuration</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Configure drag sensitivity for indirect (raycast) interactions</span>'
  )

  /**
   * Controls the minimum distance (in cm) the hand must move during indirect interaction to be considered a drag.
   * When the distance between the interaction origin position and current position exceeds this threshold, dragging
   * behavior is detected and tracked. Lower values make dragging more sensitive and easier to trigger, while higher
   * values require more deliberate movement before dragging begins.
   */
  @input
  @label("Indirect Drag Threshold")
  @hint(
    "Controls the minimum distance (in cm) the hand must move during indirect interaction to be considered a drag. \
When the distance between the interaction origin position and current position exceeds this threshold, dragging \
behavior is detected and tracked. Lower values make dragging more sensitive and easier to trigger, while higher \
values require more deliberate movement before dragging begins."
  )
  protected indirectDragThreshold: number = 10.0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Debug</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Visual debugging options for development</span>')

  /**
   * Should draw gizmos for visual debugging.
   */
  @input
  @label("Draw Debug")
  @hint(
    "When enabled, draws debug gizmos in the scene to visualize raycasts, colliders, and other interactor geometry. \
Useful for troubleshooting targeting issues during development."
  )
  _drawDebug: boolean = false

  // Dependencies injection
  protected interactionManager = InteractionManager.getInstance()

  protected _dragProvider = new DragProvider(this.indirectDragThreshold)

  // To allow the planecast drag vector to always be available for 1:1 usage, the threshold should be 0.
  protected _planecastDragProvider = new DragProvider(0)

  protected set inputType(inputType: InteractorInputType) {
    this._inputType = inputType
  }

  /**
   * Defines the interactor's input type. This can be used for prioritization
   * or for discerning controller vs hands.
   */
  get inputType(): InteractorInputType {
    return this._inputType
  }

  protected set currentInteractable(interactable: Interactable | null) {
    this._currentInteractable = interactable
  }

  /**
   * Returns the current targeted interactable or null.
   */
  get currentInteractable(): Interactable | null {
    return this._currentInteractable
  }

  protected set previousInteractable(interactable: Interactable | null) {
    this._previousInteractable = interactable
  }

  /**
   * Returns the previous targeted interactable or null.
   */
  get previousInteractable(): Interactable | null {
    return this._previousInteractable
  }

  private onCurrentInteractableChangedEvent = new Event<Interactable | null>()

  /**
   * Called whenever the Interactor changes the target Interactable
   */
  onCurrentInteractableChanged = this.onCurrentInteractableChangedEvent.publicApi()

  private onTriggerStartEvent = new Event<Interactable | null>()
  private onTriggerUpdateEvent = new Event<Interactable | null>()
  private onTriggerEndEvent = new Event<Interactable | null>()
  private onTriggerCanceledEvent = new Event<Interactable | null>()

  /**
   * Called whenever the Interactor enters the triggered state (regardless of if there is a target or not).
   */
  onTriggerStart = this.onTriggerStartEvent.publicApi()

  /**
   * Called whenever the Interactor remains in the triggered state (regardless of if there is a target or not).
   */
  onTriggerUpdate = this.onTriggerUpdateEvent.publicApi()

  /**
   * Called whenever the Interactor exits the triggered state (regardless of if there is a target or not).
   */
  onTriggerEnd = this.onTriggerEndEvent.publicApi()

  /**
   * Called whenever the Interactor is lost and was in a triggered state (regardless of if there is a target or not).
   */
  onTriggerCanceled = this.onTriggerCanceledEvent.publicApi()

  private onSecondaryTriggerStartEvent = new Event<Interactable | null>()
  private onSecondaryTriggerUpdateEvent = new Event<Interactable | null>()
  private onSecondaryTriggerEndEvent = new Event<Interactable | null>()
  private onSecondaryTriggerCanceledEvent = new Event<Interactable | null>()

  /**
   * Called whenever the Interactor enters the secondary triggered state (regardless of if there is a target or not).
   */
  onSecondaryTriggerStart = this.onSecondaryTriggerStartEvent.publicApi()

  /**
   * Called whenever the Interactor remains in the secondary triggered state (regardless of if there is a target or not).
   */
  onSecondaryTriggerUpdate = this.onSecondaryTriggerUpdateEvent.publicApi()

  /**
   * Called whenever the Interactor exits the secondary triggered state (regardless of if there is a target or not).
   */
  onSecondaryTriggerEnd = this.onSecondaryTriggerEndEvent.publicApi()

  /**
   * Called whenever the Interactor is lost and was in a secondary triggered state (regardless of if there is a target or not).
   */
  onSecondaryTriggerCanceled = this.onSecondaryTriggerCanceledEvent.publicApi()

  /**
   * Returns if the Interactor is in some generic triggering state in the current frame.
   */
  get isTriggering(): boolean {
    return this.currentTrigger !== InteractorTriggerType.None
  }

  /**
   * Returns if the Interactor was in some generic triggering state in the previous frame.
   */
  get wasTriggering(): boolean {
    return this.previousTrigger !== InteractorTriggerType.None
  }

  /**
   * Returns if the Interactor is in a secondary triggering state in the current frame.
   */
  get isSecondaryTriggering(): boolean {
    return this._currentSecondaryTrigger !== InteractorTriggerType.None
  }

  /**
   * Returns if the Interactor was in a secondary triggering state in the previous frame.
   */
  get wasSecondaryTriggering(): boolean {
    return this._previousSecondaryTrigger !== InteractorTriggerType.None
  }

  /**
   * Returns the normalized progress (0-1) of the secondary trigger hold timer.
   * 0 when inactive, increases to 1 as the hold threshold is reached.
   */
  get holdTimerProgress(): number {
    return this._holdTimerProgress
  }

  protected set previousTrigger(trigger: InteractorTriggerType) {
    this._previousTrigger = trigger
  }

  /**
   * Returns the previous trigger value
   */
  get previousTrigger(): InteractorTriggerType {
    return this._previousTrigger
  }

  protected set currentTrigger(trigger: InteractorTriggerType) {
    this._currentTrigger = trigger
  }
  /**
   * Returns the current trigger value
   */
  get currentTrigger(): InteractorTriggerType {
    return this._currentTrigger
  }

  protected set previousSecondaryTrigger(trigger: InteractorTriggerType) {
    this._previousSecondaryTrigger = trigger
  }

  /**
   * Returns the previous secondary trigger value
   */
  get previousSecondaryTrigger(): InteractorTriggerType {
    return this._previousSecondaryTrigger
  }

  protected set currentSecondaryTrigger(trigger: InteractorTriggerType) {
    this._currentSecondaryTrigger = trigger
  }

  /**
   * Returns the current secondary trigger value
   */
  get currentSecondaryTrigger(): InteractorTriggerType {
    return this._currentSecondaryTrigger
  }

  _currentDragVector: vec3 | null = null

  protected set previousDragVector(dragVector: vec3 | null) {
    this._previousDragVector = dragVector
  }
  /**
   * Returns the nullable drag vector, computed in the
   * previous frame
   */
  get previousDragVector(): vec3 | null {
    return this._previousDragVector
  }

  protected _previousStartPoint: vec3 | null = null

  private _inputType = InteractorInputType.None
  private _currentInteractable: Interactable | null = null
  private _previousInteractable: Interactable | null = null
  private _previousTrigger = InteractorTriggerType.None
  private _currentTrigger = InteractorTriggerType.None
  private _previousDragVector: vec3 | null = null

  private _previousSecondaryTrigger = InteractorTriggerType.None
  private _currentSecondaryTrigger = InteractorTriggerType.None

  protected cameraProvider = WorldCameraFinderProvider.getInstance()

  // Hold timer state for secondary trigger activation.
  // _holdPlanePoint, _holdPlaneNormal, _holdStartPlaneHit are pre-allocated
  // and rewritten via copyFrom on each timer start — no per-start allocations.
  protected _holdStartTime: number | null = null
  protected readonly _holdPlanePoint: vec3 = vec3.zero()
  protected readonly _holdPlaneNormal: vec3 = vec3.zero()
  protected readonly _holdStartPlaneHit: vec3 = vec3.zero()
  protected _holdPlaneValid: boolean = false
  protected _holdTargetInteractable: Interactable | null = null
  protected _holdTimerActive: boolean = false
  protected _holdTriggerType: InteractorTriggerType = InteractorTriggerType.None
  private _holdTimerProgress: number = 0

  // Scratch vectors for hold timer math — reused per frame, never returned.
  private readonly _scratchPlaneOp = vec3.zero()
  private readonly _scratchRayResult = vec3.zero()
  private readonly _scratchProject = vec3.zero()

  /**
   * Time in milliseconds that the primary trigger must be held within the
   * plane-distance threshold before secondary trigger activates.
   */
  secondaryTriggerHoldThreshold: number = DEFAULT_SECONDARY_TRIGGER_HOLD_THRESHOLD_MS

  /**
   * Distance threshold (in cm) on the Interactable's plane from the initial
   * hit point. If the current intersection moves beyond this distance,
   * the hold timer is aborted. Measured at the reference distance.
   */
  secondaryTriggerPlaneDistanceThreshold: number = DEFAULT_SECONDARY_TRIGGER_PLANE_DISTANCE_THRESHOLD_CM

  /**
   * The reference distance (in cm) at which the plane-distance threshold
   * is defined. The effective threshold scales linearly with the ratio
   * of actual distance to this reference distance.
   */
  secondaryTriggerReferenceDistance: number = DEFAULT_SECONDARY_TRIGGER_REFERENCE_DISTANCE_CM

  /**
   * Minimum scaling multiplier for the plane-distance threshold.
   * Prevents the threshold from becoming too small at close range.
   */
  secondaryTriggerMinDistanceScale: number = DEFAULT_SECONDARY_TRIGGER_MIN_DISTANCE_SCALE

  /**
   * Maximum scaling multiplier for the plane-distance threshold.
   * Prevents the threshold from becoming too large at far range.
   */
  secondaryTriggerMaxDistanceScale: number = DEFAULT_SECONDARY_TRIGGER_MAX_DISTANCE_SCALE

  constructor() {
    super()

    this.interactionManager.registerInteractor(this)
    this.createEvent("OnDestroyEvent").bind(() => this.release())
  }

  private release(): void {
    this.interactionManager.deregisterInteractor(this)
  }

  /**
   * Updates the targeting and trigger state of the interactor
   */
  updateState(): void {
    this.previousInteractable = this.currentInteractable
    this.previousTrigger = this.currentTrigger
    this.previousSecondaryTrigger = this.currentSecondaryTrigger
    this.previousDragVector = this.currentDragVector
    this._previousStartPoint = this.startPoint

    // These values need to be cached to differently because the target provider's set is only updated during
    // the lateUpdate of the frame, but updateState is called during the update of the frame.
    this._wasHoveringCurrentInteractable = this._isHoveringCurrentInteractable
    this._isHoveringCurrentInteractable = this.isHoveringCurrentInteractable

    this.currentInteractable = null
  }

  /**
   * Disables or enables the input powering this interactor
   * @param enabled whether the input powering the interactor should be enabled
   */
  setInputEnabled(_enabled: boolean): void {}

  /**
   * Clears the current Interactable, used when an Interactable is deleted at runtime
   */
  clearCurrentInteractable(): void {
    this.currentInteractable = null
    this.clearCurrentHitInfo()
  }

  /**
   * Returns the point where the interactor's ray starts.
   */
  abstract get startPoint(): vec3 | null

  /**
   * Returns the point where the interactor's ray ends.
   */
  abstract get endPoint(): vec3 | null

  /**
   * Returns the delta start position from previous frame
   */
  get deltaStartPosition(): vec3 | null {
    if (this.startPoint === null || this._previousStartPoint === null) {
      return null
    }
    return this.startPoint.sub(this._previousStartPoint)
  }

  /**
   * Returns the direction the interactor's ray is pointing toward.
   */
  abstract get direction(): vec3 | null

  /**
   * Returns the orientation of the interactor
   */
  abstract get orientation(): quat | null

  /**
   * @deprecated in favor of using targetHitInfo
   * Returns the distance to the current target in cm
   */
  abstract get distanceToTarget(): number | null

  /**
   * @deprecated in favor of using targetHitInfo
   * Returns the point at which the interactor intersected the current target
   */
  abstract get targetHitPosition(): vec3 | null

  /**
   * Returns the {@link InteractableHitInfo} describing the intersection with the current target
   * This includes information such as the intersection position/normal, the Interactable, the collider, etc
   */
  abstract get targetHitInfo(): InteractableHitInfo | null

  /**
   * Returns the maximum raycast length for world targeting in cm
   */
  abstract get maxRaycastDistance(): number

  /**
   * Returns the targeting mode used to obtain the targeted interactable
   */
  abstract get activeTargetingMode(): TargetingMode

  /**
   * Returns a normalized value from 0-1, where 0 is the lowest strength and
   * 1 the highest.
   * Returns null if the strength cannot be computed.
   */
  abstract get interactionStrength(): number | null

  /**
   * Returns true if the interaction ended inside the Interactable it started in. Updated when an interaction ends.
   */
  get endedInsideInteractable() {
    return this._endedInsideInteractable
  }
  private _endedInsideInteractable: boolean | null = null

  private interactionStartedInteractable: Interactable | null = null

  protected _wasHoveringCurrentInteractable: boolean | null = null
  protected _isHoveringCurrentInteractable: boolean | null = null

  /**
   * Returns true if the Interactor was hovering the current Interactable in the previous frame.
   */
  get wasHoveringCurrentInteractable(): boolean | null {
    return this._wasHoveringCurrentInteractable
  }

  /**
   * Returns true if the Interactor is hovering the current Interactable in the current frame.
   */
  abstract get isHoveringCurrentInteractable(): boolean | null

  /**
   * Returns a list of Interactables that the Interactor is hovering (targeting ray intersects w/ Interactable's collider).
   */
  abstract get hoveredInteractables(): Interactable[]

  /**
   * Returns true if the Interactor is hovering over the given Interactable.
   * An Interactor can hover over multiple overlapping Interactables at once, but only the most
   * deeply nested Interactable will receive the official onHover events.
   *
   * This is useful for creating custom behaviors when receiving onHoverEnter/Exit events during trigger.
   *
   * @param interactable - the Interactable to check for
   */
  abstract isHoveringInteractable(interactable: Interactable): boolean

  /**
   * Returns true if the Interactor is hovering over the given Interactable or any of its Interactable descendants.
   * An Interactor can hover over multiple overlapping Interactables at once, but only the most
   * deeply nested Interactable will receive the official onHover events.
   *
   * This is useful for creating custom behaviors when receiving onHoverEnter/Exit events during trigger.
   *
   * @param interactable - the Interactable to check for
   */
  abstract isHoveringInteractableHierarchy(interactable: Interactable): boolean

  protected handleSelectionLifecycle(targetProvider: TargetProvider): void {
    // Special case for Poke, always considered inside
    if (targetProvider instanceof PokeTargetProvider) {
      this._endedInsideInteractable = true
      this.interactionStartedInteractable = null
      return
    }

    const wasSelected = (this.previousTrigger & InteractorTriggerType.Select) !== 0
    const isSelected = (this.currentTrigger & InteractorTriggerType.Select) !== 0

    // Handle selection end
    if (wasSelected && !isSelected) {
      if (this.interactionStartedInteractable !== null) {
        this._endedInsideInteractable =
          targetProvider?.isHoveringInteractable(this.interactionStartedInteractable) ?? false

        this.interactionStartedInteractable = null
      }
    }
    // Handle selection start
    else if (!wasSelected && isSelected) {
      this.interactionStartedInteractable = targetProvider?.currentInteractableHitInfo?.interactable ?? null
    } else {
      this._endedInsideInteractable = null
    }
  }

  /**
   * Returns true if the interactor is actively targeting
   */
  abstract isTargeting(): boolean

  /**
   * Returns true if the interactor is active
   */
  abstract isActive(): boolean

  protected abstract clearCurrentHitInfo(): void

  get dragProvider(): DragProvider {
    return this._dragProvider
  }

  set dragProvider(provider: DragProvider | undefined) {
    validate(provider)
    this._dragProvider = provider
  }

  protected get planecastDragProvider(): DragProvider {
    return this._planecastDragProvider
  }

  protected set currentDragVector(dragVector: vec3 | null) {
    this._currentDragVector = dragVector
  }

  /**
   * Returns the current vector associated to a dragging
   * movement since the last frame, and null if not dragging
   */
  get currentDragVector(): vec3 | null {
    return this._currentDragVector
  }

  /**
   * @returns the drag vector projected onto the plane defined by the current Interactable's forward and origin
   */
  get planecastDragVector(): vec3 | null {
    return this.planecastDragProvider.currentDragVector
  }

  protected clearDragProviders(): void {
    this.dragProvider.clear()
    this.planecastDragProvider.clear()
  }

  protected updateDragVector(): void {
    if ((this.currentTrigger & InteractorTriggerType.Select) !== 0) {
      this.currentDragVector = this.dragProvider.getDragVector(
        this.getDragPoint(),
        this.currentInteractable?.enableInstantDrag ?? null
      )

      this.planecastDragProvider.getDragVector(this.planecastPoint, this.currentInteractable?.enableInstantDrag ?? null)
    } else {
      this.currentDragVector = null
      this.clearDragProviders()
    }
  }

  protected getDragPoint(): vec3 | null {
    return this.endPoint
  }

  get planecastPoint(): vec3 | null {
    return this.raycastPlaneIntersection(this.currentInteractable)
  }

  /**
   * Used to define the type of drag vector that the interactor is invoking.
   * By default, interactor drag vectors will be as SixDof drags.
   */
  get dragType(): DragType | null {
    if (this.currentDragVector !== null) {
      return DragType.SixDof
    }

    return null
  }

  /**
   * Set if the Interactor is should draw a debug gizmo of collider/raycasts in the scene.
   */
  abstract set drawDebug(debug: boolean)

  /**
   * @returns if the Interactor is currently drawing a debug gizmo of collider/raycasts in the scene.
   */
  abstract get drawDebug(): boolean

  /**
   * Calculates the intersection of the Interactor's indirect raycast and the plane defined by the Interactable's forward vector / origin
   * @param interactable - the Interactable used to define the plane of intersection
   * @returns the intersection point of the indirect raycast and plane
   */
  public raycastPlaneIntersection(interactable: Interactable | null): vec3 | null {
    const origin = this.startPoint
    const direction = this.direction

    if (origin === null || direction === null || interactable === null) {
      return null
    }

    // t = ((p0-l0)·n)/(l·n),  intersection = l0 + l*t
    const transform = interactable.sceneObject.getTransform()
    const normal = transform.forward

    const originToPlane = transform.getWorldPosition()
    originToPlane.subInPlace(origin)

    const parametricValue = originToPlane.dot(normal) / direction.dot(normal)

    const intersection = direction.uniformScale(parametricValue)
    intersection.addInPlace(origin)
    return intersection
  }

  /**
   * Projects the direct collider's position onto the plane defined by the Interactable's forward vector / origin
   * @param interactable - the Interactable used to define the plane of intersection
   * @returns the direct collider's position projected onto the plane
   */
  public colliderPlaneIntersection(interactable: Interactable | null): vec3 | null {
    return this.positionPlaneIntersection(interactable, this.endPoint)
  }

  /**
   * Projects the given position onto the plane defined by the Interactable's forward vector / origin
   * @param interactable - the Interactable used to define the plane of intersection
   * @param position - the world position to project onto the plane
   * @returns the direct collider's position projected onto the plane
   */
  public positionPlaneIntersection(interactable: Interactable | null, position: vec3 | null): vec3 | null {
    const origin = position

    if (origin === null || interactable === null) {
      return null
    }

    // t = ((p0-l0)·n)/(n·n),  intersection = l0 + n*t
    const transform = interactable.sceneObject.getTransform()
    const normal = transform.forward

    const originToPlane = transform.getWorldPosition()
    originToPlane.subInPlace(origin)

    const parametricValue = originToPlane.dot(normal) / normal.dot(normal)

    const intersection = normal.uniformScale(parametricValue)
    intersection.addInPlace(origin)
    return intersection
  }

  /**
   * Notifies that the Interactor has changed target Interactable
   */
  currentInteractableChanged = (): void => {
    if (this.currentInteractable !== this.previousInteractable) {
      this._wasHoveringCurrentInteractable = false
      this.onCurrentInteractableChangedEvent.invoke(this.currentInteractable)
    }
  }

  /**
   * Process the new currentTrigger and compare to previousTrigger to see what event to propagate.
   */
  protected processTriggerEvents() {
    if (!this.isActive()) {
      if ((InteractorTriggerType.Select & this.previousTrigger) !== 0) {
        this.onTriggerCanceledEvent.invoke(this.currentInteractable)
      }
    } else {
      if (
        this.previousTrigger === InteractorTriggerType.None &&
        (InteractorTriggerType.Select & this.currentTrigger) !== 0
      ) {
        this.onTriggerStartEvent.invoke(this.currentInteractable)
      } else if (this.previousTrigger === this.currentTrigger && this.currentTrigger !== InteractorTriggerType.None) {
        this.onTriggerUpdateEvent.invoke(this.currentInteractable)
      } else if (this.previousTrigger !== InteractorTriggerType.None) {
        this.onTriggerEndEvent.invoke(this.currentInteractable)
      }
    }
  }

  /**
   * Resets all hold timer state back to inactive defaults.
   * Called when the hold timer is aborted (drift exceeded, hover lost) or
   * when the primary trigger ends while a secondary trigger is active.
   */
  protected resetHoldTimer(): void {
    this._holdStartTime = null
    this._holdTargetInteractable = null
    this._holdTimerActive = false
    this._holdPlaneValid = false
    this._holdTriggerType = InteractorTriggerType.None
    this._holdTimerProgress = 0
  }

  /**
   * Intersects the interactor's ray with an arbitrary plane defined by a point and normal.
   * Used for the hold timer's plane-distance check, where the plane is anchored at
   * the initial hit position rather than the Interactable's origin.
   *
   * @returns a scratch vector — do not store the reference. Consume immediately or clone.
   */
  private rayPlaneIntersection(planePoint: vec3, planeNormal: vec3): vec3 | null {
    const origin = this.startPoint
    const dir = this.direction

    if (origin === null || dir === null) {
      return null
    }

    const denom = dir.dot(planeNormal)
    if (Math.abs(denom) < 1e-6) {
      return null
    }

    this._scratchPlaneOp.copyFrom(planePoint)
    this._scratchPlaneOp.subInPlace(origin)
    const t = this._scratchPlaneOp.dot(planeNormal) / denom

    this._scratchRayResult.copyFrom(dir)
    this._scratchRayResult.uniformScaleInPlace(t)
    this._scratchRayResult.addInPlace(origin)
    return this._scratchRayResult
  }

  /**
   * Projects a world-space point onto the current hold plane defined by
   * _holdPlanePoint and _holdPlaneNormal. Returns null if the hold plane
   * has not been established.
   *
   * @returns a scratch vector (_scratchProject) — do not store the reference.
   *          Use immediately or copyFrom into a persistent field.
   */
  protected projectPointOntoHoldPlane(point: vec3): vec3 | null {
    if (!this._holdPlaneValid) {
      return null
    }
    // result = point - normal * dot(point - planePoint, normal)
    this._scratchProject.copyFrom(point)
    this._scratchProject.subInPlace(this._holdPlanePoint)
    const d = this._scratchProject.dot(this._holdPlaneNormal)
    // _scratchProject = -normal * d, then add point → point - normal*d
    this._scratchProject.copyFrom(this._holdPlaneNormal)
    this._scratchProject.uniformScaleInPlace(-d)
    this._scratchProject.addInPlace(point)
    return this._scratchProject
  }

  /**
   * Returns the current position on the hold plane for drift measurement
   * and debug visualization.
   *
   * Default: intersects the interactor's ray (startPoint + direction) with
   * the hold plane via rayPlaneIntersection. This is correct for any
   * ray-based interaction (far-field, near-field, mouse).
   *
   * Subclasses should override when the ray geometry does not represent the
   * physical contact point — e.g. HandInteractor overrides this for
   * poke / direct pinch where startPoint is the upper finger joint and the
   * ray is nearly co-planar with the surface.
   *
   * WARNING: the default implementation returns a scratch vector that is
   * overwritten on the next call. Callers that need to persist the result
   * across frames must clone it.
   */
  protected getCurrentHoldPlanePosition(): vec3 | null {
    if (!this._holdPlaneValid) {
      return null
    }
    return this.rayPlaneIntersection(this._holdPlanePoint, this._holdPlaneNormal)
  }

  /**
   * Manages the hold timer that gates secondary trigger activation.
   * Called each frame after currentTrigger is set but before trigger events are processed.
   *
   * - Starts the timer when a primary trigger begins on an Interactable with secondary trigger listeners.
   * - Each frame, checks that the ray's intersection on the hold plane stays within the
   *   scaled plane-distance threshold.
   * - If the timer elapses within the threshold, activates secondary trigger and cancels primary trigger.
   * - Resets when the primary trigger ends or the interactor becomes inactive.
   */
  protected updateHoldTimer(): void {
    // Reset everything if we are no longer triggering or have become inactive
    if (this.currentTrigger === InteractorTriggerType.None || !this.isActive()) {
      if (this._holdTimerActive || this.isSecondaryTriggering) {
        if (this.isSecondaryTriggering) {
          this.currentSecondaryTrigger = InteractorTriggerType.None
        }
        this.resetHoldTimer()
      }
      return
    }

    // Start condition: primary trigger just began
    if (
      this.previousTrigger === InteractorTriggerType.None &&
      (InteractorTriggerType.Select & this.currentTrigger) !== 0 &&
      !this.isSecondaryTriggering
    ) {
      const target = this.currentInteractable
      if (target !== null && this.hasSecondaryTriggerListeners(target)) {
        const hitPos = this.targetHitInfo?.hit.position ?? null
        const cameraPos = this.cameraProvider.getWorldPosition()
        if (hitPos !== null) {
          this._scratchPlaneOp.copyFrom(cameraPos)
          this._scratchPlaneOp.subInPlace(hitPos)
          if (this._scratchPlaneOp.length < NEAR_ZERO_LENGTH_EPSILON) {
            return
          }
          this._holdPlanePoint.copyFrom(hitPos)
          this._holdPlaneNormal.copyFrom(this._scratchPlaneOp)
          this._holdPlaneNormal.normalizeInPlace()
          this._holdPlaneValid = true
          // Use the virtual getCurrentHoldPlanePosition() as the drift origin so
          // subclasses (e.g. HandInteractor for poke/direct pinch) anchor to the
          // actual finger position rather than a potentially stale hitPos.
          const initialPlanePos = this.getCurrentHoldPlanePosition()
          if (initialPlanePos !== null) {
            this._holdStartPlaneHit.copyFrom(initialPlanePos)
          } else {
            this._holdStartPlaneHit.copyFrom(hitPos)
          }
          this._holdStartTime = getTime()
          this._holdTargetInteractable = target
          this._holdTimerActive = true
          this._holdTriggerType = this.currentTrigger
        }
      }
      return
    }

    // While secondary trigger is active, suppress the primary trigger to prevent
    // stale trigger state from producing spurious TriggerEnd events on release.
    if (this.isSecondaryTriggering) {
      this.currentTrigger = InteractorTriggerType.None
      return
    }

    // Tick the hold timer
    if (
      this._holdTimerActive &&
      this._holdPlaneValid &&
      this._holdStartTime !== null &&
      this._holdTargetInteractable !== null
    ) {
      // Abort if the ray no longer physically intersects the target's collider,
      // even though shouldPreventTargetUpdate keeps currentInteractable locked.
      if (!this.isHoveringInteractable(this._holdTargetInteractable)) {
        this.resetHoldTimer()
        return
      }

      const currentPlaneHit = this.getCurrentHoldPlanePosition()
      if (currentPlaneHit === null) {
        this.resetHoldTimer()
        return
      }

      // Re-anchor drift origin when the trigger type changes mid-hold (e.g. Poke→Pinch).
      if (this.currentTrigger !== this._holdTriggerType) {
        this._holdStartPlaneHit.copyFrom(currentPlaneHit)
        this._holdTriggerType = this.currentTrigger
      }

      const distance = this._holdStartPlaneHit.distance(currentPlaneHit)

      // Per-Interactable override takes priority; otherwise delegate to the
      // virtual method which subclasses can override for mode-specific thresholds.
      const interactableThreshold = this._holdTargetInteractable.secondaryTriggerPlaneDistanceThreshold
      const interactorDistance =
        this.startPoint !== null
          ? this.startPoint.distance(this._holdPlanePoint)
          : this.secondaryTriggerReferenceDistance
      const effectiveThreshold =
        interactableThreshold !== null
          ? interactableThreshold
          : this.getEffectiveSecondaryTriggerThreshold(interactorDistance)

      if (distance > effectiveThreshold) {
        this.resetHoldTimer()
        return
      }

      const elapsedMs = (getTime() - this._holdStartTime) * 1000
      this._holdTimerProgress = Math.min(1, elapsedMs / this.secondaryTriggerHoldThreshold)
      if (elapsedMs >= this.secondaryTriggerHoldThreshold) {
        this.currentSecondaryTrigger = InteractorTriggerType.Select
        this._holdTimerActive = false
        this._holdTimerProgress = 0
      }
    }
  }

  /**
   * Process the new currentSecondaryTrigger and compare to previousSecondaryTrigger
   * to determine which interactor-level secondary trigger event to propagate.
   *
   * On secondary trigger start, the primary trigger is canceled first:
   * - Fires onTriggerCanceled
   * - Clears drag providers
   * - Sets currentTrigger to None
   */
  protected processSecondaryTriggerEvents(): void {
    if (!this.isActive()) {
      if (this._previousSecondaryTrigger !== InteractorTriggerType.None) {
        this.onSecondaryTriggerCanceledEvent.invoke(this.currentInteractable)
      }
      return
    }

    if (
      this._previousSecondaryTrigger === InteractorTriggerType.None &&
      this._currentSecondaryTrigger !== InteractorTriggerType.None
    ) {
      this.onTriggerCanceledEvent.invoke(this.currentInteractable)
      this.clearDragProviders()
      this.currentTrigger = InteractorTriggerType.None

      this.onSecondaryTriggerStartEvent.invoke(this.currentInteractable)
    } else if (
      this._previousSecondaryTrigger !== InteractorTriggerType.None &&
      this._currentSecondaryTrigger !== InteractorTriggerType.None
    ) {
      this.onSecondaryTriggerUpdateEvent.invoke(this.currentInteractable)
    } else if (
      this._previousSecondaryTrigger !== InteractorTriggerType.None &&
      this._currentSecondaryTrigger === InteractorTriggerType.None
    ) {
      this.onSecondaryTriggerEndEvent.invoke(this.currentInteractable)
    }
  }

  /**
   * Computes the effective plane-distance threshold for the hold timer
   * given the current interactor-to-target distance. The default implementation
   * applies distance-based scaling using the configured reference distance and
   * min/max scale factors.
   *
   * Subclasses can override this to provide mode-specific thresholds (e.g.
   * HandInteractor returns a flat value for near-field / physical interactions).
   *
   * Note: per-Interactable overrides are handled by the caller and take priority
   * over this method's return value.
   */
  protected getEffectiveSecondaryTriggerThreshold(interactorDistance: number): number {
    const rawScale = interactorDistance / this.secondaryTriggerReferenceDistance
    const clampedScale = Math.max(
      this.secondaryTriggerMinDistanceScale,
      Math.min(this.secondaryTriggerMaxDistanceScale, rawScale)
    )
    return this.secondaryTriggerPlaneDistanceThreshold * clampedScale
  }

  /**
   * Draws debug visualization for the hold timer when drawDebug is enabled:
   * - A circle on the hold plane showing the effective plane-distance threshold zone
   * - A progress bar showing elapsed time relative to the hold threshold
   * - A cross at the current ray-plane intersection
   * - A line from the initial hit to the current intersection, colored by distance ratio
   */
  protected drawHoldTimerDebug(): void {
    if (!this._drawDebug) {
      return
    }

    if (!this._holdTimerActive && !this.isSecondaryTriggering) {
      return
    }

    if (!this._holdPlaneValid) {
      return
    }

    const planePoint = this._holdPlanePoint
    const planeNormal = this._holdPlaneNormal
    const startHit = this._holdStartPlaneHit

    const interactableThreshold = this._holdTargetInteractable?.secondaryTriggerPlaneDistanceThreshold
    const interactorDistance =
      this.startPoint !== null ? this.startPoint.distance(planePoint) : this.secondaryTriggerReferenceDistance
    const effectiveThreshold =
      interactableThreshold !== null && interactableThreshold !== undefined
        ? interactableThreshold
        : this.getEffectiveSecondaryTriggerThreshold(interactorDistance)

    // Build a local coordinate frame on the hold plane for drawing the circle
    let tangent = planeNormal.cross(new vec3(0, 1, 0))
    if (tangent.length < NEAR_ZERO_LENGTH_EPSILON) {
      tangent = planeNormal.cross(new vec3(1, 0, 0))
    }
    tangent = tangent.normalize()
    const bitangent = planeNormal.cross(tangent).normalize()

    // Draw threshold zone circle
    let circleColor: vec4
    if (this.isSecondaryTriggering) {
      circleColor = HOLD_DEBUG_ZONE_ACTIVE_COLOR
    } else {
      circleColor = HOLD_DEBUG_ZONE_COLOR
    }
    const segments = HOLD_DEBUG_CIRCLE_SEGMENTS
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2
      const a1 = ((i + 1) / segments) * Math.PI * 2

      const p0 = startHit
        .add(tangent.uniformScale(Math.cos(a0) * effectiveThreshold))
        .add(bitangent.uniformScale(Math.sin(a0) * effectiveThreshold))
      const p1 = startHit
        .add(tangent.uniformScale(Math.cos(a1) * effectiveThreshold))
        .add(bitangent.uniformScale(Math.sin(a1) * effectiveThreshold))

      global.debugRenderSystem.drawLine(p0, p1, circleColor)
    }

    // Draw current intersection and drift line
    const currentPlaneHit = this.getCurrentHoldPlanePosition()
    if (currentPlaneHit !== null) {
      const distance = startHit.distance(currentPlaneHit)
      const ratio = effectiveThreshold > 0 ? distance / effectiveThreshold : 0

      let driftColor: vec4
      if (ratio < 0.5) {
        driftColor = HOLD_DEBUG_DRIFT_SAFE_COLOR
      } else if (ratio < 0.85) {
        driftColor = HOLD_DEBUG_DRIFT_WARN_COLOR
      } else {
        driftColor = HOLD_DEBUG_DRIFT_DANGER_COLOR
      }

      // Line from initial hit to current hit
      global.debugRenderSystem.drawLine(startHit, currentPlaneHit, driftColor)

      // Cross at current intersection
      const crossSize = 0.3
      global.debugRenderSystem.drawLine(
        currentPlaneHit.sub(tangent.uniformScale(crossSize)),
        currentPlaneHit.add(tangent.uniformScale(crossSize)),
        HOLD_DEBUG_HIT_COLOR
      )
      global.debugRenderSystem.drawLine(
        currentPlaneHit.sub(bitangent.uniformScale(crossSize)),
        currentPlaneHit.add(bitangent.uniformScale(crossSize)),
        HOLD_DEBUG_HIT_COLOR
      )
    }

    // Draw timer progress bar above the initial hit point
    if (this._holdTimerActive && this._holdStartTime !== null) {
      const elapsedMs = (getTime() - this._holdStartTime) * 1000
      const progress = Math.min(1, elapsedMs / this.secondaryTriggerHoldThreshold)

      const barOffset = bitangent.uniformScale(effectiveThreshold + 1.0)
      const barLength = effectiveThreshold * 2
      const barStart = startHit.add(barOffset).sub(tangent.uniformScale(barLength * 0.5))
      const barEnd = barStart.add(tangent.uniformScale(barLength))

      // Background
      global.debugRenderSystem.drawLine(barStart, barEnd, HOLD_DEBUG_PROGRESS_BG_COLOR)

      // Foreground (filled portion)
      const fillEnd = barStart.add(tangent.uniformScale(barLength * progress))
      global.debugRenderSystem.drawLine(barStart, fillEnd, HOLD_DEBUG_PROGRESS_FG_COLOR)
    }

    // Cross at initial hit point
    const originCrossSize = 0.5
    global.debugRenderSystem.drawLine(
      startHit.sub(tangent.uniformScale(originCrossSize)),
      startHit.add(tangent.uniformScale(originCrossSize)),
      circleColor
    )
    global.debugRenderSystem.drawLine(
      startHit.sub(bitangent.uniformScale(originCrossSize)),
      startHit.add(bitangent.uniformScale(originCrossSize)),
      circleColor
    )
  }

  /**
   * Checks whether the given Interactable has secondary trigger listeners
   * registered. Used as a pre-flight check to avoid starting the hold timer
   * when the target would not respond to a secondary trigger.
   *
   * Only the directly targeted Interactable is checked — ancestor Interactables
   * are not considered. Only onSecondaryTriggerStart is checked since it is
   * the gate event; the other secondary trigger events cannot fire without it.
   */
  protected hasSecondaryTriggerListeners(interactable: Interactable): boolean {
    return interactable.onSecondaryTriggerStart.hasListeners
  }
}
