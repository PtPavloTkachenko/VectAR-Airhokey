import Event, {PublicApi} from "../../Utils/Event"
import {FrameCache} from "../../Utils/FrameCache"
import {CancelToken, setTimeout} from "../../Utils/FunctionTimingUtils"
import NativeLogger from "../../Utils/NativeLogger"
import {PinchDetectionSelection, PinchDetector} from "./GestureProvider/PinchDetection/PinchDetector"
import {JointNode, JOINT_HIERARCHY} from "./Joints"

import {ProximitySensor} from "../../Components/Helpers/ProximitySensor"
import {DegToRad} from "../../Utils/mathUtils"
import {validate} from "../../Utils/validate"
import WorldCameraFinderProvider from "../CameraProvider/WorldCameraFinderProvider"
import {TargetingData} from "../TargetProvider/TargetingData"
import {BaseHand} from "./BaseHand"
import DefaultHandTrackingAssetProvider from "./DefaultHandTrackingAssetProvider"
import GestureModuleProvider from "./GestureProvider/GestureModuleProvider"
import PalmTapDetector from "./GestureProvider/PalmTapDetection/PalmTapDetector"
import {PalmTapDetectionEvent} from "./GestureProvider/PalmTapDetectionEvent"
import {HandType} from "./HandType"
import {HandVisuals} from "./HandVisuals"
import {Keypoint} from "./Keypoint"
import {LandmarkName} from "./LandmarkNames"

export type BaseHandConfig = {
  handType: HandType
  isDominantHand: boolean
}

export enum TrackingEvent {
  OnTrackingStarted = "OnTrackingStarted",
  OnTrackingLost = "OnTrackingLost"
}

const TAG = "TrackedHand"
const HAND_FACING_THRESHOLD = 40.0
const FLAT_JOINT_ANGLE_THRESHOLD = Math.cos(150 * DegToRad)
const BENT_JOINT_ANGLE_THRESHOLD = Math.cos(80 * DegToRad)
const POINTING_PITCH_THRESHOLD = -60.0

// GestureModule can take up to 350ms to determine if a pinch has been sustained.
const OBJECT_TRACKING_3D_TIMEOUT_MS = 400

export type OrientationVectors = {
  forward: vec3
  right: vec3
  up: vec3
  cameraForward: vec3
}

export enum PalmState {
  None,
  Flat,
  Closed
}

/**
 * Manages a tracked hand, instantiates fingers and wrists.
 * Also manages the {@link ObjectTracking3D} and creates
 * the needed scene object hierarchy to achieve hand mesh visualization as well as landmarks tracking
 */
export default class TrackedHand implements BaseHand {
  // Dependency injection
  private handTrackingAssetProvider: DefaultHandTrackingAssetProvider = DefaultHandTrackingAssetProvider.getInstance()
  protected sceneObjectManager: ScriptScene = global.scene
  private worldCamera: WorldCameraFinderProvider = WorldCameraFinderProvider.getInstance()
  private gestureModuleProvider: GestureModuleProvider = GestureModuleProvider.getInstance()

  // Native Logging
  private log = new NativeLogger(TAG)

  // SceneObject
  private _enabled = true
  private isDestroyed = false
  private ownerSceneObject: SceneObject

  private cameraObject: SceneObject

  // Events
  private onEnabledChangedEvent = new Event<boolean>()
  readonly onEnabledChanged = this.onEnabledChangedEvent.publicApi()

  private onHandFoundEvent = new Event()
  readonly onHandFound = this.onHandFoundEvent.publicApi()

  private onHandLostEvent = new Event()
  readonly onHandLost = this.onHandLostEvent.publicApi()

  readonly onPinchDown: PublicApi<void>
  readonly onPinchUp: PublicApi<void>
  readonly onPinchCancel: PublicApi<void>

  // Tracking
  private objectTracking3DComponent: ObjectTracking3D

  // Timeouts for temporary pinch sustain
  private objectTracking3DCancelToken: CancelToken | undefined
  private objectTracking3DRecentlyFound: boolean = false

