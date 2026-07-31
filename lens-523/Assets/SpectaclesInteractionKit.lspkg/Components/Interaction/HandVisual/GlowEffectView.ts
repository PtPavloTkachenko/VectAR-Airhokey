import {ProximitySensor} from "../../../Components/Helpers/ProximitySensor"
import {HandInteractor} from "../../../Core/HandInteractor/HandInteractor"
import WorldCameraFinderProvider from "../../../Providers/CameraProvider/WorldCameraFinderProvider"
import {HandInputData} from "../../../Providers/HandInputData/HandInputData"
import {HandType} from "../../../Providers/HandInputData/HandType"
import TrackedHand from "../../../Providers/HandInputData/TrackedHand"
import {LensConfig} from "../../../Utils/LensConfig"
import {DispatchedUpdateEvent, IUpdateDispatcher} from "../../../Utils/UpdateDispatcher"
import {validate} from "../../../Utils/validate"
import {GlowEffectViewModel, GlowEffectViewModelConfig, PinchProperties, PokeProperties} from "./GlowEffectViewModel"
import {HandVisual, HandVisualSelection} from "./HandVisual"

const POKE_DEPTH_MASK_START = 0.65
const POKE_DEPTH_MASK_RANGE = 0.35
const POKE_HIGHLIGHT_GRADIENT_MASK_MIN = 0.0
const POKE_HIGHLIGHT_GRADIENT_MASK_MAX = 0.3
const POKE_OCCLUDE_GRADIENT_MASK_MIN = 0.0
const POKE_OCCLUDE_GRADIENT_MASK_MAX = 0.32
const POKE_GRADIENT_MASK_LERP_SPEED = 10
const POKE_GRADIENT_MASK_CUTOFF = 0.01

const INDEX_GLOW_UP_OFFSET = -0.36
const INDEX_GLOW_FORWARD_OFFSET = -0.25

export type GlowEffectViewStyle = {
  hoverColor: vec4
  triggerColor: vec4
  tipGlowMaterial: Material
  pinchBrightnessMax: number
  pinchGlowBrightnessMax: number
  pinchBrightnessMaxStrength: number
  pinchTriggeredMult: number
  pinchExponent: number
  pinchExponentTriggered: number
  pinchHighlightThresholdFar: number
  pinchHighlightThresholdNear: number
  pokeBrightnessMax: number
  pokeGlowBrightnessMax: number
  pokeTriggeredMult: number
  pokeHighlightThresholdFar: number
  pokeHighlightThresholdNear: number
  pokeOccludeThresholdFar: number
  pokeOccludeThresholdNear: number
  pokeExponent: number
  pokeExponentTriggered: number
  tipGlowRenderOrder: number
  tipGlowWorldScale: number
  triggeredLerpDurationSeconds: number
  pinchValidLerpDurationSeconds: number
  pokeValidLerpDurationSeconds: number
}

export type GlowEffectViewConfig = {
  debugModeEnabled: boolean
  handVisuals: HandVisual
  handType: HandType
  unitPlaneMesh: RenderMesh
  handInteractor: HandInteractor
  handVisualSelection: HandVisualSelection
  proximitySensor: ProximitySensor
  style: GlowEffectViewStyle
}

/**
 * GlowEffectView controls the glow effect that happens when pinching and poking.
 * It works with a ViewModel to separate presentation from logic.
 */
export class GlowEffectView {
  get isMeshVisibilityDesired(): boolean {
    return this.viewModel.isMeshVisibilityDesired
  }

  get isIndexGlowVisible(): boolean {
    return this.viewModel.isIndexGlowVisible
  }

  get isThumbGlowVisible(): boolean {
    return this.viewModel.isThumbGlowVisible
  }

  get indexGlowSceneObject(): SceneObject {
    return this._indexGlowSceneObject
  }

  get thumbGlowSceneObject(): SceneObject {
    return this._thumbGlowSceneObject
  }

  // View-specific properties
  private handVisuals: HandVisual
  private _indexGlowSceneObject!: SceneObject
  private _indexGlowTransform!: Transform
  private _indexGlowMaterial!: Material
  private _thumbGlowSceneObject!: SceneObject
  private _thumbGlowTransform!: Transform
  private _thumbGlowMaterial!: Material
  private debugModeEnabled: boolean

