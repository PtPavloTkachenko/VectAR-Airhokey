import {HandType} from "../../../Providers/HandInputData/HandType"
import {LensConfig} from "../../../Utils/LensConfig"
import NativeLogger from "../../../Utils/NativeLogger"
import {DispatchedUpdateEvent} from "../../../Utils/UpdateDispatcher"
import {validate} from "../../../Utils/validate"
import {CursorMode} from "./InteractorCursor"

const TAG = "PointerCursorVisual"

export type PointerCursorVisualTextureConfig = {
  disabled: Texture
}

export type PointerCursorVisualConfig = {
  meshSceneObject: SceneObject
  textures: PointerCursorVisualTextureConfig
}

export type PointerCursorVisualMaterialParameters = {
  progress: number
  baseAlpha: number
  masterAlpha: number
  timerFillAmount: number
  timerStartAngle: number
  timerThicknessMult: number
  nonInteractableProgress: number
  strokeArcExtent: number
  strokeArcCenter: number
  unifyingProgress: number
  unifyingAlpha: number
  useTexture: boolean
  cursorTexture: Texture
}

// The CursorMat graph uses -1 and 1 to represent the left/right hand.
export const enum CursorMaterialHandType {
  Left = -1,
  NonHand = 0,
  Right = 1
}

const DEFAULT_RENDER_ORDER = 100
const DEFAULT_SCALE = new vec3(2.5, 2.5, 2.5)
const EPSILON = 1e-4

// Shader design constants — set once in the constructor.
const STROKE_RADIUS = 0.2
const CORE_SCALE = 0.5
const MATERIAL_CORE_RADIUS = 0.25
const MATERIAL_STROKE_THICKNESS = 0.05
const MATERIAL_TIMER_RADIUS = 0.2
const MATERIAL_TIMER_THICKNESS = 0.05
const BASE_CORE_SCALE_MULTIPLIER = 1.35
const BASE_STROKE_SCALE_MULTIPLIER = 2.0

/**
 * Pure rendering sink for the cursor visual.
 *
 * Caches animator output via individual setters; flushes dirty values to the
 * shader once per frame in {@link onUpdate}. Visibility and the master-alpha
 * spring live on the parent {@link InteractorCursor}.
 */
export class PointerCursorVisual {
  private _cursorMode: CursorMode = CursorMode.Auto
  private _useTexture = false
  private _materialTexture: Texture | null = null
  private _customTexture: Texture | null = null

  // Cached uniform values — set by InteractorCursor, flushed in onUpdate.

  private _overallOpacity = 0
  private _progress = 0
  private _baseAlpha = 0.5
  private _timerFillAmount = 0
  private _timerStartAngle = Math.PI / 2
  private _timerThicknessMult = 0
  private _nonInteractableProgress = 0
  private _strokeArcExtent = Math.PI * 2
  private _strokeArcCenter = 0
  private _unifyingProgress = 0
  private _unifyingAlpha = 0

  private renderedMasterAlpha = -1.0
  private renderedProgress = -1.0
  private renderedBaseAlpha = -1.0
  private renderedTimerFill = -1.0
  private renderedTimerAngle = -1.0
  private renderedTimerThickness = -1.0
  private renderedNonInteractable = -1.0
  private renderedStrokeArcExtent = -1.0
  private renderedStrokeArcCenter = -1.0
  private renderedUnifyingProgress = -1.0
  private renderedUnifyingAlpha = -1.0

  // Engine references
  private logger = new NativeLogger(TAG)

  private _transform = this.sceneObject.getTransform()
  private visual = this.sceneObject.getComponent("Component.RenderMeshVisual")
  private updateEvent?: DispatchedUpdateEvent

  private _material: Material

  constructor(private config: PointerCursorVisualConfig) {
    this._material = this.visual.mainMaterial.clone()
    this.visual.mainMaterial = this._material
    this.renderOrder = DEFAULT_RENDER_ORDER
    this.transform.setWorldScale(DEFAULT_SCALE)
    this.initializeShaderConstants()
  }

  /** Cloned material; parent binds to the shared RMV when active. */
  get material(): Material {
    return this._material
  }

  /**
   * Pushes static design constants to the shader. Called once at construction.
   */
  private initializeShaderConstants(): void {
    const pass = this._material.mainPass
    pass.strokeRadius = STROKE_RADIUS
    pass.coreScale = CORE_SCALE
    pass.materialCoreRadius = MATERIAL_CORE_RADIUS
    pass.materialStrokeThickness = MATERIAL_STROKE_THICKNESS
    pass.materialTimerRadius = MATERIAL_TIMER_RADIUS
    pass.materialTimerThickness = MATERIAL_TIMER_THICKNESS
    pass.baseCoreScaleMultiplier = BASE_CORE_SCALE_MULTIPLIER
    pass.baseStrokeScaleMultiplier = BASE_STROKE_SCALE_MULTIPLIER

    // Initialize dynamic uniforms to safe defaults
    pass.progress = 0
    pass.baseAlpha = 0.5
    pass.baseColor = new vec4(1, 1, 1, 1)
    pass.timerFillAmount = 0
    pass.timerStartAngle = Math.PI / 2
    pass.timerThicknessMult = 0
    pass.nonInteractableProgress = 0
    pass.strokeArcExtent = Math.PI * 2
    pass.strokeArcCenter = 0
    pass.unifyingProgress = 0
    pass.unifyingAlpha = 0
    pass.masterAlpha = 0
  }