  // Keypoints — Map kept for external getKeypoint() callers; direct fields eliminate Map.get on hot paths.
  private keypoints = new Map<string, Keypoint>()
  readonly wrist!: Keypoint
  readonly thumbToWrist!: Keypoint
  readonly thumbBaseJoint!: Keypoint
  readonly thumbKnuckle!: Keypoint
  readonly thumbMidJoint!: Keypoint
  readonly thumbTip!: Keypoint
  readonly indexToWrist!: Keypoint
  readonly indexKnuckle!: Keypoint
  readonly indexMidJoint!: Keypoint
  readonly indexUpperJoint!: Keypoint
  readonly indexTip!: Keypoint
  readonly middleToWrist!: Keypoint
  readonly middleKnuckle!: Keypoint
  readonly middleMidJoint!: Keypoint
  readonly middleUpperJoint!: Keypoint
  readonly middleTip!: Keypoint
  readonly ringToWrist!: Keypoint
  readonly ringKnuckle!: Keypoint
  readonly ringMidJoint!: Keypoint
  readonly ringUpperJoint!: Keypoint
  readonly ringTip!: Keypoint
  readonly pinkyToWrist!: Keypoint
  readonly pinkyKnuckle!: Keypoint
  readonly pinkyMidJoint!: Keypoint
  readonly pinkyUpperJoint!: Keypoint
  readonly pinkyTip!: Keypoint

  private handVisuals?: HandVisuals
  private allPoints: Keypoint[] = []
  private thumbFingerPoints: Keypoint[] = []
  private indexFingerPoints: Keypoint[] = []
  private middleFingerPoints: Keypoint[] = []
  private ringFingerPoints: Keypoint[] = []
  private pinkyFingerPoints: Keypoint[] = []

  // Pinch
  private pinchDetector: PinchDetector

  // Palm Tap
  private palmTapDetector?: PalmTapDetector

  private _isDominantHand = this.config.isDominantHand

  private _targetingData: TargetingData = {
    targetingDirectionInWorld: vec3.zero(),
    targetingLocusInWorld: vec3.zero(),
    intendsToTarget: false
  }
  private _hasTargetingData: boolean = false

  private _isPhoneInHand: boolean = false

  private onPhoneInHandBeginEvent = new Event()
  readonly onPhoneInHandBegin = this.onPhoneInHandBeginEvent.publicApi()

  private onPhoneInHandEndEvent = new Event()
  readonly onPhoneInHandEnd = this.onPhoneInHandEndEvent.publicApi()

  private proximitySensors: Map<LandmarkName, ProximitySensor> = new Map<LandmarkName, ProximitySensor>()

  // Frame cache for expensive computations
  private frameCache = FrameCache.getInstance()
  private cachedHandOrientation!: () => OrientationVectors
  private cachedIsInTargetingPose!: () => boolean
  private cachedIsPinching!: () => boolean
  private cachedIsTracked!: () => boolean
  private cachedGetPinchStrength!: () => number | null

  // Dedicated scratch vectors for computeHandOrientation — these are returned
  // in the FrameCache'd OrientationVectors and must NOT be shared with other methods.
  private readonly _orientRight = new vec3(0, 0, 0)
  private readonly _orientForward = new vec3(0, 0, 0)
  private readonly _orientUp = new vec3(0, 0, 0)
  private readonly _orientCameraForward = new vec3(0, 0, 0)

  // General-purpose scratch vectors for non-cached methods.
  private readonly _scratchA = new vec3(0, 0, 0)
  private readonly _scratchB = new vec3(0, 0, 0)
  private readonly _scratchC = new vec3(0, 0, 0)
  private static readonly UP = new vec3(0, 1, 0)

