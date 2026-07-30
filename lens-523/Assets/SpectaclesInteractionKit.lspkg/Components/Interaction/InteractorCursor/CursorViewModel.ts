import {FieldTargetingMode, HandInteractor} from "../../../Core/HandInteractor/HandInteractor"
import {InteractionManager} from "../../../Core/InteractionManager/InteractionManager"
import {
  Interactor,
  InteractorInputType,
  InteractorTriggerType,
  TargetingMode
} from "../../../Core/Interactor/Interactor"
import WorldCameraFinderProvider from "../../../Providers/CameraProvider/WorldCameraFinderProvider"
import Event from "../../../Utils/Event"
import {LensConfig} from "../../../Utils/LensConfig"
import {SpringAnimate1D} from "../../../Utils/springAnimate"
import StateMachine from "../../../Utils/StateMachine"
import {DispatchedUpdateEvent, IUpdateDispatcher} from "../../../Utils/UpdateDispatcher"
import {Interactable, TargetingVisual} from "../Interactable/Interactable"
import {InteractableManipulation} from "../InteractableManipulation/InteractableManipulation"
import {ConeOverlap, GEOMETRY_EPSILON, MIN_LENGTH_THRESHOLD} from "./modules/ConeOverlap"
import {CursorDebugDraw} from "./modules/CursorDebugDraw"
import {CursorInteractionContext, DirectHitRecord} from "./modules/CursorInteractionContext"
import {DepthSmoother} from "./modules/DepthSmoother"
import {InteractableScoring} from "./modules/InteractableScoring"

// Cursor quad is 1×1 units; worldScale maps to cm, ring edge at 90% for margin.
const RING_QUAD_RATIO = 0.9

const REFERENCE_RING_CM = 2.25
const REFERENCE_DISTANCE_CM = 100

const REFERENCE_SCALE = REFERENCE_RING_CM / RING_QUAD_RATIO
const SCALING_FACTOR = REFERENCE_SCALE / REFERENCE_DISTANCE_CM
const MIN_SCALE = 1.5 / RING_QUAD_RATIO
const MAX_SCALE = 18.75 / RING_QUAD_RATIO
const SCALE_COMPENSATION_STRENGTH = 0.5
const SCALE_DISTANCE_EPSILON = 4.0

const CursorStates = {
  Hidden: "Hidden",
  Override: "Override",
  Hover: "Hover",
  Manipulating: "Manipulating"
}

export type CursorViewState = {
  cursorEnabled: boolean
  position: vec3
  scale: number
  cursorAlpha: number
  rayAlpha: number
  isTriggering: boolean
  isNearField: boolean
}

/**
 * Which high-level execution branch onUpdate() is currently running.
 *
 * Hidden        — cursor suppressed; depth spring reset.
 * FarField      — normal cone/ray far-field hover (state machine drives).
 * NearField     — hand in NF zone, targetHit valid: spring-smooth onto contact.
 * NearFieldHide — hand in NF zone but no valid hit: suppress.
 *
 * Transitions fire onPathExit / onPathEnter, which own all snap-arming logic.
 * Nothing else arms or disarms the depth-spring snap state.
 */
const CursorPath = {
  Hidden: "Hidden",
  FarField: "FarField",
  NearField: "NearField",
  NearFieldHide: "NearFieldHide"
} as const
type CursorPath = (typeof CursorPath)[keyof typeof CursorPath]

function isHandInteractor(interactor: Interactor): interactor is HandInteractor {
  return (interactor.inputType & InteractorInputType.BothHands) !== 0
}

export class CursorViewModel {
  private segmentLength = 500.0
  private updateDispatcher: IUpdateDispatcher = LensConfig.getInstance().updateDispatcher

  private minDistanceSquared: number
  private maxDistanceSquared: number

  private interactor: Interactor
  private interactionManager: InteractionManager = InteractionManager.getInstance()
  private camera = WorldCameraFinderProvider.getInstance()
  private context = new CursorInteractionContext()
  private cursorStateMachine: StateMachine = new StateMachine("CursorView")
  private pendingManipulationHit: DirectHitRecord | null = null
  private triggerData: {
    interactable: Interactable
    localHit: vec3
    initialWorld: vec3
    planePoint: vec3
    planeNormal: vec3
    lastIntersect?: vec3
  } | null = null

  private readonly cone: ConeOverlap
  private readonly scoring: InteractableScoring
  private readonly depthSmoother: DepthSmoother
  private readonly debugDraw: CursorDebugDraw

  private readonly _scratchVec3 = new vec3(0, 0, 0)

  // Per-frame ray data — populated by updateRayData(), avoids object literal allocation
  private _rayStart: vec3 = vec3.zero()
  private _rayEnd: vec3 = vec3.zero()
  private _rayVector: vec3 = vec3.zero()
  private _rayDir: vec3 = vec3.zero()
  private _rayLength: number = 0

  // Per-frame direct-hit cache — avoids recomputing getDirectHit 2-3× per frame
  private _directHitDirty: boolean = true
  private _cachedDirectHit: DirectHitRecord | null = null

