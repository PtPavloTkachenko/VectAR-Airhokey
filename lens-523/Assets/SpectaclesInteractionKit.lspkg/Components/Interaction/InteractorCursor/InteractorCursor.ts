import BaseInteractor from "../../../Core/Interactor/BaseInteractor"
import {Interactor, InteractorInputType, InteractorTriggerType} from "../../../Core/Interactor/Interactor"
import WorldCameraFinderProvider from "../../../Providers/CameraProvider/WorldCameraFinderProvider"
import {CursorControllerProvider} from "../../../Providers/CursorControllerProvider/CursorControllerProvider"
import {HandInputData} from "../../../Providers/HandInputData/HandInputData"
import {HandType} from "../../../Providers/HandInputData/HandType"
import Event from "../../../Utils/Event"
import NativeLogger from "../../../Utils/NativeLogger"
import {SpringAnimate1D, step1DInstantDrop} from "../../../Utils/springAnimate"
import {validate} from "../../../Utils/validate"
import {RAY_VISIBILITY_THRESHOLD} from "../InteractorRayVisual/InteractorRayVisual"
import {CursorAnimator, HAND_CONFIRM_MS, HAND_RELEASE_MS} from "./CursorAnimator"
import type {CursorController} from "./CursorController"
import {CursorViewModel, CursorViewState} from "./CursorViewModel"
import {ManipulationCursorVisual} from "./ManipulationCursorVisual"
import {
  CursorMaterialHandType,
  PointerCursorVisual,
  PointerCursorVisualConfig,
  PointerCursorVisualMaterialParameters
} from "./PointerCursorVisual"

const VISIBILITY_THRESHOLD = 0.01
const DEFAULT_HOLD_THRESHOLD_MS = 800
const POSITION_EPSILON_SQ = 1e-4
const SCALE_EPSILON = 1e-2
const ALPHA_EPSILON = 1e-2
// Skip billboard rotation when the unit-direction has moved less than ~0.06° from cached.
const BILLBOARD_DIR_EPSILON_SQ = 1e-6
const MIN_LENGTH_SQ = 1e-8

function handTypeToMaterial(handType: HandType | null): CursorMaterialHandType {
  if (handType === "left") return CursorMaterialHandType.Left
  if (handType === "right") return CursorMaterialHandType.Right
  return CursorMaterialHandType.NonHand
}

export enum CursorMode {
  Auto = "Auto",
  Translate = "Translate",
  ScaleTopLeft = "ScaleTopLeft",
  ScaleTopRight = "ScaleTopRight",
  Disabled = "Disabled",
  Custom = "Custom"
}

export type CursorParameters = {
  worldPosition: vec3
  worldRotation: vec3
  worldScale: vec3
  isShown: boolean

  /** @deprecated v3 — use `masterAlpha` (visual is no longer driven by maxAlpha). */
  maxAlpha?: number
  /** @deprecated v3 — use `baseAlpha` (no separate outline in v3). */
  outlineAlpha?: number
  /** @deprecated v3 — outline offset has no v3 equivalent; always 0. */
  outlineOffset?: number
  /** @deprecated v3 — squish has no v3 equivalent; always 1. */
  circleSquishScale?: number
  /** @deprecated v3 — use the animator's `isClosed` instead. */
  isTriggering?: boolean
  /** @deprecated v3 — read `interactor.inputType` or use {@link CursorMaterialHandType} via the cursor material. */
  handType?: CursorMaterialHandType
  /** @deprecated v3 — call {@link CursorControllerProvider.hasConvergedActiveCursors}. */
  multipleInteractorsActive?: boolean
} & PointerCursorVisualMaterialParameters

const TAG = "InteractorCursor"

/**
 * Bridges the cursor's positioning model ({@link CursorViewModel}), interaction
 * animation ({@link CursorAnimator}), and the two render sinks
 * ({@link PointerCursorVisual} and {@link ManipulationCursorVisual}).
 *
 * Each frame the ViewModel emits a {@link CursorViewState}; this component
 * ticks the animator, steps the shared alpha spring, swaps the active visual's
 * material when {@link cursorMode} changes, and toggles SceneObject visibility.
 */