  constructor(private config: BaseHandConfig) {
    this.ownerSceneObject = this.sceneObjectManager.createSceneObject(
      this.handType === "left" ? "LeftHandModelOwner" : "RightHandModelOwner"
    )

    this.cameraObject = this.worldCamera.getComponent().getSceneObject()
    this.ownerSceneObject.setParent(this.cameraObject)

    this.objectTracking3DComponent = this.ownerSceneObject.createComponent("Component.ObjectTracking3D")

    if (this.objectTracking3DComponent === undefined) {
      throw new Error("Failed to create Component.ObjectTracking3D")
    }

    const asset = this.handTrackingAssetProvider.get(this.config.handType)
    if (!isNull(asset)) {
      this.objectTracking3DComponent.trackingAsset = asset
    }

    this.objectTracking3DComponent.objectIndex = 0
    this.objectTracking3DComponent.trackingMode = ObjectTracking3D.TrackingMode.Attachment

    const logObjectTrackingEvent = (eventName: TrackingEvent) => {
      this.log.d(`Received event from ObjectTracking3D: handType: ${this.config.handType}, eventType: ${eventName}`)
    }
    this.objectTracking3DComponent.onTrackingStarted = () => {
      this.objectTracking3DRecentlyFound = true

      logObjectTrackingEvent(TrackingEvent.OnTrackingStarted)
      this.log.v("HandEvent : " + "Hand Found Event")
      this.onHandFoundEvent.invoke()

      this.objectTracking3DCancelToken = setTimeout(() => {
        this.objectTracking3DRecentlyFound = false
      }, OBJECT_TRACKING_3D_TIMEOUT_MS)
    }
    this.objectTracking3DComponent.onTrackingLost = () => {
      this.objectTracking3DRecentlyFound = false

      if (this.objectTracking3DCancelToken !== undefined) {
        this.objectTracking3DCancelToken.cancelled = true
      }

      this.objectTracking3DCancelToken = undefined
      logObjectTrackingEvent(TrackingEvent.OnTrackingLost)
      this.onHandLostEvent.invoke()
      this.log.v("HandEvent : " + "Hand Lost Event")
    }

    this.attachJoints(JOINT_HIERARCHY.children)

    this.wrist = this.keypoints.get(LandmarkName.WRIST as string)!
    this.thumbToWrist = this.keypoints.get(LandmarkName.WRIST_TO_THUMB as string)!
    this.thumbBaseJoint = this.keypoints.get(LandmarkName.THUMB_0 as string)!
    this.thumbKnuckle = this.keypoints.get(LandmarkName.THUMB_1 as string)!
    this.thumbMidJoint = this.keypoints.get(LandmarkName.THUMB_2 as string)!
    this.thumbTip = this.keypoints.get(LandmarkName.THUMB_3 as string)!
    this.indexToWrist = this.keypoints.get(LandmarkName.WRIST_TO_INDEX as string)!
    this.indexKnuckle = this.keypoints.get(LandmarkName.INDEX_0 as string)!
    this.indexMidJoint = this.keypoints.get(LandmarkName.INDEX_1 as string)!
    this.indexUpperJoint = this.keypoints.get(LandmarkName.INDEX_2 as string)!
    this.indexTip = this.keypoints.get(LandmarkName.INDEX_3 as string)!
    this.middleToWrist = this.keypoints.get(LandmarkName.WRIST_TO_MIDDLE as string)!
    this.middleKnuckle = this.keypoints.get(LandmarkName.MIDDLE_0 as string)!
    this.middleMidJoint = this.keypoints.get(LandmarkName.MIDDLE_1 as string)!
    this.middleUpperJoint = this.keypoints.get(LandmarkName.MIDDLE_2 as string)!
    this.middleTip = this.keypoints.get(LandmarkName.MIDDLE_3 as string)!
    this.ringToWrist = this.keypoints.get(LandmarkName.WRIST_TO_RING as string)!
    this.ringKnuckle = this.keypoints.get(LandmarkName.RING_0 as string)!
    this.ringMidJoint = this.keypoints.get(LandmarkName.RING_1 as string)!
    this.ringUpperJoint = this.keypoints.get(LandmarkName.RING_2 as string)!
    this.ringTip = this.keypoints.get(LandmarkName.RING_3 as string)!
    this.pinkyToWrist = this.keypoints.get(LandmarkName.WRIST_TO_PINKY as string)!
    this.pinkyKnuckle = this.keypoints.get(LandmarkName.PINKY_0 as string)!
    this.pinkyMidJoint = this.keypoints.get(LandmarkName.PINKY_1 as string)!
    this.pinkyUpperJoint = this.keypoints.get(LandmarkName.PINKY_2 as string)!
    this.pinkyTip = this.keypoints.get(LandmarkName.PINKY_3 as string)!

    this.setKeypointCollections()

    // Initialize the cached hand orientation function
    this.cachedHandOrientation = this.frameCache.wrapMethod(
      `TrackedHand_${this.config.handType}_getHandOrientation`,
      this,
      this.computeHandOrientation
    )

    // Initialize the cached targeting pose function
    this.cachedIsInTargetingPose = this.frameCache.wrapMethod(
      `TrackedHand_${this.config.handType}_isInTargetingPose`,
      this,
      this.computeIsInTargetingPose
    )

    // Cache isTracked() — bridges to native objectTracking3DComponent.isTracking()
    // and is called 20+ times per frame across HandInteractor, HandVisual, GlowEffect, etc.
    this.cachedIsTracked = this.frameCache.wrapMethod(
      `TrackedHand_${this.config.handType}_isTracked`,
      this,
      this.computeIsTracked
    )

    this.pinchDetector = new PinchDetector({
      handType: this.config.handType,
      onHandLost: this.onHandLost,
      isTracked: () => {
        return this.isTracked()
      },
      pinchDetectionSelection: PinchDetectionSelection.LensCoreML
    })
    this.onPinchDown = this.pinchDetector.onPinchDown
    this.onPinchUp = this.pinchDetector.onPinchUp
    this.onPinchCancel = this.pinchDetector.onPinchCancel

    this.cachedIsPinching = this.frameCache.wrapMethod(
      `TrackedHand_${this.config.handType}_isPinching`,
      this.pinchDetector,
      this.pinchDetector.isPinching
    )

    this.cachedGetPinchStrength = this.frameCache.wrap(`TrackedHand_${this.config.handType}_getPinchStrength`, () =>
      this.computePinchStrength()
    )

    const gestureModule: any = this.gestureModuleProvider.getModule()

    if (gestureModule !== undefined) {
      const gestureHandType = this.handType === "right" ? GestureModule.HandType.Right : GestureModule.HandType.Left
      try {
        gestureModule.getTargetingDataEvent(gestureHandType).add((args: TargetingDataArgs) => {
          this.rayToWorld(args.rayOriginInWorld, args.rayDirectionInWorld, this._targetingData)
          this._targetingData.intendsToTarget = args.handIntendsToTarget
          this._hasTargetingData = true
        })
      } catch (error) {
        this.log.e(`Error subscribing to targeting ray event: ${error}`)
      }

      try {
        gestureModule.getIsPhoneInHandBeginEvent(gestureHandType).add(() => {
          this._isPhoneInHand = true
          this.onPhoneInHandBeginEvent.invoke()
          this.log.i("HandEvent : " + "Phone In Hand Event" + " isPhoneInHand: " + this._isPhoneInHand)
        })
        gestureModule.getIsPhoneInHandEndEvent(gestureHandType).add(() => {
          this._isPhoneInHand = false
          this.onPhoneInHandEndEvent.invoke()
          this.log.i("HandEvent : " + "Phone In Hand Event" + " isPhoneInHand: " + this._isPhoneInHand)
        })
      } catch (error) {
        this.log.e(`Error subscribing to gesture phone in hand event: ${error}`)
      }

      try {
        this.palmTapDetector = new PalmTapDetector(gestureHandType)
      } catch (error) {
        this.log.w(`PalmTapDetector is not supported: ${error}`)
      }
    }
  }