  // Dependencies
  private camera = WorldCameraFinderProvider.getInstance()
  private cameraTransform = this.camera.getTransform()
  private updateDispatcher: IUpdateDispatcher = LensConfig.getInstance().updateDispatcher
  private updateEvent: DispatchedUpdateEvent
  private viewModel: GlowEffectViewModel
  private hand: TrackedHand
  private handInputData = HandInputData.getInstance()

  // Cached material passes to avoid per-frame bridge crossings
  private cachedHandFullPass0: Pass | null = null
  private cachedHandFullPass1: Pass | null = null
  private cachedHandIndexThumbPass0: Pass | null = null
  private cachedHandIndexThumbPass1: Pass | null = null
  private cachedIndexGlowPasses: Pass[] = []
  private cachedThumbGlowPasses: Pass[] = []

  // Caching
  private lastPinchProps: PinchProperties
  private lastPokeProps: PokeProperties
  private lastPokePinchBlend: number = -1
  private lastIndexGlowEnabled: boolean = false
  private lastThumbGlowEnabled: boolean = false
  private lastMeshVisibilityDesired: boolean = true

  // Event handlers
  private onHandFoundCallback!: () => void
  private onHandLostCallback!: () => void

  constructor(private config: GlowEffectViewConfig) {
    this.debugModeEnabled = config.debugModeEnabled
    this.handVisuals = config.handVisuals
    this.hand = this.handInputData.getHand(config.handType)

    // Setup scene objects and materials
    this._indexGlowSceneObject = this.setupGlowSceneObject(
      this.handVisuals.indexTip,
      "indexTipGlowSceneObject",
      new vec3(0, INDEX_GLOW_UP_OFFSET, INDEX_GLOW_FORWARD_OFFSET)
    )
    this._indexGlowTransform = this._indexGlowSceneObject.getTransform()
    this._indexGlowMaterial = this._indexGlowSceneObject.getComponent("Component.RenderMeshVisual").mainMaterial

    this._thumbGlowSceneObject = this.setupGlowSceneObject(this.handVisuals.thumbTip, "thumbTipGlowSceneObject")
    this._thumbGlowTransform = this._thumbGlowSceneObject.getTransform()
    this._thumbGlowMaterial = this._thumbGlowSceneObject.getComponent("Component.RenderMeshVisual").mainMaterial
    // Thumb does not have poke glow
    this._thumbGlowMaterial.mainPass["pokeGlowBrightness"] = 0

    config.proximitySensor.debugModeEnabled = config.debugModeEnabled
    config.proximitySensor.setRadius(
      Math.max(
        config.style.pokeHighlightThresholdFar,
        config.style.pokeOccludeThresholdFar,
        config.style.pinchHighlightThresholdFar,
        config.proximitySensor.radius
      )
    )

    // Create the ViewModel
    const viewModelConfig: GlowEffectViewModelConfig = {
      handInteractor: config.handInteractor,
      handType: config.handType,
      initialHandVisualSelection: config.handVisualSelection,
      style: {
        hoverColor: config.style.hoverColor,
        triggerColor: config.style.triggerColor,
        pinchBrightnessMax: config.style.pinchBrightnessMax,
        pinchGlowBrightnessMax: config.style.pinchGlowBrightnessMax,
        pinchBrightnessMaxStrength: config.style.pinchBrightnessMaxStrength,
        pinchTriggeredMult: config.style.pinchTriggeredMult,
        pinchExponent: config.style.pinchExponent,
        pinchExponentTriggered: config.style.pinchExponentTriggered,
        pinchHighlightThresholdFar: config.style.pinchHighlightThresholdFar,
        pinchHighlightThresholdNear: config.style.pinchHighlightThresholdNear,
        pokeBrightnessMax: config.style.pokeBrightnessMax,
        pokeGlowBrightnessMax: config.style.pokeGlowBrightnessMax,
        pokeTriggeredMult: config.style.pokeTriggeredMult,
        pokeDepthMaskStart: POKE_DEPTH_MASK_START,
        pokeDepthMaskRange: POKE_DEPTH_MASK_RANGE,
        pokeHighlightThresholdFar: config.style.pokeHighlightThresholdFar,
        pokeHighlightThresholdNear: config.style.pokeHighlightThresholdNear,
        pokeOccludeThresholdFar: config.style.pokeOccludeThresholdFar,
        pokeOccludeThresholdNear: config.style.pokeOccludeThresholdNear,
        pokeHighlightGradientMaskMin: POKE_HIGHLIGHT_GRADIENT_MASK_MIN,
        pokeHighlightGradientMaskMax: POKE_HIGHLIGHT_GRADIENT_MASK_MAX,
        pokeOccludeGradientMaskMin: POKE_OCCLUDE_GRADIENT_MASK_MIN,
        pokeOccludeGradientMaskMax: POKE_OCCLUDE_GRADIENT_MASK_MAX,
        pokeGradientMaskLerpSpeed: POKE_GRADIENT_MASK_LERP_SPEED,
        pokeGradientMaskCutoff: POKE_GRADIENT_MASK_CUTOFF,
        pokeExponent: config.style.pokeExponent,
        pokeExponentTriggered: config.style.pokeExponentTriggered,
        triggeredLerpDurationSeconds: config.style.triggeredLerpDurationSeconds,
        pinchValidLerpDurationSeconds: config.style.pinchValidLerpDurationSeconds,
        pokeValidLerpDurationSeconds: config.style.pokeValidLerpDurationSeconds
      },
      debugModeEnabled: config.debugModeEnabled,
      proximitySensor: config.proximitySensor,
      indexTipSceneObject: this.handVisuals.indexTip,
      overrideMap: this.handVisuals.overrideMap,
      handVisuals: this.handVisuals
    }
    this.viewModel = new GlowEffectViewModel(viewModelConfig)
    this.refreshPassCache()

    // Initialize cached properties
    this.lastPinchProps = {
      brightness: -1,
      color: new vec4(0, 0, 0, 0),
      glowBrightness: -1,
      glowColor: new vec4(0, 0, 0, 0),
      exponent: -1
    }
    this.lastPokeProps = {
      brightness: -1,
      color: new vec4(0, 0, 0, 0),
      glowBrightness: -1,
      glowColor: new vec4(0, 0, 0, 0),
      depthFactor: -1,
      highlightGradientMaskPosition: -1,
      occludeGradientMaskPosition: -1,
      exponent: -1
    }

    this.updateEvent = this.updateDispatcher.createUpdateEvent("GlowEffectViewUpdate", () => this.onUpdate())

    this.hand.onHandFound.add(
      (this.onHandFoundCallback = () => {
        this.updateEvent.enabled = true
      })
    )
    this.hand.onHandLost.add(
      (this.onHandLostCallback = () => {
        this.forceHideGlows()
        this.updateEvent.enabled = false
      })
    )

    const initialTracked = this.hand.isTracked()
    this.updateEvent.enabled = initialTracked
    if (!initialTracked) {
      this.forceHideGlows()
    } else {
      this.syncGlowEnabledStates(true)
    }
  }