@component
export class InteractorCursor extends BaseScriptComponent {
  @input("Component.ScriptComponent")
  @allowUndefined
  @hint(
    "Reference to the component that this cursor will visualize. The cursor will update its position and appearance \
based on the interactor's state."
  )
  _interactor?: BaseInteractor

  @input
  @hint("Enable debug rendering for this cursor (cone collider, center ray, and closest-point helpers)")
  drawDebug: boolean = false

  private log = new NativeLogger(TAG)

  private pointerVisual!: PointerCursorVisual
  private pointerVisualConfig!: PointerCursorVisualConfig
  private manipulationVisual!: ManipulationCursorVisual
  private rmv!: RenderMeshVisual
  private viewModel!: CursorViewModel
  private animator!: CursorAnimator
  private cameraTransform = WorldCameraFinderProvider.getInstance().getTransform()

  private _cursorAlpha: number = 0.0
  private _rayAlpha: number = 0.0
  private _wasRayVisible: boolean = false

  public get cursorAlpha(): number {
    return this._cursorAlpha
  }

  private cursorController = CursorControllerProvider.getInstance()
  private handInputData = HandInputData.getInstance()

  private _handType: HandType | null = null
  private isHandInteractor = false
  private tempScaleVec = new vec3(1, 1, 1)
  private tempBillboardVec = new vec3(0, 0, 0)
  private lastBillboardDirX = Number.NaN
  private lastBillboardDirY = 0
  private lastBillboardDirZ = 0

  // Spring-smoothed master opacity, shared between both visuals.
  private alphaSpring = SpringAnimate1D.snappy(0.25)
  private currentSpringAlpha = 0.0
  private targetSpringAlpha = 0.0
  private _isShown = false

  // Cache for expensive property updates
  private lastCursorPosition = new vec3(0, 0, 0)
  private lastCursorScale = -1
  private lastAppliedOpacity = -1

  // Events
  private onEnableChangedEvent = new Event<boolean>()
  private onRayVisibilityChangedEvent = new Event<boolean>()

  /**
   * Called whenever the cursor changes enabled state (showing / hiding the cursor visual).
   */
  onEnableChanged = this.onEnableChangedEvent.publicApi()

  /**
   * Called whenever the ray visibility changes (becomes visible or invisible based on rayAlpha threshold).
   */
  onRayVisibilityChanged = this.onRayVisibilityChangedEvent.publicApi()

  // Ray alpha
  public get rayAlpha(): number {
    return this._rayAlpha
  }

  public set rayAlpha(value: number) {
    this._rayAlpha = value

    const isNowVisible = value > RAY_VISIBILITY_THRESHOLD

    if (isNowVisible !== this._wasRayVisible) {
      this._wasRayVisible = isNowVisible
      this.onRayVisibilityChangedEvent.invoke(isNowVisible)
    }
  }

  // Show / Hide
  /**
   * Shows the cursor visual.
   * @param duration - The fade in duration.
   */
  public show(duration: number = 0.2): void {
    if (this.viewModel) {
      this.viewModel.fadeIn(duration)
    }
  }

  /**
   * Hides the cursor visual.
   * @param duration - The fade out duration.
   */
  public hide(duration: number = 0.2): void {
    if (this.viewModel) {
      this.viewModel.fadeOut(duration)
    }
  }

  // Init
  /** Initializes the cursor. Called by {@link CursorController} after creation. */
  init(_caller: CursorController) {}

  // Interactor
  set interactor(interactor: BaseInteractor) {
    validate(interactor, "InteractorCursor cannot have an undefined Interactor reference.")

    if (this.interactor !== null) {
      this.log.f(`InteractorCursor's Interactor has already been set to: ${this.interactor?.sceneObject?.name}`)
    }

    this._interactor = interactor as BaseInteractor
  }

  get interactor(): BaseInteractor | null {
    return this._interactor ?? null
  }