  // Per-frame interactor property snapshots — read once at the top of onUpdate, reused throughout
  private _frameCurrentInteractable: Interactable | null = null
  private _frameTargetHitPosition: vec3 | null = null

  private isTracked = false
  private wasTracked = false
  private wasOverride = false

  private _cursorPosition: vec3 = vec3.zero()

  private onCursorUpdateEvent = new Event<CursorViewState>()
  public onCursorUpdate = this.onCursorUpdateEvent.publicApi()
  public positionOverride: vec3 | null = null
  private lateUpdateEvent: DispatchedUpdateEvent
  private interactorLabel: string

  private fadeMultiplierSpring: SpringAnimate1D = SpringAnimate1D.smooth(0.2)
  private fadeMultiplier: number = 1.0
  private fadeMultiplierTarget: number = 1.0

  private lastScaleDistanceSq: number | null = null
  private cachedScale: number = MIN_SCALE

  // Pre-allocated view state dispatched via onCursorUpdateEvent. The same object is
  // reused every frame — listeners must consume fields before the next update.
  private _cursorViewState: CursorViewState = {
    cursorEnabled: false,
    position: vec3.zero(),
    scale: 0,
    cursorAlpha: 0,
    rayAlpha: 0,
    isTriggering: false,
    isNearField: false
  }
  private _isNearField = false
  private wasTriggeringForStateMachine = false

  // Active cursor path — drives onPathEnter/Exit hooks and the main dispatch.
  private _activePath: CursorPath = CursorPath.Hidden

  // Set by onPathEnter(NearField) when entering from a visible path (depth is non-null).
  // Cleared on the first handleNearFieldPath call; triggers keepDepthAt so the spring
  // initializes from the projected previous cursor position instead of snapping.
  private _initNearFieldDepth: boolean = false

  public get cursorPosition(): vec3 | null {
    return this._cursorPosition
  }

  constructor(interactor: Interactor) {
    this.interactor = interactor
    this.segmentLength = interactor.maxRaycastDistance ?? this.segmentLength
    this.interactorLabel = `${interactor.inputType}`

    this.cone = new ConeOverlap(this.interactionManager, this.updateDispatcher)
    this.scoring = new InteractableScoring(this.cone, this.interactionManager, this.camera)
    this.depthSmoother = new DepthSmoother(this.cone, this.interactionManager)
    this.debugDraw = new CursorDebugDraw(this.cone)

    const calculateDistanceForScale = (scale: number): number => {
      const idealScale = REFERENCE_SCALE + (scale - REFERENCE_SCALE) / SCALE_COMPENSATION_STRENGTH
      return idealScale / SCALING_FACTOR
    }

    const minDistance = calculateDistanceForScale(MIN_SCALE)
    const maxDistance = calculateDistanceForScale(MAX_SCALE)

    this.minDistanceSquared = minDistance * minDistance
    this.maxDistanceSquared = maxDistance * maxDistance

    this.setupStateMachine()
    this.cursorStateMachine.enterState(CursorStates.Hidden)

    const label = `${this.interactorLabel}`
    this.lateUpdateEvent = this.updateDispatcher.createLateUpdateEvent(`CursorViewModelUpdate_${label}`, () =>
      this.onUpdate()
    )
    this.lateUpdateEvent.enabled = false
  }

  /**
   * Dispose the internal UpdateDispatcher event.
   */
  public destroy(): void {
    if (this.lateUpdateEvent) {
      this.updateDispatcher.removeEvent(this.lateUpdateEvent)
    }
  }

  /**
   * Triggers a fade-in animation.
   */
  public fadeIn(duration?: number): void {
    if (duration && duration > 0) {
      this.fadeMultiplierSpring.setDurationSmooth(duration, true)
    }
    this.fadeMultiplierTarget = 1.0
  }

  /**
   * Triggers a fade-out animation.
   */
  public fadeOut(duration?: number): void {
    if (duration && duration > 0) {
      this.fadeMultiplierSpring.setDurationSmooth(duration, true)
    }
    this.fadeMultiplierTarget = 0.0
  }

  /**
   * Enable or disable the internal UpdateDispatcher event.
   */
  public enableUpdateEvent(enabled: boolean): void {
    if (this.lateUpdateEvent) {
      this.lateUpdateEvent.enabled = enabled
    }
  }

  public setDebugDraw(enabled: boolean): void {
    this.debugDraw.setEnabled(enabled)
    this.scoring.debugDrawEnabled = enabled
  }

  private isInNearField(): boolean {
    if (!isHandInteractor(this.interactor)) return false
    return this.interactor.isEffectivelyNearField()
  }

  // ---------------------------------------------------------------------------
  // Path classification
  // ---------------------------------------------------------------------------