  /**
   * Clean up GlowEffectView
   */
  destroy(): void {
    this.hand.onHandFound.remove(this.onHandFoundCallback)
    this.hand.onHandLost.remove(this.onHandLostCallback)
    this.viewModel.destroy()
    this._indexGlowSceneObject.destroy()
    this._thumbGlowSceneObject.destroy()
    this.updateDispatcher.removeEvent(this.updateEvent)
  }

  private forceHideGlows(): void {
    if (this.lastIndexGlowEnabled) {
      this._indexGlowSceneObject.enabled = false
      this.lastIndexGlowEnabled = false
    }
    if (this.lastThumbGlowEnabled) {
      this._thumbGlowSceneObject.enabled = false
      this.lastThumbGlowEnabled = false
    }

    // Clear index glow material
    for (let i = 0; i < this.cachedIndexGlowPasses.length; i++) {
      const pass = this.cachedIndexGlowPasses[i]
      pass["pinchGlowBrightness"] = 0
      pass["pokeGlowBrightness"] = 0
    }

    // Clear thumb glow material
    for (let i = 0; i < this.cachedThumbGlowPasses.length; i++) {
      const pass = this.cachedThumbGlowPasses[i]
      pass["pinchGlowBrightness"] = 0
      pass["pokeGlowBrightness"] = 0
    }

    // Clear hand mesh materials
    if (this.cachedHandFullPass1) {
      this.cachedHandFullPass1["pinchBrightness"] = 0
      this.cachedHandFullPass1["pokeBrightness"] = 0
    }

    if (this.cachedHandIndexThumbPass1) {
      this.cachedHandIndexThumbPass1["pinchBrightness"] = 0
      this.cachedHandIndexThumbPass1["pokeBrightness"] = 0
    }

    // Reset cache
    this.lastPinchProps.brightness = 0
    this.lastPinchProps.color.fill(0)
    this.lastPinchProps.glowBrightness = 0
    this.lastPinchProps.glowColor.fill(0)
    this.lastPinchProps.exponent = 0

    this.lastPokeProps.brightness = 0
    this.lastPokeProps.color.fill(0)
    this.lastPokeProps.glowBrightness = 0
    this.lastPokeProps.glowColor.fill(0)
    this.lastPokeProps.depthFactor = 0
    this.lastPokeProps.highlightGradientMaskPosition = 0
    this.lastPokeProps.occludeGradientMaskPosition = 0
    this.lastPokeProps.exponent = 0

    this.lastPokePinchBlend = 0
    this.lastMeshVisibilityDesired = false
  }

