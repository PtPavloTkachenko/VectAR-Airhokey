import {Interactor, InteractorInputType} from "../../Core/Interactor/Interactor"

import {InteractorCursor} from "../../Components/Interaction/InteractorCursor/InteractorCursor"
import {Singleton} from "../../Decorators/Singleton"
import {LensConfig} from "../../Utils/LensConfig"
import NativeLogger from "../../Utils/NativeLogger"
import {validate} from "../../Utils/validate"
import WorldCameraFinderProvider from "../CameraProvider/WorldCameraFinderProvider"

const TAG = "CursorControllerProvider"

// Hysteresis on the angle (from the camera) between two active cursors.
// Enter convergence at <= 15°, exit at > 20°.
const ANGLE_CLOSE_RAD = 15 * (Math.PI / 180)
const ANGLE_OPEN_RAD = 20 * (Math.PI / 180)
const COS_SQ_CLOSE = Math.cos(ANGLE_CLOSE_RAD) ** 2
const COS_SQ_OPEN = Math.cos(ANGLE_OPEN_RAD) ** 2

/**
 * This singleton class manages the registration and retrieval of InteractorCursor instances. It ensures that each Interactor has a unique cursor and provides methods to get cursors by their associated Interactor.
 * When retrieving cursors, make sure to only invoke getCursor APIs during or after the OnStartEvent of a script.
 */
@Singleton
export class CursorControllerProvider {
  public static getInstance: () => CursorControllerProvider

  private log = new NativeLogger(TAG)

  private cursors = new Map<Interactor, InteractorCursor>()

  private cameraProvider = WorldCameraFinderProvider.getInstance()
  private updateDispatcher = LensConfig.getInstance().updateDispatcher
  private _convergedCacheFrame: number = -1
  private _isConverged: boolean = false
  private readonly _scratchVecA = vec3.zero()
  private readonly _scratchVecB = vec3.zero()

  registerCursor(cursor: InteractorCursor, interactor: Interactor | null = null): void {
    if (cursor.interactor !== null) {
      interactor = cursor.interactor
    }
    validate(interactor, "InteractorCursor must have a set Interactor before registering to SIK.CursorController.")

    if (this.cursors.has(interactor)) {
      this.log.e(
        `Multiple cursors for a single Interactor have been registered.\nThe CursorController and InteractorCursor components cannot both be present in the scene hierarchy before runtime, use one or the other.`
      )

      return
    }

    this.cursors.set(interactor, cursor)
  }

  /**
   * @deprecated in favor of getCursorByInteractor
   * Gets the InteractorCursor for a specified interactor
   * @param interactor The interactor to get the cursor for
   * @returns the InteractorCursor for the requested interactor, or null if it doesn't exist
   */
  getCursor(interactor: Interactor): InteractorCursor | null {
    return this.getCursorByInteractor(interactor)
  }

  /**
   * Gets the InteractorCursor for a specified interactor
   * @param interactor The interactor to get the cursor for
   * @returns the InteractorCursor for the requested interactor, or null if it doesn't exist
   */
  getCursorByInteractor(interactor: Interactor): InteractorCursor | null {
    return this.cursors.get(interactor) ?? null
  }

  /**
   * Gets the InteractorCursor for a specified input type
   * @param inputType The InteractorInputType to get the cursor for
   * @returns the InteractorCursor for the requested InteractorInputType, or null if it doesn't exist
   */
  getCursorByInputType(inputType: InteractorInputType): InteractorCursor | null {
    let interactor: Interactor | undefined

    for (const mapInteractor of this.cursors.keys()) {
      if (mapInteractor.inputType === inputType) {
        interactor = mapInteractor
        break
      }
    }

    return interactor !== undefined ? this.getCursorByInteractor(interactor) : null
  }

  /**
   * Gets all InteractorCursors within the scene
   * @returns a list of InteractorCursors
   */
  getAllCursors(): InteractorCursor[] {
    return Array.from(this.cursors.values())
  }

  /**
   * Returns true when at least two active+targeting interactors have cursors that
   * are angularly close from the camera's viewpoint. Hysteresis: enters at ≤15°,
   * exits at >20°. Result is cached per frame.
   */
  hasConvergedActiveCursors(): boolean {
    const frame = this.updateDispatcher.frameCount
    if (frame === this._convergedCacheFrame) {
      return this._isConverged
    }
    this._convergedCacheFrame = frame

    const activeCursors: InteractorCursor[] = []
    for (const [interactor, cursor] of this.cursors) {
      if (interactor.isActive() && interactor.isTargeting() && cursor.cursorPosition !== null) {
        activeCursors.push(cursor)
      }
    }

    if (activeCursors.length < 2) {
      this._isConverged = false
      return false
    }

    const cameraPos = this.cameraProvider.getTransform().getWorldPosition()
    const cosSqThreshold = this._isConverged ? COS_SQ_OPEN : COS_SQ_CLOSE
    let converged = false

    for (let i = 0; i < activeCursors.length; i++) {
      for (let j = i + 1; j < activeCursors.length; j++) {
        const endA = activeCursors[i].cursorPosition!
        const endB = activeCursors[j].cursorPosition!

        this._scratchVecA.x = endA.x - cameraPos.x
        this._scratchVecA.y = endA.y - cameraPos.y
        this._scratchVecA.z = endA.z - cameraPos.z

        this._scratchVecB.x = endB.x - cameraPos.x
        this._scratchVecB.y = endB.y - cameraPos.y
        this._scratchVecB.z = endB.z - cameraPos.z

        const dotProd = this._scratchVecA.dot(this._scratchVecB)
        if (dotProd <= 0) continue

        const lengthSqA = this._scratchVecA.lengthSquared
        const lengthSqB = this._scratchVecB.lengthSquared
        
        if (dotProd * dotProd > lengthSqA * lengthSqB * cosSqThreshold) {
          converged = true
          break
        }
      }
      if (converged) break
    }

    this._isConverged = converged
    return converged
  }
}