  get enabled(): boolean {
    return this._enabled
  }

  setEnabled(isEnabled: boolean) {
    if (this._enabled === isEnabled) {
      return
    }

    this._enabled = isEnabled
    this.objectTracking3DComponent.enabled = this.enabled
    this.onEnabledChangedEvent.invoke(this._enabled)
    this.log.v("HandEvent : " + "Hand Enabled Changed Event" + " to " + this._enabled)
  }

  isFacingCamera(): boolean {
    if (!this.isTracked()) {
      return false
    }

    const facingCameraAngle = this.getFacingCameraAngle()
    return Boolean(facingCameraAngle !== null && facingCameraAngle < HAND_FACING_THRESHOLD)
  }

  /**
   * Check if hand is in targeting pose, cached per frame for performance.
   * This method is automatically cached by FrameCache utility.
   */
  isInTargetingPose(): boolean {
    return this.cachedIsInTargetingPose()
  }

  /**
   * Expensive computation for targeting pose detection.
   * This is wrapped by FrameCache and called only once per frame.
   */
  private computeIsInTargetingPose(): boolean {
    if (!this.isTracked()) {
      return false
    }

    const pitchAngle = this.getPalmPitchAngle()
    const isFacingCamera = this.isFacingCamera()

    const isPitchAngleValid = pitchAngle !== null && pitchAngle > POINTING_PITCH_THRESHOLD
    return !isFacingCamera && isPitchAngleValid
  }