  /**
   * Sets the visual selection mode via the ViewModel.
   */
  setVisualSelection(handVisualSelection: HandVisualSelection): void {
    this.viewModel.setVisualSelection(handVisualSelection)
    this.refreshPassCache()
    this.viewModel.refreshShouldAlwaysShowMesh()
  }

  /** Called by HandVisual when meshType changes so the ViewModel can re-evaluate shouldAlwaysShowMesh. */
  notifyMeshTypeChanged(): void {
    this.viewModel.refreshShouldAlwaysShowMesh()
  }

  /**
   * Sets the palm tapping state for the glow effect.
   * @param isPalmTapping - Whether the palm is currently tapping
   */
  setPalmTapping(isPalmTapping: boolean): void {
    this.viewModel.isPalmTapping = isPalmTapping
  }

  private setupGlowSceneObject(
    parentSceneObject: SceneObject | undefined,
    sceneObjectName: string,
    offset: vec3 | undefined = undefined
  ): SceneObject {
    validate(parentSceneObject)

    const glowSceneObject = global.scene.createSceneObject(sceneObjectName)
    glowSceneObject.setParent(parentSceneObject)
    const glowSceneObjectTransform = glowSceneObject.getTransform()
    glowSceneObjectTransform.setWorldScale(
      new vec3(
        this.config.style.tipGlowWorldScale,
        this.config.style.tipGlowWorldScale,
        this.config.style.tipGlowWorldScale
      )
    )
    if (offset) {
      glowSceneObjectTransform.setLocalPosition(offset)
    }

    const quadComponent = glowSceneObject.createComponent("Component.RenderMeshVisual")
    quadComponent.mesh = this.config.unitPlaneMesh
    quadComponent.setRenderOrder(this.config.style.tipGlowRenderOrder)

    const tipGlowMaterial = this.config.style.tipGlowMaterial.clone()
    tipGlowMaterial.mainPass.depthTest = false
    tipGlowMaterial.mainPass.depthWrite = false
    quadComponent.mainMaterial = tipGlowMaterial

    glowSceneObject.enabled = false
    return glowSceneObject
  }

  /** Re-caches all material Pass references. Called on construction and when visual selection changes. */
  refreshPassCache(): void {
    const fullMat = this.handVisuals.handMeshFull.mainMaterial
    if (fullMat.getPassCount() > 0) {
      this.cachedHandFullPass0 = fullMat.getPass(0)
      this.cachedHandFullPass1 = fullMat.getPassCount() > 1 ? fullMat.getPass(1) : null
    } else {
      this.cachedHandFullPass0 = null
      this.cachedHandFullPass1 = null
    }

    const itMat = this.handVisuals.handMeshIndexThumb.mainMaterial
    if (itMat.getPassCount() > 0) {
      this.cachedHandIndexThumbPass0 = itMat.getPass(0)
      this.cachedHandIndexThumbPass1 = itMat.getPassCount() > 1 ? itMat.getPass(1) : null
    } else {
      this.cachedHandIndexThumbPass0 = null
      this.cachedHandIndexThumbPass1 = null
    }

    this.cachedIndexGlowPasses.length = 0
    for (let i = 0; i < this._indexGlowMaterial.getPassCount(); i++) {
      this.cachedIndexGlowPasses.push(this._indexGlowMaterial.getPass(i))
    }

    this.cachedThumbGlowPasses.length = 0
    for (let i = 0; i < this._thumbGlowMaterial.getPassCount(); i++) {
      this.cachedThumbGlowPasses.push(this._thumbGlowMaterial.getPass(i))
    }
  }