  /**
   * Determines which execution path should run this frame. Pure — reads state,
   * returns a CursorPath, no side effects.
   */
  private classifyCursorPath(): CursorPath {
    // Hard-hide whenever the interactor reports !isActive(). This includes phone-in-hand
    // (HandInteractor.computeIsActive() gates on !this._hand.isPhoneInHand), interactor
    // disabled, hand disabled, or scene-object disabled in hierarchy. Enforced here so
    // PIH-driven invalidations cannot leak through the NearField bypass below.
    if (!this.interactor.isActive()) {
      return CursorPath.Hidden
    }

    // NF→FF transition (phase 1, shouldUseNewMode=false): isEffectivelyNearField() already
    // returned false so _isNearField=false, but we keep NearFieldHide so the cursor fades out
    // via getNearFieldVisualAlpha() instead of hard-hiding. Once shouldUseNewMode flips the
    // check falls through to FarField, where handleFarFieldPath applies blendFactor for the
    // fade-in phase.
    if (isHandInteractor(this.interactor)) {
      const ti = this.interactor.fieldModeTransitionInfo
      if (ti.isTransitioning && ti.toMode === FieldTargetingMode.FarField && !ti.shouldUseNewMode) {
        return CursorPath.NearFieldHide
      }
    }

    if (this._isNearField && !this.isTracked) {
      // _isNearField=true implies isHandInteractor — isInNearField() already verified.
      const hand = this.interactor as HandInteractor
      const tHit = this.interactor.targetHitPosition
      const iStart = hand.indirectStartPoint
      const iDir = hand.indirectDirection
      if (tHit === null || iStart === null || iDir === null) return CursorPath.NearFieldHide

      return CursorPath.NearField
    }

    if (!this.isTracked || this.interactor.activeTargetingMode !== TargetingMode.Indirect) {
      return CursorPath.Hidden
    }

    return CursorPath.FarField
  }

  /**
   * Called when leaving a path. Arms snap for paths where stale depth would
   * cause a visible spring-lag on re-entry.
   *
   * NearFieldHide arms snap so that FarField re-entry after a NF→FF transition
   * snaps to hover depth rather than spring-lagging from the stale NF contact
   * depth stored during the hide phase.
   *
   * NearField does NOT arm snap: when poke exits via NearField→FarField, the
   * sphere-cast and ray-cast depths differ by at most a sphere-radius offset
   * (both on the same surface). Letting the snappy spring ease between them is
   * imperceptible, whereas snapping causes a visible 1-frame cursor jump because
   * the two providers produce slightly different hit positions.
   */
  private onPathExit(path: CursorPath): void {
    switch (path) {
      case CursorPath.NearField:
        // Clear so a premature NearField exit (e.g. targetHit drops null on the very next
        // frame) doesn't leave a stale flag for the subsequent NearField re-entry.
        this._initNearFieldDepth = false
        break
      case CursorPath.NearFieldHide:
        this.depthSmoother.requestSnap()
        break
    }
  }