  getPinchDirection(): quat | null {
    if (!this.isTracked()) {
      return null
    }

    const thumbTipPos = this.thumbTip.position
    const thumbKnucklePos = this.thumbKnuckle.position
    const indexMidPos = this.indexMidJoint.position

    const forward = this._scratchA
    const right = this._scratchB
    const up = this._scratchC

    forward.copyFrom(thumbTipPos)
    forward.subInPlace(thumbKnucklePos)
    forward.normalizeInPlace()

    right.copyFrom(indexMidPos)
    right.subInPlace(thumbKnucklePos)
    right.normalizeInPlace()

    if (this.handType === "right") {
      up.copyFrom(right)
      up.crossInPlace(forward)
    } else {
      up.copyFrom(forward)
      up.crossInPlace(right)
    }

    return quat.lookAt(forward, up)
  }

  /**
   * Get the hand orientation vectors, cached per frame for performance.
   * This method is automatically cached by FrameCache utility.
   */
  private getHandOrientation(): OrientationVectors {
    return this.cachedHandOrientation()
  }

  /**
   * Expensive computation for hand orientation vectors.
   * This is wrapped by FrameCache and called only once per frame.
   */
  private computeHandOrientation(): OrientationVectors {
    const indexMidPos = this.indexMidJoint.position
    const middleMidPos = this.middleMidJoint.position
    const wristPos = this.wrist.position

    // right = (indexMid - middleMid).normalize()
    this._orientRight.copyFrom(indexMidPos)
    this._orientRight.subInPlace(middleMidPos)
    this._orientRight.normalizeInPlace()

    // forward = (middleMid - wrist).normalize()
    this._orientForward.copyFrom(middleMidPos)
    this._orientForward.subInPlace(wristPos)
    this._orientForward.normalizeInPlace()

    // up = right x forward
    this._orientUp.copyFrom(this._orientRight)
    this._orientUp.crossInPlace(this._orientForward)

    // cameraForward = (cameraPos - wrist).normalize()
    this._orientCameraForward.copyFrom(this.worldCamera.getWorldPosition())
    this._orientCameraForward.subInPlace(wristPos)
    this._orientCameraForward.normalizeInPlace()

    return {
      forward: this._orientForward,
      right: this._orientRight,
      up: this._orientUp,
      cameraForward: this._orientCameraForward
    }
  }

  getFacingCameraAngle(): number | null {
    if (!this.isTracked()) {
      return null
    }

    /**
     * Apply the camera to wrist direction against the derived up vector to get facing angle
     */
    const handOrientationVectors = this.getHandOrientation()
    const dotHandCamera = handOrientationVectors.up.dot(handOrientationVectors.cameraForward)

    const angle = MathUtils.RadToDeg * Math.acos(this.config.handType === "right" ? dotHandCamera : -dotHandCamera)

    return angle
  }