  private onUpdate(): void {
    const isTracked = this.hand.isTracked()
    if (!isTracked) {
      this.forceHideGlows()
      return
    }

    this.applyViewModelProperties()

    this.syncGlowEnabledStates(isTracked)
    this.syncHandMeshVisibility()

    if (this.isIndexGlowVisible || this.isThumbGlowVisible) {
      const cameraRotation = this.cameraTransform.getWorldRotation()

      if (this.isIndexGlowVisible) {
        this._indexGlowTransform.setWorldRotation(cameraRotation)
      }
      if (this.isThumbGlowVisible) {
        this._thumbGlowTransform.setWorldRotation(cameraRotation)
      }
    }

    if (this.debugModeEnabled) {
      this.drawDebugLines()
    }
  }

  private syncGlowEnabledStates(isTracked: boolean): void {
    const indexGlowShouldBeEnabled = this.isIndexGlowVisible && isTracked
    if (this.lastIndexGlowEnabled !== indexGlowShouldBeEnabled) {
      this._indexGlowSceneObject.enabled = indexGlowShouldBeEnabled
      this.lastIndexGlowEnabled = indexGlowShouldBeEnabled
    }

    const thumbGlowShouldBeEnabled = this.isThumbGlowVisible && isTracked
    if (this.lastThumbGlowEnabled !== thumbGlowShouldBeEnabled) {
      this._thumbGlowSceneObject.enabled = thumbGlowShouldBeEnabled
      this.lastThumbGlowEnabled = thumbGlowShouldBeEnabled
    }
  }

  private syncHandMeshVisibility(): void {
    if (this.lastMeshVisibilityDesired && !this.isMeshVisibilityDesired) {
      this.clearHandMeshBrightness()
    }
    this.lastMeshVisibilityDesired = this.isMeshVisibilityDesired
  }

  private clearHandMeshBrightness(): void {
    if (this.cachedHandFullPass1) {
      this.cachedHandFullPass1["pinchBrightness"] = 0
      this.cachedHandFullPass1["pokeBrightness"] = 0
    }

    if (this.cachedHandIndexThumbPass1) {
      this.cachedHandIndexThumbPass1["pinchBrightness"] = 0
      this.cachedHandIndexThumbPass1["pokeBrightness"] = 0
    }

    this.lastPinchProps.brightness = 0
    this.lastPokeProps.brightness = 0
  }

  private drawDebugLines(): void {
    for (const line of this.viewModel.debugLines) {
      global.debugRenderSystem.drawLine(line.start, line.end, line.color)
    }
  }

  private applyViewModelProperties(): void {
    const {pinchProps, pokeProps, pokePinchBlend} = this.viewModel

    this.applyBrightnessProps(pinchProps, pokeProps, pokePinchBlend)
    this.applyColorProps(pinchProps, pokeProps)

    if (this.isMeshVisibilityDesired) {
      this.lastPinchProps.brightness = pinchProps.brightness
      this.lastPinchProps.color.copyFrom(pinchProps.color)
      this.lastPinchProps.exponent = pinchProps.exponent

      this.lastPokeProps.brightness = pokeProps.brightness
      this.lastPokeProps.color.copyFrom(pokeProps.color)
      this.lastPokeProps.depthFactor = pokeProps.depthFactor
      this.lastPokeProps.highlightGradientMaskPosition = pokeProps.highlightGradientMaskPosition
      this.lastPokeProps.occludeGradientMaskPosition = pokeProps.occludeGradientMaskPosition
      this.lastPokeProps.exponent = pokeProps.exponent
    }

    if (this.isIndexGlowVisible || this.isThumbGlowVisible) {
      this.lastPinchProps.glowBrightness = pinchProps.glowBrightness
      this.lastPinchProps.glowColor.copyFrom(pinchProps.glowColor)
      this.lastPokeProps.glowBrightness = pokeProps.glowBrightness
      this.lastPokeProps.glowColor.copyFrom(pokeProps.glowColor)
      this.lastPokePinchBlend = pokePinchBlend
    }
  }

  /** Writes a material property only when changed, avoiding unnecessary bridge crossings. */
  private updateMaterialProperty<T>(pass: Pass, key: string, newValue: T, lastValue: T | undefined | null): void {
    if (newValue !== lastValue) {
      pass[key] = newValue
    }
  }

  private updateMaterialColorProperty(
    pass: Pass,
    key: string,
    newColor: vec4,
    lastColor: vec4 | undefined | null
  ): void {
    if (!lastColor || !newColor.equal(lastColor)) {
      pass[key] = newColor
    }
  }