  /**
   * Called when entering a path. Sets up spring state for the new path.
   */
  private onPathEnter(path: CursorPath): void {
    switch (path) {
      case CursorPath.Hidden:
        // Reset springs so re-entry to any visible path starts from a clean state.
        this.depthSmoother.reset()
        break
      case CursorPath.NearField:
        // If entering from a visible path (depth non-null), set a flag so
        // handleNearFieldPath will project the previous cursor world position
        // onto the NearField ray (keepDepthAt) and let the snappy spring ease
        // to the poke contact depth. This keeps depth (Z) in sync with the
        // locus lerp (XY), preventing the Z-first jump on poke start.
        //
        // If depth is already null (e.g. from Hidden/reset), leave it: smoothNearField
        // will snap to contact depth on the first NearField frame as usual.
        if (!this.depthSmoother.isSnapping) {
          this._initNearFieldDepth = true
        }
        // NF manages alpha via getNearFieldVisualAlpha(); reset fadeMultiplier so any
        // residual FF transition value doesn't dampen it in updateAndDrawCursor.
        this.fadeMultiplier = 1.0
        break
      case CursorPath.NearFieldHide:
        // Don't arm snap here — that is owned by onPathExit(NearField/NearFieldHide).
        // Reset fadeMultiplier so a FF transition alpha doesn't bleed into NF rendering.
        this.fadeMultiplier = 1.0
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Main update loop
  // ---------------------------------------------------------------------------

  public onUpdate(): void {
    this.cone.planeCacheValid = false
    this._directHitDirty = true

    const activeTargetingMode = this.interactor.activeTargetingMode
    this.isTracked = this.shouldShowCursorWithMode(activeTargetingMode)
    const isTriggering = this.interactor.currentTrigger !== InteractorTriggerType.None

    this._isNearField = this.isInNearField()

    // Classify path and fire transition hooks if it changed.
    const newPath = this.classifyCursorPath()
    if (newPath !== this._activePath) {
      this.onPathExit(this._activePath)
      this._activePath = newPath
      this.onPathEnter(newPath)
    }

    switch (this._activePath) {
      case CursorPath.Hidden:
        this.handleHiddenPath(isTriggering)
        break
      case CursorPath.NearField:
        this.handleNearFieldPath(isTriggering)
        break
      case CursorPath.NearFieldHide:
        this.handleNearFieldHidePath(isTriggering)
        break
      case CursorPath.FarField:
        this.handleFarFieldPath(isTriggering)
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Path handlers
  // ---------------------------------------------------------------------------

  private handleHiddenPath(isTriggering: boolean): void {
    this.hideCursor(isTriggering)
  }

  /**
   * Near-field happy path: hand in NF zone, valid targetHit.
   * Inputs are guaranteed non-null by classifyCursorPath.
   */
  private handleNearFieldPath(isTriggering: boolean): void {
    const hand = this.interactor as HandInteractor
    const indirectStart = hand.indirectStartPoint!
    const indirectDir = hand.indirectDirection!
    const targetHit = this.interactor.targetHitPosition!

    if (this._initNearFieldDepth) {
      this._initNearFieldDepth = false
      // Project the previous cursor world position onto the NearField ray so the
      // spring starts from a depth consistent with where the cursor was, rather
      // than snapping instantly to the poke contact depth. Because indirectStart
      // (the locus) is simultaneously lerping toward the fingertip, depth and XY
      // now transition together — eliminating the Z-first visual jump on poke start.
      this.depthSmoother.keepDepthAt(this.depthSmoother.lastResultPosition, indirectStart, indirectDir)
    }

    this._cursorPosition = this.depthSmoother.smoothNearField(indirectStart, indirectDir, targetHit)

    this.updateAndDrawCursor(hand.getNearFieldVisualAlpha(), 0.0, isTriggering)
  }

  /**
   * Near-field suppress path: hand in NF zone but no valid targetHit. Fades with
   * NF alpha rather than hard-hiding to avoid a cursor pop
   * on brief sphere-cast gaps. Hard-hides during active poke with null target to
   * prevent the cursor sitting at the stale contact depth.
   *
   * Also active during NF→FF transition phase 1 (shouldUseNewMode=false), where it
   * fades the last NF cursor position out via getNearFieldVisualAlpha(). The hard-hide
   * guard is suppressed during that phase so the cursor can complete its fade.
   */
  private handleNearFieldHidePath(isTriggering: boolean): void {
    const hand = this.interactor as HandInteractor
    const atm = this.interactor.activeTargetingMode
    const ti = hand.fieldModeTransitionInfo

    // During NF→FF fade-out, skip the hard-hide so the cursor can fade gracefully.
    const isNFtoFFTransition = ti.isTransitioning && ti.toMode === FieldTargetingMode.FarField && !ti.shouldUseNewMode

    // Active poke with null target: sphere-cast lost hit — hard-hide to prevent
    // cursor sitting at stale contact depth.
    if (!isNFtoFFTransition && this.interactor.targetHitPosition === null && (atm & TargetingMode.Poke) !== 0) {
      this.hideCursor(isTriggering)
      return
    }

    const alpha = hand.getNearFieldVisualAlpha()
    if (alpha > 0) {
      this.updateAndDrawCursor(alpha, 0.0, isTriggering)
    } else {
      this.hideCursor(isTriggering)
    }
  }

  /**
   * Far-field path: normal cone/ray hover. Delegates to the existing state
   * machine and scoring logic — no changes to this path's internal behavior.
   */
  private handleFarFieldPath(isTriggering: boolean): void {
    // During NF↔FF transitions the FF cursor must fade out (FF→NF, phase 1) or fade in
    // (NF→FF, phase 2). Bypass the spring and directly track blendFactor so the FF alpha
    // stays in sync with HandInteractor's transition animation. Without this, the FF cursor
    // holds full alpha while the NF cursor snaps into position (visible flicker), or the FF
    // cursor fades in abruptly after NF→FF.
    if (isHandInteractor(this.interactor)) {
      const ti = this.interactor.fieldModeTransitionInfo
      const isNFFFTransition =
        ti.isTransitioning &&
        (ti.toMode === FieldTargetingMode.NearField || ti.fromMode === FieldTargetingMode.NearField)
      if (isNFFFTransition) {
        this.fadeMultiplier = ti.blendFactor
      } else {
        this.fadeMultiplier = this.fadeMultiplierSpring.evaluate(this.fadeMultiplier, this.fadeMultiplierTarget)
      }
    } else {
      this.fadeMultiplier = this.fadeMultiplierSpring.evaluate(this.fadeMultiplier, this.fadeMultiplierTarget)
    }

    this._frameCurrentInteractable = this.interactor.currentInteractable
    this._frameTargetHitPosition = this.interactor.targetHitPosition

    this.updateRayData()

    // Re-project the previous cursor world position onto the current ray every frame.
    //
    // `_depth` is a scalar along the active ray. If the ray origin shifts between frames
    // (provider switch, hand-tracking noise), the old scalar maps to a different world
    // position on the new ray. Re-projecting lastResultPosition keeps the spring anchored
    // to the correct world position for this frame's ray before it advances.
    // In steady-state FF this is an identity operation with no behavioral effect.
    if (!this.depthSmoother.isSnapping && this._rayLength > 0) {
      this.depthSmoother.keepDepthAt(this.depthSmoother.lastResultPosition, this._rayStart, this._rayDir)
    }

    const hasDirectHit = this._frameCurrentInteractable !== null && this._frameTargetHitPosition !== null
    const shouldUpdateConeOverlap = this.isTracked && !hasDirectHit
    if (shouldUpdateConeOverlap) {
      this.cone.updateConeOverlap(this._rayStart, this._rayDir, this._rayLength)
    }

    const nothingInRange =
      shouldUpdateConeOverlap &&
      this.cone.overlappingInteractableEntries.length === 0 &&
      this.interactionManager.interactionPlanes.size === 0 &&
      !isTriggering &&
      !this.triggerData &&
      !this.positionOverride

    this.updateStateMachineSignals(isTriggering, this.isTracked)

    if (nothingInRange) {
      this.hideCursor(isTriggering)
      if (this.debugDraw.isEnabled()) {
        this.debugDraw.drawCone(this._rayStart, this._rayEnd)
        this.debugDraw.drawRay(this._rayStart, this._rayEnd)
      }
      return
    }

    if (this.debugDraw.isEnabled()) {
      if (shouldUpdateConeOverlap) {
        this.debugDraw.drawCone(this._rayStart, this._rayEnd)
      }
      this.debugDraw.drawRay(this._rayStart, this._rayEnd)
    }

    const needsPlaneScan = this.doesCurrentStateNeedPlaneScan(isTriggering)
    if (needsPlaneScan) {
      this.cone.refreshPlaneCaches()
      this.cone.planeCacheValid = true
      this.cone.updateOverlappingPlanes(this._rayStart, this._rayDir, this._rayLength)
      this.cone.updateEligibilityCache()

      if (!this.hasVisibleTargets(isTriggering)) {
        this.hideCursor(isTriggering)
        if (this.debugDraw.isEnabled()) {
          this.debugDraw.drawCachedData()
        }
        return
      }
    }

    this.executeCurrentStateLogic(isTriggering)

    if (this.debugDraw.isEnabled()) {
      this.debugDraw.drawCachedData()
    }
  }

  // ---------------------------------------------------------------------------
  // Internals (unchanged from prior version except stableAnchorPoint → keepDepthAt)
  // ---------------------------------------------------------------------------

  private updateRayData(): void {
    if (!this.interactor.startPoint || !this.interactor.direction) {
      this._rayLength = 0
      return
    }
    // Pin to indirect locus so the 1-frame physicalInteractionProvider overhang post-poke doesn't wobble the cursor.
    this._rayStart = isHandInteractor(this.interactor)
      ? ((this.interactor as HandInteractor).indirectStartPoint ?? this.interactor.startPoint)
      : this.interactor.startPoint
    const length = this.interactor.maxRaycastDistance ?? this.segmentLength

    this._rayEnd.copyFrom(this.interactor.direction)
    this._rayEnd.uniformScaleInPlace(length)
    this._rayEnd.addInPlace(this._rayStart)

    this._rayVector.copyFrom(this._rayEnd)
    this._rayVector.subInPlace(this._rayStart)
    this._rayLength = this._rayVector.length

    if (this._rayLength > MIN_LENGTH_THRESHOLD) {
      this._rayDir.copyFrom(this._rayVector)
      this._rayDir.uniformScaleInPlace(1.0 / this._rayLength)
    } else {
      this._rayDir.copyFrom(vec3.down())
    }
  }

  private hasVisibleTargets(isTriggering: boolean): boolean {
    if (this.positionOverride) {
      return true
    }

    if (this.triggerData) {
      return true
    }

    if (isTriggering) {
      return true
    }

    const planeEntries = this.cone.overlappingPlaneEntries
    const interactableEntries = this.cone.overlappingInteractableEntries

    if (interactableEntries.length + planeEntries.length === 0) {
      return false
    }

    for (let i = 0; i < planeEntries.length; i++) {
      if (this.cone.isPlaneEligible(planeEntries[i].plane)) {
        return true
      }
    }
    for (let i = 0; i < interactableEntries.length; i++) {
      if (interactableEntries[i].data.isEligible) {
        return true
      }
    }
    return false
  }

  private updateStateMachineSignals(isTriggering: boolean, isTracked: boolean): void {
    const isOverride = !!this.positionOverride
    if (isOverride && !this.wasOverride) {
      this.cursorStateMachine.sendSignal("OverrideOn")
    } else if (!isOverride && this.wasOverride) {
      this.cursorStateMachine.sendSignal("OverrideOff")
    }
    this.wasOverride = isOverride

    if (isTracked && !this.wasTracked) {
      this.cursorStateMachine.sendSignal("TrackGained")
    } else if (!isTracked && this.wasTracked) {
      this.cursorStateMachine.sendSignal("TrackLost")
    }
    this.wasTracked = isTracked

    if (isTriggering) {
      const directHitRecord = this.getDirectHit()

      if (directHitRecord) {
        const interactableManipulationComponent = directHitRecord.interactable.sceneObject.getComponent(
          InteractableManipulation.getTypeName()
        )
        const hasManipulation =
          interactableManipulationComponent !== null &&
          interactableManipulationComponent.enabled &&
          (interactableManipulationComponent.canRotate() ||
            interactableManipulationComponent.canTranslate() ||
            interactableManipulationComponent.canScale())

        if (hasManipulation) {
          this.pendingManipulationHit = directHitRecord
          this.cursorStateMachine.sendSignal("TriggerDownManipulate")
        } else if (!this.triggerData) {
          const so = directHitRecord.interactable.sceneObject
          const t = so.getTransform()
          const worldHit = directHitRecord.position

          const baseTriggerData = {
            interactable: directHitRecord.interactable,
            localHit: t.getWorldTransform().inverse().multiplyPoint(worldHit),
            initialWorld: worldHit
          }

          const parentPlane = this.interactionManager.getParentPlane(directHitRecord.interactable)
          if (this.cone.isPlaneEnabled(parentPlane) && !directHitRecord.interactable.ignoreInteractionPlane) {
            const {normal} = this.cone.getPlaneWorldOriginAndAxes(parentPlane)
            this.triggerData = {...baseTriggerData, planePoint: worldHit, planeNormal: normal}
          } else {
            const planeNormal = this.camera.forward()
            this.triggerData = {
              ...baseTriggerData,
              planePoint: worldHit,
              planeNormal: planeNormal
            }
          }
        }
      }
    } else if (this.wasTriggeringForStateMachine) {
      this.cursorStateMachine.sendSignal("TriggerUp")
      this.triggerData = null
    }
    this.wasTriggeringForStateMachine = isTriggering
  }

  private doesCurrentStateNeedPlaneScan(isTriggering: boolean): boolean {
    if (this.triggerData && isTriggering) {
      return false
    }

    if (this.cursorStateMachine.currentState?.name === CursorStates.Manipulating) {
      return false
    }

    if (this.getDirectHit()) {
      return false
    }

    return true
  }

  private executeCurrentStateLogic(isTriggering: boolean): void {
    const currentStateName = this.cursorStateMachine.currentState?.name

    if (this.debugDraw.isEnabled()) {
      this.debugDraw.clearLines()
    }

    switch (currentStateName) {
      case CursorStates.Hidden:
        this.hideCursor(isTriggering)
        break

      case CursorStates.Override:
        this.updateWithOverride(isTriggering, this.isTracked)
        break

      case CursorStates.Manipulating:
        this.handleManipulationState(isTriggering)
        break

      case CursorStates.Hover:
        if (this.handleTriggerState(isTriggering, this._rayStart, this._rayDir)) {
          return
        }
        this.handleHoverState(isTriggering)
        break
    }
  }

  private handleHoverState(isTriggering: boolean): void {
    const directHitRecord = this.getDirectHit()
    if (directHitRecord) {
      this.runDirectHitInteraction(this._rayStart, this._rayDir, directHitRecord, isTriggering)
    } else {
      this.runFallbackInteraction(this._rayStart, this._rayVector, this._rayDir, this._rayLength, isTriggering)
    }
  }

  private handleTriggerState(isTriggering: boolean, segmentStart: vec3, rayDir: vec3): boolean {
    const trigger = this.triggerData
    if (!trigger || !isTriggering) {
      return false
    }

    const latchedWorld = trigger.initialWorld
    const {planePoint, planeNormal} = trigger

    const denom = rayDir.dot(planeNormal)
    if (Math.abs(denom) > GEOMETRY_EPSILON) {
      this._scratchVec3.copyFrom(planePoint)
      this._scratchVec3.subInPlace(segmentStart)
      const t = this._scratchVec3.dot(planeNormal) / denom
      if (t >= 0) {
        this._scratchVec3.copyFrom(rayDir)
        this._scratchVec3.uniformScaleInPlace(t)
        this._scratchVec3.addInPlace(segmentStart)
        trigger.lastIntersect = this._scratchVec3.clone()
      }
    }

    this._cursorPosition.copyFrom(trigger.lastIntersect ?? latchedWorld)
    this.depthSmoother.keepDepthAt(this._cursorPosition, segmentStart, rayDir)

    const visualInteractable = trigger.interactable

    const targetingVisual =
      visualInteractable && !isNull(visualInteractable.sceneObject)
        ? this.scoring.getEffectiveTargetingVisual(visualInteractable)
        : TargetingVisual.None

    const cursorAlpha = targetingVisual === TargetingVisual.Cursor ? 1.0 : 0.0
    const rayAlpha = targetingVisual === TargetingVisual.Ray ? 1.0 : 0.0

    this.updateAndDrawCursor(cursorAlpha, rayAlpha, isTriggering)
    return true
  }

  private handleManipulationState(isTriggering: boolean): void {
    const manipulatedPos = this.context.updateManipulation()
    if (
      manipulatedPos &&
      this.context.manipulatedInteractable &&
      !isNull(this.context.manipulatedInteractable.sceneObject)
    ) {
      this._cursorPosition = manipulatedPos
      this.depthSmoother.keepDepthAt(manipulatedPos, this._rayStart, this._rayDir)

      const targetingVisual = this.scoring.getEffectiveTargetingVisual(this.context.manipulatedInteractable)
      const cursorAlpha = targetingVisual === TargetingVisual.Cursor ? 1.0 : 0.0
      const rayAlpha = targetingVisual === TargetingVisual.Ray ? 1.0 : 0.0

      this.updateAndDrawCursor(cursorAlpha, rayAlpha, isTriggering)
    } else {
      // updateManipulation returns null when the manipulated sceneObject is destroyed mid-drag.
      this.hideCursor(isTriggering)
    }
  }

  private setupStateMachine(): void {
    this.cursorStateMachine.addState({
      name: CursorStates.Hidden,
      transitions: [
        {
          nextStateName: CursorStates.Override,
          checkOnSignal: (signal) => signal === "OverrideOn"
        },
        {
          nextStateName: CursorStates.Hover,
          checkOnSignal: (signal) => signal === "TrackGained" && this.positionOverride === null
        }
      ]
    })

    // Override
    this.cursorStateMachine.addState({
      name: CursorStates.Override,
      transitions: [
        {
          nextStateName: CursorStates.Hover,
          checkOnSignal: (signal) => signal === "OverrideOff" && this.isTracked
        },
        {
          nextStateName: CursorStates.Hidden,
          checkOnSignal: (signal) => signal === "OverrideOff" && !this.isTracked
        }
      ]
    })

    // Hover
    this.cursorStateMachine.addState({
      name: CursorStates.Hover,
      transitions: [
        {
          nextStateName: CursorStates.Hidden,
          checkOnSignal: (signal) => signal === "TrackLost"
        },
        {
          nextStateName: CursorStates.Override,
          checkOnSignal: (signal) => signal === "OverrideOn"
        },
        {
          nextStateName: CursorStates.Manipulating,
          checkOnSignal: (signal) => signal === "TriggerDownManipulate",
          onExecution: () => {
            if (this.pendingManipulationHit) {
              this.context.startManipulation(this.pendingManipulationHit)
              const manipPos = this.context.updateManipulation()
              if (manipPos !== null) {
                this._cursorPosition = manipPos
                this.depthSmoother.keepDepthAt(manipPos, this._rayStart, this._rayDir)
              }
              this.pendingManipulationHit = null
            }
          }
        }
      ]
    })

    // Manipulating
    this.cursorStateMachine.addState({
      name: CursorStates.Manipulating,
      transitions: [
        {
          nextStateName: CursorStates.Hover,
          checkOnSignal: (signal) => signal === "TriggerUp",
          onExecution: () => {
            this.context.endManipulation()
          }
        },
        {
          nextStateName: CursorStates.Hidden,
          checkOnSignal: (signal) => signal === "TrackLost",
          onExecution: () => {
            this.context.endManipulation()
          }
        },
        {
          nextStateName: CursorStates.Override,
          checkOnSignal: (signal) => signal === "OverrideOn",
          onExecution: () => {
            this.context.endManipulation()
          }
        }
      ]
    })
  }

  private runDirectHitInteraction(
    rayOrigin: vec3,
    rayDir: vec3,
    directHitRecord: DirectHitRecord,
    isTriggering: boolean
  ): void {
    this.handleDirectHit(rayOrigin, rayDir, directHitRecord)

    const targetingVisual = this.scoring.getEffectiveTargetingVisual(directHitRecord.interactable)

    const cursorAlpha = targetingVisual === TargetingVisual.Cursor ? 1.0 : 0.0
    const rayAlpha = targetingVisual === TargetingVisual.Ray ? 1.0 : 0.0

    this.updateAndDrawCursor(cursorAlpha, rayAlpha, isTriggering)
  }

  private runFallbackInteraction(
    rayOrigin: vec3,
    rayVector: vec3,
    rayDir: vec3,
    rayLength: number,
    isTriggering: boolean
  ): void {
    if (this.cone.overlappingInteractableEntries.length + this.cone.overlappingPlaneEntries.length === 0) {
      this.updateAndDrawCursor(0.0, 0.0, isTriggering)
      return
    }
    this.scoring.updateInteractableCacheBatch(rayOrigin, rayDir, rayLength)
    const blendResult = this.scoring.blendCachedInteractables(rayLength)

    let cursorAlpha = 0.0
    let rayAlpha = 0.0

    if (blendResult) {
      const overallAlphaNow = Math.max(blendResult.cursorAlpha, blendResult.rayAlpha)
      const smoothed = this.depthSmoother.smoothFallback(
        rayOrigin,
        rayVector,
        rayDir,
        blendResult.targetT,
        overallAlphaNow
      )
      this._cursorPosition = smoothed

      cursorAlpha = blendResult.cursorAlpha
      rayAlpha = blendResult.rayAlpha
    } else {
      // Nothing to target — park cursor at reference distance, keep depth in sync
      // so re-entry to a visible target springs from here rather than snapping.
      this._scratchVec3.copyFrom(rayDir)
      this._scratchVec3.uniformScaleInPlace(REFERENCE_DISTANCE_CM)
      this._scratchVec3.addInPlace(rayOrigin)
      this._cursorPosition.copyFrom(this._scratchVec3)
      this.depthSmoother.keepDepthAt(this._cursorPosition, rayOrigin, rayDir)
    }

    this.updateAndDrawCursor(cursorAlpha, rayAlpha, isTriggering)
  }

  private shouldShowCursorWithMode(activeTargetingMode: TargetingMode): boolean {
    if (
      !this.interactor.enabled ||
      !this.interactor.startPoint ||
      !this.interactor.direction ||
      !this.interactor.isActive() ||
      !this.interactor.isTargeting()
    ) {
      return false
    }

    const isVisibleTargetingMode =
      (activeTargetingMode & (TargetingMode.Poke | TargetingMode.Direct | TargetingMode.None)) === 0
    if (!isVisibleTargetingMode) {
      return false
    }

    return true
  }

  private getDirectHit(): DirectHitRecord | null {
    if (!this._directHitDirty) {
      return this._cachedDirectHit
    }
    this._directHitDirty = false
    const interactable = this._frameCurrentInteractable
    const hitPosition = this._frameTargetHitPosition
    if (interactable && hitPosition) {
      this._cachedDirectHit = {interactable, position: hitPosition}
    } else {
      this._cachedDirectHit = null
    }
    return this._cachedDirectHit
  }

  private handleDirectHit(rayOrigin: vec3, rayDir: vec3, directHitRecord: DirectHitRecord): void {
    const smoothed = this.depthSmoother.smoothDirectHit(
      rayOrigin,
      rayDir,
      directHitRecord.interactable,
      directHitRecord.position
    )
    this._cursorPosition = smoothed
  }

  /**
   * Dispatches the cursor view state for this frame.
   * Does NOT touch depth-spring state — all snap arming is owned by
   * onPathEnter/onPathExit and the DepthSmoother smooth methods.
   */
  private updateAndDrawCursor(cursorAlpha: number, rayAlpha: number, isTriggering: boolean): void {
    const scale = this.calculateCursorScale(this._cursorPosition)

    this._cursorViewState.cursorEnabled = true
    this._cursorViewState.position = this._cursorPosition
    this._cursorViewState.scale = scale
    this._cursorViewState.cursorAlpha = cursorAlpha * this.fadeMultiplier
    this._cursorViewState.rayAlpha = rayAlpha * this.fadeMultiplier
    this._cursorViewState.isTriggering = isTriggering
    this._cursorViewState.isNearField = this._isNearField
    this.onCursorUpdateEvent.invoke(this._cursorViewState)
  }

  private calculateCursorScale(cursorPosition: vec3): number {
    const cameraPos = this.camera.getWorldPosition()
    const distanceSq = cursorPosition.distanceSquared(cameraPos)

    if (this.lastScaleDistanceSq !== null && Math.abs(distanceSq - this.lastScaleDistanceSq) < SCALE_DISTANCE_EPSILON) {
      return this.cachedScale
    }

    this.lastScaleDistanceSq = distanceSq

    if (distanceSq <= this.minDistanceSquared) {
      this.cachedScale = MIN_SCALE
      return MIN_SCALE
    }
    if (distanceSq >= this.maxDistanceSquared) {
      this.cachedScale = MAX_SCALE
      return MAX_SCALE
    }

    const distance = Math.sqrt(distanceSq)
    const idealScale = distance * SCALING_FACTOR
    const tunedScale = REFERENCE_SCALE + (idealScale - REFERENCE_SCALE) * SCALE_COMPENSATION_STRENGTH
    this.cachedScale = tunedScale
    return tunedScale
  }

  private updateWithOverride(isTriggering: boolean, isTracked: boolean): void {
    this._cursorPosition = this.positionOverride!
    const scale = this.calculateCursorScale(this._cursorPosition)

    this._cursorViewState.cursorEnabled = isTracked
    this._cursorViewState.position = this.positionOverride!
    this._cursorViewState.scale = scale
    this._cursorViewState.cursorAlpha = isTracked ? 1.0 * this.fadeMultiplier : 0
    this._cursorViewState.rayAlpha = 0.0
    this._cursorViewState.isTriggering = isTriggering
    this._cursorViewState.isNearField = this._isNearField
    this.onCursorUpdateEvent.invoke(this._cursorViewState)
  }

  private hideCursor(isTriggering: boolean): void {
    this._cursorViewState.cursorEnabled = false
    this._cursorViewState.position = this._cursorPosition
    this._cursorViewState.scale = MIN_SCALE
    this._cursorViewState.cursorAlpha = 0.0
    this._cursorViewState.rayAlpha = 0.0
    this._cursorViewState.isTriggering = isTriggering
    this._cursorViewState.isNearField = this._isNearField
    this.onCursorUpdateEvent.invoke(this._cursorViewState)
  }
}