  get palmState(): PalmState {
    const middleKnuckleBendDotProduct = this.getMiddleKnuckleBendDotProduct()
    if (middleKnuckleBendDotProduct === null) {
      return PalmState.None
    }

    if (middleKnuckleBendDotProduct < FLAT_JOINT_ANGLE_THRESHOLD) {
      return PalmState.Flat
    } else if (middleKnuckleBendDotProduct > BENT_JOINT_ANGLE_THRESHOLD) {
      return PalmState.Closed
    }
    return PalmState.None
  }

  private getMiddleKnuckleBendDotProduct(): number | null {
    const middleUpperPos = this.middleUpperJoint?.position ?? null
    const middleMidPos = this.middleMidJoint?.position ?? null
    const middleKnucklePos = this.middleKnuckle?.position ?? null

    if (middleUpperPos === null || middleMidPos === null || middleKnucklePos === null) {
      return null
    }

    const midToUpperDirection = this._scratchA
    const midToKnuckleDirection = this._scratchB

    midToUpperDirection.copyFrom(middleUpperPos)
    midToUpperDirection.subInPlace(middleMidPos)
    midToUpperDirection.normalizeInPlace()

    midToKnuckleDirection.copyFrom(middleKnucklePos)
    midToKnuckleDirection.subInPlace(middleMidPos)
    midToKnuckleDirection.normalizeInPlace()

    return midToUpperDirection.dot(midToKnuckleDirection)
  }

  getPalmPitchAngle(): number | null {
    if (!this.isTracked()) {
      return null
    }

    /**
     * Compare the hand's forward direction to world up
     */
    const handOrientationVectors = this.getHandOrientation()
    const dotHandUp = handOrientationVectors.forward.dot(TrackedHand.UP)
    const angle = 90 - MathUtils.RadToDeg * Math.acos(dotHandUp)

    return angle
  }

  getPalmCenter(): vec3 | null {
    if (!this.isTracked()) {
      return null
    }

    const result = vec3.zero()
    result.copyFrom(this.indexKnuckle.position)
    result.addInPlace(this.pinkyKnuckle.position)
    result.addInPlace(this.middleToWrist.position)
    result.uniformScaleInPlace(1.0 / 3.0)
    return result
  }

  get thumbFinger(): Keypoint[] {
    return this.thumbFingerPoints
  }

  get indexFinger(): Keypoint[] {
    return this.indexFingerPoints
  }

  get middleFinger(): Keypoint[] {
    return this.middleFingerPoints
  }

  get ringFinger(): Keypoint[] {
    return this.ringFingerPoints
  }

  get pinkyFinger(): Keypoint[] {
    return this.pinkyFingerPoints
  }

  get points(): Keypoint[] {
    return this.allPoints
  }

  get handType(): HandType {
    return this.config.handType
  }

  get isDominantHand(): boolean {
    return this._isDominantHand
  }

  get objectTracking3D(): ObjectTracking3D {
    return this.objectTracking3DComponent
  }

  get targetingData(): TargetingData | null {
    return this._hasTargetingData ? this._targetingData : null
  }

  get isPhoneInHand(): boolean {
    return this._isPhoneInHand
  }

  isTracked(): boolean {
    return this.cachedIsTracked()
  }

  private computeIsTracked(): boolean {
    return this.objectTracking3DComponent.isTracking()
  }

  isRecentlyFound(): boolean {
    return this.objectTracking3DRecentlyFound
  }

  getSceneObject(): SceneObject {
    return this.ownerSceneObject
  }

  setIsDominantHand(isDominantHand: boolean): void {
    this._isDominantHand = isDominantHand
  }

  isPinching(): boolean {
    return this.cachedIsPinching()
  }

  isTapping(): PalmTapDetectionEvent {
    if (this.palmTapDetector === undefined) {
      return {
        state: "unsupported"
      }
    } else {
      return {
        state: "available",
        data: {
          isTapping: this.palmTapDetector.isTapping
        }
      }
    }
  }

  /**
   * Set if the hand's pinch detector should use filtered events or not.
   */
  set useFilteredPinch(useFilteredPinch: boolean) {
    if (useFilteredPinch === this.pinchDetector.useFilteredPinch) {
      return
    }
    this.pinchDetector.useFilteredPinch = useFilteredPinch
  }