  // Cursor position
  /**
   * Get the world position of this interactor's cursor visual.
   */
  get cursorPosition(): vec3 | null {
    return this.viewModel.cursorPosition
  }

  /**
   * Set the world position of this interactor's cursor visual.
   * @param position - vec3 of the worldPosition, null to revert to default raycast behavior.
   */
  set cursorPosition(position: vec3 | null) {
    this.viewModel.positionOverride = position
  }

  // Cursor mode
  private _cursorMode: CursorMode = CursorMode.Auto

  /**
   * Set the {@link CursorMode}. Auto/Disabled/Custom use {@link PointerCursorVisual};
   * Translate/ScaleTopLeft/ScaleTopRight use {@link ManipulationCursorVisual}. Swaps
   * the shared RMV's material between the two.
   */
  set cursorMode(mode: CursorMode) {
    if (mode === this._cursorMode) {
      return
    }
    const usesManip =
      mode === CursorMode.Translate || mode === CursorMode.ScaleTopLeft || mode === CursorMode.ScaleTopRight
    if (usesManip) {
      this.manipulationVisual.cursorMode = mode
      this.rmv.mainMaterial = this.manipulationVisual.material
      this.pointerVisual.enableUpdateEvent(false)
      this.manipulationVisual.enableUpdateEvent(true)
    } else {
      this.pointerVisual.cursorMode = mode
      this.rmv.mainMaterial = this.pointerVisual.material
      this.manipulationVisual.enableUpdateEvent(false)
      this.pointerVisual.enableUpdateEvent(true)
    }
    this._cursorMode = mode
  }

  get cursorMode(): CursorMode {
    return this._cursorMode
  }

  /**
   * Set the {@link Texture} of the cursor when using {@link CursorMode}.Custom.
   * Must explicitly set the {@link CursorMode} to Custom before the texture appears.
   */
  set customTexture(texture: Texture) {
    this.pointerVisual.customTexture = texture
  }

  /**
   * Set the render order of the cursor visual.
   */
  set renderOrder(renderOrder: number) {
    this.pointerVisual.renderOrder = renderOrder
  }

  /**
   * Returns the transform and material parameters of the cursor to allow other
   * cursor implementations to re-use the same values.
   */
  get cursorParameters(): CursorParameters {
    const transform = this.pointerVisual.transform
    const materialParameters = this.pointerVisual.materialParameters

    return {
      worldPosition: transform.getWorldPosition(),
      worldRotation: transform.getWorldRotation().toEulerAngles(),
      worldScale: transform.getWorldScale(),
      isShown: this._isShown,
      ...materialParameters,
      // Deprecated v1/v2 fields — kept populated for backward compatibility.
      maxAlpha: materialParameters.masterAlpha,
      outlineAlpha: materialParameters.baseAlpha,
      outlineOffset: 0,
      circleSquishScale: 1,
      isTriggering: this.animator?.isClosed ?? false,
      handType: handTypeToMaterial(this._handType),
      multipleInteractorsActive: this.cursorController.hasConvergedActiveCursors()
    }
  }

  // Visual SceneObject
  visual!: SceneObject

  // Lifecycle
  onAwake(): void {
    this.defineScriptEvents()

    this.visual = this.createVisual()
    this.visual.enabled = false
    this.pointerVisualConfig = {
      meshSceneObject: this.visual,
      textures: {
        disabled: requireAsset("./disabled.png") as Texture
      }
    }
    this.pointerVisual = new PointerCursorVisual(this.pointerVisualConfig)
    this.manipulationVisual = new ManipulationCursorVisual({
      material: requireAsset("./ManipCursor.mat") as Material
    })
  }

  private createVisual(): SceneObject {
    const visual = global.scene.createSceneObject("CursorVisual")
    visual.setParent(this.getSceneObject())

    const visualMesh = visual.createComponent("Component.RenderMeshVisual")
    visualMesh.mesh = requireAsset("./UnitPlane.mesh") as RenderMesh
    visualMesh.mainMaterial = requireAsset("./Cursor.mat") as Material

    this.rmv = visualMesh
    return visual
  }