  private applyBrightnessProps(pinchProps: PinchProperties, pokeProps: PokeProperties, pokePinchBlend: number): void {
    // Apply properties to the hand mesh materials
    if (this.isMeshVisibilityDesired) {
      const applyToHandPass = (pass0: Pass, pass1: Pass) => {
        this.updateMaterialProperty(
          pass0,
          "pokeOccludeGradientMaskPosition",
          pokeProps.occludeGradientMaskPosition,
          this.lastPokeProps.occludeGradientMaskPosition
        )

        this.updateMaterialProperty(pass1, "pinchBrightness", pinchProps.brightness, this.lastPinchProps.brightness)
        this.updateMaterialProperty(pass1, "pokeBrightness", pokeProps.brightness, this.lastPokeProps.brightness)
        this.updateMaterialProperty(pass1, "pokePinchBlend", pokePinchBlend, this.lastPokePinchBlend)
        this.updateMaterialProperty(pass1, "pinchExponent", pinchProps.exponent, this.lastPinchProps.exponent)
        this.updateMaterialProperty(
          pass1,
          "pokeHighlightGradientMaskPosition",
          pokeProps.highlightGradientMaskPosition,
          this.lastPokeProps.highlightGradientMaskPosition
        )
        this.updateMaterialProperty(pass1, "pokeExponent", pokeProps.exponent, this.lastPokeProps.exponent)
      }

      if (this.cachedHandFullPass0 && this.cachedHandFullPass1) {
        applyToHandPass(this.cachedHandFullPass0, this.cachedHandFullPass1)
      }

      if (this.cachedHandIndexThumbPass0 && this.cachedHandIndexThumbPass1) {
        applyToHandPass(this.cachedHandIndexThumbPass0, this.cachedHandIndexThumbPass1)
      }
    }

    // Apply properties to the glow materials
    if (this.isIndexGlowVisible && this.cachedIndexGlowPasses.length > 0) {
      const indexGlowPass = this.cachedIndexGlowPasses[0]
      this.updateMaterialProperty(
        indexGlowPass,
        "pinchGlowBrightness",
        pinchProps.glowBrightness,
        this.lastPinchProps.glowBrightness
      )
      this.updateMaterialProperty(
        indexGlowPass,
        "pokeGlowBrightness",
        pokeProps.glowBrightness,
        this.lastPokeProps.glowBrightness
      )
      this.updateMaterialProperty(indexGlowPass, "pokePinchBlend", pokePinchBlend, this.lastPokePinchBlend)
    }

    if (this.isThumbGlowVisible && this.cachedThumbGlowPasses.length > 0) {
      const thumbGlowPass = this.cachedThumbGlowPasses[0]
      this.updateMaterialProperty(
        thumbGlowPass,
        "pinchGlowBrightness",
        pinchProps.glowBrightness,
        this.lastPinchProps.glowBrightness
      )
      this.updateMaterialProperty(thumbGlowPass, "pokePinchBlend", pokePinchBlend, this.lastPokePinchBlend)
    }
  }

  private applyColorProps(pinchProps: PinchProperties, pokeProps: PokeProperties): void {
    // Apply to hand mesh materials
    if (this.isMeshVisibilityDesired) {
      const applyToHandPass = (pass: Pass) => {
        this.updateMaterialColorProperty(pass, "pinchColor", pinchProps.color, this.lastPinchProps.color)
        this.updateMaterialColorProperty(pass, "pokeColor", pokeProps.color, this.lastPokeProps.color)
      }

      if (this.cachedHandFullPass1) {
        applyToHandPass(this.cachedHandFullPass1)
      }

      if (this.cachedHandIndexThumbPass1) {
        applyToHandPass(this.cachedHandIndexThumbPass1)
      }
    }

    // Apply to glow materials
    if (this.isIndexGlowVisible) {
      for (let i = 0; i < this.cachedIndexGlowPasses.length; i++) {
        const pass = this.cachedIndexGlowPasses[i]
        this.updateMaterialColorProperty(pass, "pinchGlowColor", pinchProps.glowColor, this.lastPinchProps.glowColor)
        this.updateMaterialColorProperty(pass, "pokeGlowColor", pokeProps.glowColor, this.lastPokeProps.glowColor)
      }
    }

    if (this.isThumbGlowVisible) {
      for (let i = 0; i < this.cachedThumbGlowPasses.length; i++) {
        const pass = this.cachedThumbGlowPasses[i]
        this.updateMaterialColorProperty(pass, "pinchGlowColor", pinchProps.glowColor, this.lastPinchProps.glowColor)
        this.updateMaterialColorProperty(pass, "pokeGlowColor", pokeProps.glowColor, this.lastPokeProps.glowColor)
      }
    }
  }
}