  // Transform
  get transform(): Transform {
    return this._transform
  }

  get sceneObject(): SceneObject {
    return this.config.meshSceneObject
  }

  set worldPosition(position: vec3) {
    this.transform.setWorldPosition(position)
  }

  get worldPosition(): vec3 {
    return this.transform.getWorldPosition()
  }

  set worldScale(scale: vec3) {
    this.transform.setWorldScale(scale)
  }

  get worldScale(): vec3 {
    return this.transform.getWorldScale()
  }

  // Lifecycle
  onStart(eventLabel?: string): void {
    const dispatcher = LensConfig.getInstance().updateDispatcher
    const nameSuffix = eventLabel ?? this.sceneObject.name
    const eventName = `PointerCursorVisualUpdate_${nameSuffix}`
    this.updateEvent = dispatcher.createUpdateEvent(eventName, () => this.onUpdate())
    this.updateEvent.enabled = false
  }

  enableUpdateEvent(enabled: boolean): void {
    if (this.updateEvent) {
      this.updateEvent.enabled = enabled
    }
  }

  destroy(): void {
    if (this.updateEvent) {
      LensConfig.getInstance().updateDispatcher.removeEvent(this.updateEvent)
      this.updateEvent = undefined
    }
  }

  // Animation state setters (called by InteractorCursor)
  /** Visual progression from idle ring (0) to pressed unified circle (1). */
  set progress(value: number) {
    this._progress = value
  }

  /** Base opacity: 0.5 when released, 1.0 when pressed. */
  set baseAlpha(value: number) {
    this._baseAlpha = value
  }

  /** Timer arc fill amount, 0 (empty) to 1 (full). */
  set timerFillAmount(value: number) {
    this._timerFillAmount = value
  }

  /** Timer arc start angle in radians. */
  set timerStartAngle(value: number) {
    this._timerStartAngle = value
  }

  /** Timer arc thickness multiplier for ramp-in and thin-out. */
  set timerThicknessMult(value: number) {
    this._timerThicknessMult = value
  }

  /** 0 when hovering over an interactable, 1 when not. */
  set nonInteractableProgress(value: number) {
    this._nonInteractableProgress = value
  }

  /** Stroke arc extent in radians. 2π for full ring, π for half in two-hand mode. */
  set strokeArcExtent(value: number) {
    this._strokeArcExtent = value
  }

  /** Stroke arc center angle in radians. Positioned by hand type. */
  set strokeArcCenter(value: number) {
    this._strokeArcCenter = value
  }

  /** Two-hand unifying circle grow progress, 0 (hidden) to 1 (full). */
  set unifyingProgress(value: number) {
    this._unifyingProgress = value
  }

  /** Two-hand unifying circle release fade alpha. */
  set unifyingAlpha(value: number) {
    this._unifyingAlpha = value
  }

  // Overall opacity
  /** Final cursor opacity (already spring-smoothed by the parent). */
  set overallOpacity(opacity: number) {
    this._overallOpacity = opacity
  }

  get overallOpacity(): number {
    return this._overallOpacity
  }

  // Texture mode
  set useTexture(useTexture: boolean) {
    if (useTexture === this._useTexture) {
      return
    }
    this._material.mainPass.useTexture = useTexture
    this._useTexture = useTexture
  }

  get useTexture(): boolean {
    return this._useTexture
  }

  set materialTexture(texture: Texture) {
    if (texture === this._materialTexture) {
      return
    }
    this._material.mainPass.cursorTexture = texture
    this._materialTexture = texture
  }

  get materialTexture(): Texture | null {
    return this._materialTexture
  }

  set customTexture(texture: Texture) {
    if (texture === this._customTexture) {
      return
    }
    if (this.cursorMode === CursorMode.Custom) {
      this.materialTexture = texture
    }
    this._customTexture = texture
  }

  get customTexture(): Texture | null {
    return this._customTexture
  }

  /**
   * Set the {@link CursorMode} to change the visual.
   * Use {@link CursorMode}.Auto to return to the default procedural cursor.
   */
  set cursorMode(cursorMode: CursorMode) {
    if (cursorMode === this.cursorMode) {
      return
    }

    this.useTexture = cursorMode !== CursorMode.Auto

    switch (cursorMode) {
      case CursorMode.Auto:
        break
      case CursorMode.Disabled:
        this.materialTexture = this.config.textures.disabled
        break
      case CursorMode.Custom:
        validate(this.customTexture)
        this.materialTexture = this.customTexture
        break
      default:
        // Manip modes are routed to ManipulationCursorVisual by InteractorCursor.
        this.logger.w(`PointerCursorVisual received unsupported mode: ${cursorMode}`)
        return
    }

    this._cursorMode = cursorMode
  }