  private defineScriptEvents(): void {
    this.createEvent("OnEnableEvent").bind(() => this.show())
    this.createEvent("OnDisableEvent").bind(() => this.hide())
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
    this.createEvent("OnStartEvent").bind(() => this.onStart())
  }

  private onStart(): void {
    if (this.interactor === null) {
      this.log.f("InteractorCursor must have an Interactor set immediately after initialization.")
      return
    }

    if (this.cursorController.getCursorByInteractor(this.interactor) === null) {
      this.cursorController.registerCursor(this)
    }

    const interactor = this.interactor as Interactor

    this.viewModel = new CursorViewModel(interactor)
    this.viewModel.setDebugDraw(this.drawDebug)
    this.viewModel.onCursorUpdate.add(this.onCursorUpdate)

    this._handType = this.deriveHandType(interactor.inputType)
    this.pointerVisual.handType = this._handType
    this.isHandInteractor = (interactor.inputType & InteractorInputType.BothHands) !== 0
    this.animator = this.isHandInteractor
      ? new CursorAnimator(HAND_CONFIRM_MS, HAND_RELEASE_MS)
      : new CursorAnimator(0, 0)

    const eventLabel = `${interactor.inputType}`
    this.pointerVisual.onStart(eventLabel)
    this.manipulationVisual.onStart(eventLabel)

    this.viewModel.enableUpdateEvent(true)
    const usesManip =
      this._cursorMode === CursorMode.Translate ||
      this._cursorMode === CursorMode.ScaleTopLeft ||
      this._cursorMode === CursorMode.ScaleTopRight
    if (usesManip) {
      this.manipulationVisual.enableUpdateEvent(true)
    } else {
      this.pointerVisual.enableUpdateEvent(true)
    }
  }

  private deriveHandType(inputType: InteractorInputType): HandType | null {
    switch (inputType) {
      case InteractorInputType.LeftHand:
        return "left"
      case InteractorInputType.RightHand:
        return "right"
      default:
        return null
    }
  }

  // Per-frame bridge
  private onCursorUpdate = (viewState: CursorViewState) => {
    // ViewModel → public state
    this._cursorAlpha = viewState.cursorAlpha
    this.rayAlpha = viewState.rayAlpha

    const trigger = this.interactor?.currentTrigger ?? InteractorTriggerType.None

    // 1. Tick animator
    this.animator.tick({
      interactionStrength: this.isHandInteractor
        ? (this.interactor?.interactionStrength ?? 0)
        : viewState.isTriggering
          ? 1
          : 0,
      isPinchTriggerActive: this.isHandInteractor ? trigger === InteractorTriggerType.Pinch : viewState.isTriggering,
      nearFieldDistCm: viewState.isNearField ? this.computeNearFieldDistCm(viewState.position) : null,
      isPokeTriggerActive: trigger === InteractorTriggerType.Poke,
      isNonInteractable: this.interactor?.targetHitInfo === null,
      holdTimerProgress: this.interactor?.holdTimerProgress ?? 0,
      holdThresholdMs: this.interactor?.secondaryTriggerHoldThreshold ?? DEFAULT_HOLD_THRESHOLD_MS,
      isSecondaryTriggering: this.interactor?.isSecondaryTriggering ?? false,
      multipleInteractorsActive: this.cursorController.hasConvergedActiveCursors(),
      handType: handTypeToMaterial(this._handType),
      dtMs: getDeltaTime() * 1000
    })

    // 2. Animator → visual
    this.pointerVisual.progress = this.animator.progress
    this.pointerVisual.baseAlpha = this.animator.baseAlpha
    this.pointerVisual.timerFillAmount = this.animator.timerFillAmount
    this.pointerVisual.timerStartAngle = this.animator.timerStartAngle
    this.pointerVisual.timerThicknessMult = this.animator.timerThicknessMult
    this.pointerVisual.nonInteractableProgress = this.animator.nonInteractableProgress
    this.pointerVisual.strokeArcExtent = this.animator.strokeArcExtent
    this.pointerVisual.strokeArcCenter = this.animator.strokeArcCenter
    this.pointerVisual.unifyingProgress = this.animator.unifyingProgress
    this.pointerVisual.unifyingAlpha = this.animator.unifyingAlpha

    // ManipulationCursorVisual only needs press/alpha state.
    this.manipulationVisual.progress = this.animator.progress
    this.manipulationVisual.baseAlpha = this.animator.baseAlpha

    // 3. Position, scale, visibility
    this.applyTransform(viewState)
  }

