import {LensConfig} from "../../../Utils/LensConfig"
import NativeLogger from "../../../Utils/NativeLogger"
import {DispatchedUpdateEvent} from "../../../Utils/UpdateDispatcher"
import {CursorMode} from "./InteractorCursor"

const TAG = "ManipulationCursorVisual"

const EPSILON = 1e-4

// Shader design constants
const ARROW_DISTANCE = 0.4
const ARROW_HEIGHT = 0.14
const ARROW_BASE_HALF = 0.14
const ARROW_ROUNDING = 0.035
const CORE_RADIUS = 0.1
const PRESS_SCALE = 1.0
const TRANSLATE_PRESS_DISTANCE = 0.15
const SCALE_PRESS_DISTANCE = 0.15

export type ManipulationCursorVisualConfig = {
  material: Material
}

/**
 * Rendering sink for Translate / ScaleTopLeft / ScaleTopRight cursor modes.
 * Owns a cloned material; parent binds it to the shared RMV when active.
 * Caches setter values; flushes dirty uniforms once per frame in {@link onUpdate}.
 */
export class ManipulationCursorVisual {
  private logger = new NativeLogger(TAG)

  private _material: Material
  private pass: Pass
  private updateEvent?: DispatchedUpdateEvent

  // Cached uniforms
  private _progress = 0
  private _baseAlpha = 1
  private _overallOpacity = 0
  private _showCore = true
  private _mode: CursorMode = CursorMode.Translate

  private renderedProgress = -1
  private renderedBaseAlpha = -1
  private renderedMasterAlpha = -1
  private renderedShowCore = -1
  private renderedMode: CursorMode | null = null

  constructor(private config: ManipulationCursorVisualConfig) {
    this._material = config.material.clone()
    this.pass = this._material.mainPass
    this.initializeConstants()
  }

  /** Cloned material; parent binds to the shared RMV when active. */
  get material(): Material {
    return this._material
  }

  // Lifecycle
  onStart(eventLabel?: string): void {
    const dispatcher = LensConfig.getInstance().updateDispatcher
    const nameSuffix = eventLabel ?? "ManipulationCursor"
    this.updateEvent = dispatcher.createUpdateEvent(`ManipulationCursorVisualUpdate_${nameSuffix}`, () => this.onUpdate())
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

  // Setters
  set progress(value: number) {
    this._progress = value
  }

  set baseAlpha(value: number) {
    this._baseAlpha = value
  }

  set overallOpacity(value: number) {
    this._overallOpacity = value
  }

  set showCore(value: boolean) {
    this._showCore = value
  }

  set cursorMode(mode: CursorMode) {
    if (
      mode !== CursorMode.Translate &&
      mode !== CursorMode.ScaleTopLeft &&
      mode !== CursorMode.ScaleTopRight
    ) {
      this.logger.w(`ManipulationCursorVisual received unsupported mode: ${mode}`)
      return
    }
    this._mode = mode
  }

  get cursorMode(): CursorMode {
    return this._mode
  }

  // Init
  private initializeConstants(): void {
    this.pass.coreRadius = CORE_RADIUS
    this.pass.arrowDistance = ARROW_DISTANCE
    this.pass.arrowHeight = ARROW_HEIGHT
    this.pass.arrowBaseHalf = ARROW_BASE_HALF
    this.pass.arrowRounding = ARROW_ROUNDING
    this.pass.pressScale = PRESS_SCALE
    this.pass.baseColor = new vec4(1, 1, 1, 1)
  }

  private applyModeUniforms(mode: CursorMode): void {
    switch (mode) {
      case CursorMode.Translate:
        this.pass.mode = 0
        this.pass.pressDistance = TRANSLATE_PRESS_DISTANCE
        break
      case CursorMode.ScaleTopLeft:
        this.pass.mode = 1
        this.pass.pressDistance = SCALE_PRESS_DISTANCE
        break
      case CursorMode.ScaleTopRight:
        this.pass.mode = 2
        this.pass.pressDistance = SCALE_PRESS_DISTANCE
        break
    }
  }

  // Per-frame rendering
  private onUpdate(): void {
    if (Math.abs(this._overallOpacity - this.renderedMasterAlpha) > EPSILON) {
      this.pass.masterAlpha = this._overallOpacity
      this.renderedMasterAlpha = this._overallOpacity
    }

    if (Math.abs(this._progress - this.renderedProgress) > EPSILON) {
      this.pass.progress = this._progress
      this.renderedProgress = this._progress
    }

    if (Math.abs(this._baseAlpha - this.renderedBaseAlpha) > EPSILON) {
      this.pass.baseAlpha = this._baseAlpha
      this.renderedBaseAlpha = this._baseAlpha
    }

    const showCoreVal = this._showCore ? 1 : 0
    if (showCoreVal !== this.renderedShowCore) {
      this.pass.showCore = showCoreVal
      this.renderedShowCore = showCoreVal
    }

    if (this._mode !== this.renderedMode) {
      this.applyModeUniforms(this._mode)
      this.renderedMode = this._mode
    }
  }
}