  /**
   * Returns if the hand's pinch detector should use filtered events or not.
   */
  get useFilteredPinch(): boolean {
    return this.pinchDetector.useFilteredPinch
  }

  getPinchStrength(): number | null {
    return this.cachedGetPinchStrength()
  }

  private computePinchStrength(): number | null {
    if (!this.isTracked()) {
      return null
    }
    return this.pinchDetector.getPinchStrength()
  }

  /**
   * Sets the tracking mode for the hand.
   * @param trackingMode - The new mode.
   */
  setTrackingMode(trackingMode: ObjectTracking3D.TrackingMode): void {
    this.objectTracking3DComponent.trackingMode = trackingMode
  }

  /**
   * Returns the proximity sensor for a given landmark. Creates a new one if it doesn't exist.
   * @param landmarkName - The landmark to get the proximity sensor for.
   * @returns The proximity sensor component.
   */
  public getProximitySensor(landmarkName: LandmarkName): ProximitySensor {
    // Ensure that the attachment points have been properly set up.
    if (this.handVisuals && !this.handVisuals.initialized) {
      this.handVisuals.initialize()
    }

    if (this.proximitySensors.has(landmarkName)) {
      return this.proximitySensors.get(landmarkName)!
    }

    const proximitySensor = this.getKeypoint(landmarkName)
      .getAttachmentPoint()
      .createComponent(ProximitySensor.getTypeName())
    this.proximitySensors.set(landmarkName, proximitySensor)

    return proximitySensor
  }

  public getHandVisuals(): HandVisuals | null {
    if (this.handVisuals && !this.handVisuals.initialized) {
      this.handVisuals.initialize()
    }

    return this.handVisuals ?? null
  }

  public attachHandVisuals(handVisuals: HandVisuals): void {
    this.handVisuals = handVisuals
  }

  public initHandVisuals(): void {
    if (!this.handVisuals) {
      throw new Error("initHandVisuals called before attachHandVisuals")
    }

    this.objectTracking3DComponent.trackingMode = ObjectTracking3D.TrackingMode.ProportionsAndPose

    validate(this.handVisuals.root)
    this.handVisuals.root.setParent(this.ownerSceneObject)

    // Wrist
    this.wrist.addAttachmentPoint(this.handVisuals.wrist)

    // Thumb
    this.thumbToWrist.addAttachmentPoint(this.handVisuals.thumbToWrist)
    this.thumbBaseJoint.addAttachmentPoint(this.handVisuals.thumbBaseJoint)
    this.thumbKnuckle.addAttachmentPoint(this.handVisuals.thumbKnuckle)
    this.thumbMidJoint.addAttachmentPoint(this.handVisuals.thumbMidJoint)
    this.thumbTip.addAttachmentPoint(this.handVisuals.thumbTip)

    // Index
    this.indexToWrist.addAttachmentPoint(this.handVisuals.indexToWrist)
    this.indexKnuckle.addAttachmentPoint(this.handVisuals.indexKnuckle)
    this.indexMidJoint.addAttachmentPoint(this.handVisuals.indexMidJoint)
    this.indexUpperJoint.addAttachmentPoint(this.handVisuals.indexUpperJoint)
    this.indexTip.addAttachmentPoint(this.handVisuals.indexTip)

    // Middle
    this.middleToWrist.addAttachmentPoint(this.handVisuals.middleToWrist)
    this.middleKnuckle.addAttachmentPoint(this.handVisuals.middleKnuckle)
    this.middleMidJoint.addAttachmentPoint(this.handVisuals.middleMidJoint)
    this.middleUpperJoint.addAttachmentPoint(this.handVisuals.middleUpperJoint)
    this.middleTip.addAttachmentPoint(this.handVisuals.middleTip)

    // Ring
    this.ringToWrist.addAttachmentPoint(this.handVisuals.ringToWrist)
    this.ringKnuckle.addAttachmentPoint(this.handVisuals.ringKnuckle)
    this.ringMidJoint.addAttachmentPoint(this.handVisuals.ringMidJoint)
    this.ringUpperJoint.addAttachmentPoint(this.handVisuals.ringUpperJoint)
    this.ringTip.addAttachmentPoint(this.handVisuals.ringTip)

    // Pinky
    this.pinkyToWrist.addAttachmentPoint(this.handVisuals.pinkyToWrist)
    this.pinkyKnuckle.addAttachmentPoint(this.handVisuals.pinkyKnuckle)
    this.pinkyMidJoint.addAttachmentPoint(this.handVisuals.pinkyMidJoint)
    this.pinkyUpperJoint.addAttachmentPoint(this.handVisuals.pinkyUpperJoint)
    this.pinkyTip.addAttachmentPoint(this.handVisuals.pinkyTip)
  }