  private applyTransform(viewState: CursorViewState): void {
    this.targetSpringAlpha = viewState.cursorAlpha
    this.currentSpringAlpha = step1DInstantDrop(this.currentSpringAlpha, this.targetSpringAlpha, this.alphaSpring)

    if (Math.abs(this.currentSpringAlpha - this.lastAppliedOpacity) > ALPHA_EPSILON) {
      this.pointerVisual.overallOpacity = this.currentSpringAlpha
      this.manipulationVisual.overallOpacity = this.currentSpringAlpha
      this.lastAppliedOpacity = this.currentSpringAlpha

      const isVisible = this.currentSpringAlpha > VISIBILITY_THRESHOLD
      if (isVisible !== this._isShown) {
        this.visual.enabled = isVisible
        this._isShown = isVisible
        this.onEnableChangedEvent.invoke(isVisible)
      }
    }

    if (viewState.cursorEnabled) {
      if (viewState.position.distanceSquared(this.lastCursorPosition) > POSITION_EPSILON_SQ) {
        this.pointerVisual.worldPosition = viewState.position
        this.lastCursorPosition.x = viewState.position.x
        this.lastCursorPosition.y = viewState.position.y
        this.lastCursorPosition.z = viewState.position.z
      }

      if (Math.abs(viewState.scale - this.lastCursorScale) > SCALE_EPSILON) {
        this.tempScaleVec.x = viewState.scale
        this.tempScaleVec.y = viewState.scale
        this.tempScaleVec.z = viewState.scale
        this.pointerVisual.transform.setWorldScale(this.tempScaleVec)
        this.lastCursorScale = viewState.scale
      }

      // Constrained-up billboard — avoids head-roll bleed. Skip the bridge write
      // when the unit direction hasn't moved past BILLBOARD_DIR_EPSILON_SQ.
      const camPos = this.cameraTransform.getWorldPosition()
      const dx = camPos.x - viewState.position.x
      const dy = camPos.y - viewState.position.y
      const dz = camPos.z - viewState.position.z
      const lenSq = dx * dx + dy * dy + dz * dz
      if (lenSq > MIN_LENGTH_SQ) {
        const inv = 1.0 / Math.sqrt(lenSq)
        const nx = dx * inv
        const ny = dy * inv
        const nz = dz * inv
        const ddx = nx - this.lastBillboardDirX
        const ddy = ny - this.lastBillboardDirY
        const ddz = nz - this.lastBillboardDirZ
        if (Number.isNaN(this.lastBillboardDirX) || ddx * ddx + ddy * ddy + ddz * ddz > BILLBOARD_DIR_EPSILON_SQ) {
          this.lastBillboardDirX = nx
          this.lastBillboardDirY = ny
          this.lastBillboardDirZ = nz
          this.tempBillboardVec.x = dx
          this.tempBillboardVec.y = dy
          this.tempBillboardVec.z = dz
          this.pointerVisual.transform.setWorldRotation(quat.lookAt(this.tempBillboardVec, vec3.up()))
        }
      }
    }
  }

  private computeNearFieldDistCm(cursorPosition: vec3): number | null {
    if (this._handType === null) return null
    const fingerPos = this.handInputData.getHand(this._handType).indexTip?.position
    if (fingerPos == null) return null
    return fingerPos.distance(cursorPosition)
  }

  // Cleanup
  private onDestroy(): void {
    this.viewModel.destroy()
    this.pointerVisual.destroy()
    this.manipulationVisual.destroy()
    this.visual.destroy()
  }
}