  get cursorMode(): CursorMode {
    return this._cursorMode
  }

  // Render order
  set renderOrder(renderOrder: number) {
    this.visual.setRenderOrder(renderOrder)
  }

  get renderOrder(): number {
    return this.visual.getRenderOrder()
  }

  // Hand type
  set handType(type: HandType | null) {
    let materialInput: number
    switch (type) {
      case "left":
        materialInput = CursorMaterialHandType.Left
        break
      case "right":
        materialInput = CursorMaterialHandType.Right
        break
      default:
        materialInput = CursorMaterialHandType.NonHand
    }
    this._material.mainPass.handType = materialInput
  }

  get handType(): HandType | null {
    switch (this._material.mainPass.handType) {
      case -1:
        return "left"
      case 1:
        return "right"
      default:
        return null
    }
  }

  // Material parameters snapshot
  // Reused across reads to avoid per-call allocation.
  private _materialParameters: PointerCursorVisualMaterialParameters = {
    progress: 0,
    baseAlpha: 0.5,
    masterAlpha: 0,
    timerFillAmount: 0,
    timerStartAngle: Math.PI / 2,
    timerThicknessMult: 0,
    nonInteractableProgress: 0,
    strokeArcExtent: Math.PI * 2,
    strokeArcCenter: 0,
    unifyingProgress: 0,
    unifyingAlpha: 0,
    useTexture: false,
    cursorTexture: null as unknown as Texture
  }

  get materialParameters(): PointerCursorVisualMaterialParameters {
    const p = this._materialParameters
    p.progress = this._progress
    p.baseAlpha = this._baseAlpha
    p.masterAlpha = this._overallOpacity
    p.timerFillAmount = this._timerFillAmount
    p.timerStartAngle = this._timerStartAngle
    p.timerThicknessMult = this._timerThicknessMult
    p.nonInteractableProgress = this._nonInteractableProgress
    p.strokeArcExtent = this._strokeArcExtent
    p.strokeArcCenter = this._strokeArcCenter
    p.unifyingProgress = this._unifyingProgress
    p.unifyingAlpha = this._unifyingAlpha
    p.useTexture = this._material.mainPass.useTexture
    p.cursorTexture = this._material.mainPass.cursorTexture
    return p
  }

  // Per-frame rendering
  private onUpdate(): void {
    const pass = this._material.mainPass

    if (Math.abs(this._overallOpacity - this.renderedMasterAlpha) > EPSILON) {
      pass.masterAlpha = this._overallOpacity
      this.renderedMasterAlpha = this._overallOpacity
    }

    if (Math.abs(this._progress - this.renderedProgress) > EPSILON) {
      pass.progress = this._progress
      this.renderedProgress = this._progress
    }

    if (Math.abs(this._baseAlpha - this.renderedBaseAlpha) > EPSILON) {
      pass.baseAlpha = this._baseAlpha
      this.renderedBaseAlpha = this._baseAlpha
    }

    if (Math.abs(this._timerFillAmount - this.renderedTimerFill) > EPSILON) {
      pass.timerFillAmount = this._timerFillAmount
      this.renderedTimerFill = this._timerFillAmount
    }

    if (Math.abs(this._timerStartAngle - this.renderedTimerAngle) > EPSILON) {
      pass.timerStartAngle = this._timerStartAngle
      this.renderedTimerAngle = this._timerStartAngle
    }

    if (Math.abs(this._timerThicknessMult - this.renderedTimerThickness) > EPSILON) {
      pass.timerThicknessMult = this._timerThicknessMult
      this.renderedTimerThickness = this._timerThicknessMult
    }

    if (Math.abs(this._nonInteractableProgress - this.renderedNonInteractable) > EPSILON) {
      pass.nonInteractableProgress = this._nonInteractableProgress
      this.renderedNonInteractable = this._nonInteractableProgress
    }

    if (Math.abs(this._strokeArcExtent - this.renderedStrokeArcExtent) > EPSILON) {
      pass.strokeArcExtent = this._strokeArcExtent
      this.renderedStrokeArcExtent = this._strokeArcExtent
    }

    if (Math.abs(this._strokeArcCenter - this.renderedStrokeArcCenter) > EPSILON) {
      pass.strokeArcCenter = this._strokeArcCenter
      this.renderedStrokeArcCenter = this._strokeArcCenter
    }

    if (Math.abs(this._unifyingProgress - this.renderedUnifyingProgress) > EPSILON) {
      pass.unifyingProgress = this._unifyingProgress
      this.renderedUnifyingProgress = this._unifyingProgress
    }

    if (Math.abs(this._unifyingAlpha - this.renderedUnifyingAlpha) > EPSILON) {
      pass.unifyingAlpha = this._unifyingAlpha
      this.renderedUnifyingAlpha = this._unifyingAlpha
    }
  }
}