  detachHandVisuals(handVisuals: HandVisuals): void {
    if (this.handVisuals !== handVisuals) {
      return
    }

    this.objectTracking3DComponent.trackingMode = ObjectTracking3D.TrackingMode.Attachment
    this.keypoints.forEach((keypoint) => keypoint.clearAttachmentPoint())
    this.handVisuals = undefined
  }

  /**
   * Destroys the hand and associated keypoints
   */
  destroy(): void {
    if (this.isDestroyed) {
      return
    }

    this.ownerSceneObject.destroy()
    this.isDestroyed = true
  }

  private attachJoints(children: JointNode[]) {
    for (const joint of children) {
      this.keypoints.set(joint.name, new Keypoint(joint.name, this.objectTracking3DComponent, this.config.handType))
      this.attachJoints(joint.children)
    }
  }

  private getKeypoint(landmarkName: LandmarkName): Keypoint {
    const keypoint = this.keypoints.get(landmarkName as string)
    if (!keypoint) {
      throw new Error(`Keypoint ${landmarkName} is not supported.`)
    }

    return keypoint
  }

  private setKeypointCollections() {
    this.thumbFingerPoints.push(
      this.thumbToWrist,
      this.thumbBaseJoint,
      this.thumbKnuckle,
      this.thumbMidJoint,
      this.thumbTip
    )
    this.indexFingerPoints.push(
      this.indexToWrist,
      this.indexKnuckle,
      this.indexMidJoint,
      this.indexUpperJoint,
      this.indexTip
    )
    this.middleFingerPoints.push(
      this.middleToWrist,
      this.middleKnuckle,
      this.middleMidJoint,
      this.middleUpperJoint,
      this.middleTip
    )
    this.ringFingerPoints.push(this.ringToWrist, this.ringKnuckle, this.ringMidJoint, this.ringUpperJoint, this.ringTip)
    this.pinkyFingerPoints.push(
      this.pinkyToWrist,
      this.pinkyKnuckle,
      this.pinkyMidJoint,
      this.pinkyUpperJoint,
      this.pinkyTip
    )
    this.allPoints.push(
      this.wrist,
      ...this.thumbFingerPoints,
      ...this.indexFingerPoints,
      ...this.middleFingerPoints,
      ...this.ringFingerPoints,
      ...this.pinkyFingerPoints
    )
  }

  private rayToWorld(rayOriginInCameraRootSpace: vec3, rayDirectionInCameraRootSpace: vec3, out: TargetingData): void {
    const cameraParent = this.cameraObject.getParent()

    if (!cameraParent) {
      out.targetingLocusInWorld.copyFrom(rayOriginInCameraRootSpace)
      out.targetingDirectionInWorld.copyFrom(rayDirectionInCameraRootSpace)
      return
    }
    const cameraRoot = cameraParent.getTransform().getWorldTransform()

    this._scratchA.copyFrom(rayOriginInCameraRootSpace)
    this._scratchA.addInPlace(rayDirectionInCameraRootSpace)

    const rayOriginInWorld = cameraRoot.multiplyPoint(rayOriginInCameraRootSpace)
    const rayEndInWorld = cameraRoot.multiplyPoint(this._scratchA)

    out.targetingLocusInWorld.copyFrom(rayOriginInWorld)
    out.targetingDirectionInWorld.copyFrom(rayEndInWorld)
    out.targetingDirectionInWorld.subInPlace(rayOriginInWorld)
  }
}
