// ─────────────────────────────────────────────────────────────────────────────
// CursorAnimator — visual animation state from raw interaction inputs.
// Logic lives here; PointerCursorVisual is a pure rendering sink.
// ─────────────────────────────────────────────────────────────────────────────

// Far-field anticipation curve
// Visibility thresholds for ring contraction before a trigger fires.
// Confirm/release transitions are driven by the pinch trigger state.

const ANTICIPATE_ENTER = 0.35
const ANTICIPATE_EXIT = 0.27 // ANTICIPATE_ENTER − 0.08 hysteresis
const ANTICIPATION_NORMALIZE_TOP = 0.85 // strength mapped to full anticipation height
const ANTICIPATION_FRACTION = 0.6
const MIN_HELD_FRAMES = 1

export const HAND_CONFIRM_MS = 80
export const HAND_RELEASE_MS = 120

// Timer visual treatment
const TIMER_WAIT_MS = 300 // invisible hold before arc appears
const TIMER_RAMP_IN_FRAC = 0.04 // thickness ramps in over first 4% of visual fill
const TIMER_THIN_OUT_MS = 80 // thickness fades out over 80ms on release
const TIMER_FILL_ROTATION = Math.PI // start-angle drift per unit fill

// Near-field
const NEAR_ANTICIPATE_START_CM = 10

// Non-interactable
const NON_INTERACTABLE_ANIM_MS = 120

// Two-hand arc
const ARC_CUTOUT_MS = 120
const TAU = Math.PI * 2
const HALF_ARC_EXTENT = Math.PI
const LEFT_ARC_CENTER = Math.PI
const RIGHT_ARC_CENTER = 0

// Unified circle
const UNIFIED_GROW_MS = 120

// ═════════════════════════════════════════════════════════════════════════════
// Per-frame input
// ═════════════════════════════════════════════════════════════════════════════

/** Per-frame inputs passed to {@link CursorAnimator.tick}. */
export type CursorAnimatorInput = {
  /** [0, 1] — drives far-field anticipation curve. */
  interactionStrength: number
  /** Drives far-field confirm/release. */
  isPinchTriggerActive: boolean
  /** Distance to cursor in cm; null when not in near field. */
  nearFieldDistCm: number | null
  /** Drives near-field isPressed. */
  isPokeTriggerActive: boolean
  isNonInteractable: boolean
  /** From Interactor.holdTimerProgress. */
  holdTimerProgress: number
  /** From Interactor.secondaryTriggerHoldThreshold. */
  holdThresholdMs: number
  /** True while secondary trigger is active (hold completed, still pinching). */
  isSecondaryTriggering: boolean
  multipleInteractorsActive: boolean
  /** -1 left, 1 right, 0 non-hand. */
  handType: number
  dtMs: number
}

// ═════════════════════════════════════════════════════════════════════════════
// FarFieldStateMachine
// ═════════════════════════════════════════════════════════════════════════════

const enum FFState {
  Released,
  Anticipating,
  ConfirmingDown,
  Held
}

/** Maps interaction strength + pinch trigger to visual progress.
 * - Released: progress=0
 * - Anticipating: strength-driven progress curve, no trigger yet
 * - ConfirmingDown: pinch trigger fired — tween progress→1 over confirmMs
 * - Held: progress=1 while pinch trigger is active
 */
class FarFieldStateMachine {
  private state: FFState = FFState.Released
  private progress_ = 0
  private tweenStartProgress = 0
  private tweenElapsedMs = 0
  private heldFrames = 0

  /**
   * @param confirmMs - Duration of the confirm-down tween. 0 for instant.
   * @param releaseMs - Max time to descend from 1→0. 0 for instant.
   */
  constructor(
    private readonly confirmMs: number,
    private readonly releaseMs: number
  ) {}

  get progress(): number {
    return this.progress_
  }

  get isClosed(): boolean {
    return this.state === FFState.Held
  }

  tick(rawStrength: number, isPinchTriggerActive: boolean, dtMs: number): void {
    const range = ANTICIPATION_NORMALIZE_TOP - ANTICIPATE_ENTER
    const normalizedStrength = Math.max(0, Math.min(1, (rawStrength - ANTICIPATE_ENTER) / range))

    switch (this.state) {
      case FFState.Released:
        this.progress_ = 0

        if (isPinchTriggerActive) {
          this.enterConfirmingDown()
        } else if (rawStrength > ANTICIPATE_ENTER) {
          this.state = FFState.Anticipating
        }
        break

      case FFState.Anticipating: {
        const target = ANTICIPATION_FRACTION * normalizedStrength

        if (this.progress_ > target && this.releaseMs > 0) {
          // Descending from a higher state — rate-limit for smooth release.
          this.progress_ = Math.max(target, this.progress_ - dtMs / this.releaseMs)
        } else {
          // Ascending or steady — track input directly (it's pre-filtered).
          this.progress_ = target
        }

        if (isPinchTriggerActive) {
          this.enterConfirmingDown()
        } else if (rawStrength < ANTICIPATE_EXIT && this.progress_ <= 0) {
          this.state = FFState.Released
          this.progress_ = 0
        }
        break
      }

      case FFState.ConfirmingDown: {
        if (this.confirmMs === 0) {
          this.progress_ = 1.0
          this.state = FFState.Held
          this.heldFrames = 0
          break
        }

        this.tweenElapsedMs += dtMs
        const t = Math.min(this.tweenElapsedMs / this.confirmMs, 1.0)
        this.progress_ = this.tweenStartProgress + (1.0 - this.tweenStartProgress) * t

        if (t >= 1.0) {
          this.progress_ = 1.0
          this.state = FFState.Held
          this.heldFrames = 0
        }
        break
      }

      case FFState.Held:
        this.progress_ = 1.0
        this.heldFrames++

        if (this.heldFrames > MIN_HELD_FRAMES && !isPinchTriggerActive) {
          this.state = FFState.Anticipating
        }
        break
    }
  }

  private enterConfirmingDown(): void {
    this.tweenStartProgress = this.progress_
    this.tweenElapsedMs = 0
    this.state = FFState.ConfirmingDown
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// NearFieldStateMachine
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Maps fingertip-to-cursor distance to visual progress (10cm → 0, 0cm → 1.0).
 * Press is driven by the poke trigger.
 */
class NearFieldStateMachine {
  private progress_ = 0
  private isPressed_ = false

  get progress(): number {
    return this.progress_
  }

  get isPressed(): boolean {
    return this.isPressed_
  }

  tick(distCm: number | null, isPokeTriggerActive: boolean): void {
    if (distCm === null) {
      this.progress_ = 0
      this.isPressed_ = false
      return
    }
    this.progress_ = Math.max(0, Math.min(1, 1 - distCm / NEAR_ANTICIPATE_START_CM))
    this.isPressed_ = isPokeTriggerActive
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ActionTimer
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Visual treatment for the long-press timer arc.
 * Driven by `Interactor.holdTimerProgress`; handles thickness ramp-in and thin-out.
 */
class ActionTimer {
  private wasActive = false
  private thinOutElapsedMs = 0
  private lastActiveProgress = 0
  private fillValue_ = 0
  private thicknessMult_ = 0

  get fillValue(): number {
    return this.fillValue_
  }

  get thicknessMult(): number {
    return this.thicknessMult_
  }

  tick(dtMs: number, holdTimerProgress: number, holdThresholdMs: number, isSecondaryTriggering: boolean): void {
    // Keep arc fully filled while secondary trigger is held; stays full after hold completes until release.
    if (isSecondaryTriggering) {
      this.fillValue_ = 1.0
      this.thicknessMult_ = 1.0
      this.lastActiveProgress = 1.0
      this.thinOutElapsedMs = 0
      this.wasActive = true
      return
    }

    // Arc is invisible during TIMER_WAIT_MS, then fills over the remainder.
    const waitFrac = TIMER_WAIT_MS / holdThresholdMs
    const visualProgress = holdTimerProgress <= waitFrac ? 0 : (holdTimerProgress - waitFrac) / (1.0 - waitFrac)

    const isActive = visualProgress > 0

    if (isActive) {
      this.fillValue_ = visualProgress
      this.thicknessMult_ = visualProgress < TIMER_RAMP_IN_FRAC ? visualProgress / TIMER_RAMP_IN_FRAC : 1.0
      this.lastActiveProgress = visualProgress
      this.thinOutElapsedMs = 0
      this.wasActive = true
      return
    }

    if (!this.wasActive && this.thicknessMult_ === 0) return

    // Thin out instead of vanishing on release/completion.
    this.thinOutElapsedMs += dtMs
    this.thicknessMult_ = Math.max(0, 1.0 - this.thinOutElapsedMs / TIMER_THIN_OUT_MS)
    this.fillValue_ = this.lastActiveProgress

    if (this.thicknessMult_ === 0) {
      this.wasActive = false
      this.fillValue_ = 0
      this.lastActiveProgress = 0
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Linear tween helper
// ═════════════════════════════════════════════════════════════════════════════

/** Moves `current` toward `target` by at most `step`, clamping at the target. */
function tweenLinear(current: number, target: number, step: number): number {
  if (current < target) return Math.min(target, current + step)
  if (current > target) return Math.max(target, current - step)
  return current
}

// ═════════════════════════════════════════════════════════════════════════════
// TwoHandArcAnimator
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Drives the truncated arc and unified-circle visuals when two cursors are active.
 * Tracks the cutout tween, hand-positioned arc center, and unified-circle grow/release.
 */
class TwoHandArcAnimator {
  private cutoutProgress_ = 0
  private arcCenter_ = 0
  private active_ = false
  private prevClosed_ = false
  private growProgress_ = 0
  private releaseAlpha_ = 0

  /** Stroke arc extent in radians: TAU when single-hand, π when two-hand. */
  get strokeArcExtent(): number {
    return HALF_ARC_EXTENT + (1.0 - this.cutoutProgress_) * (TAU - HALF_ARC_EXTENT)
  }

  /** Stroke arc center angle in radians. */
  get strokeArcCenter(): number {
    return this.arcCenter_
  }

  /** Unifying circle grow progress, 0 (hidden) to 1 (full). */
  get unifyingProgress(): number {
    return this.growProgress_
  }

  /** Unifying circle release fade alpha, 1 (visible) to 0 (gone). */
  get unifyingAlpha(): number {
    return this.releaseAlpha_
  }

  tick(active: boolean, isClosed: boolean, handType: number, dtMs: number): void {
    this.active_ = active
    this.arcCenter_ = handType < 0 ? LEFT_ARC_CENTER : RIGHT_ARC_CENTER
    this.cutoutProgress_ = tweenLinear(this.cutoutProgress_, active ? 1.0 : 0.0, dtMs / ARC_CUTOUT_MS)

    if (this.active_) {
      if (isClosed) {
        this.growProgress_ = Math.min(1.0, this.growProgress_ + dtMs / UNIFIED_GROW_MS)
        this.releaseAlpha_ = 0
      } else {
        if (this.prevClosed_) {
          this.releaseAlpha_ = this.growProgress_
          this.growProgress_ = 0
        }
        this.releaseAlpha_ = Math.max(0, this.releaseAlpha_ - dtMs / UNIFIED_GROW_MS)
      }
    } else {
      this.growProgress_ = isClosed ? 1.0 : 0.0
      this.releaseAlpha_ = 0
    }

    this.prevClosed_ = isClosed
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CursorAnimator
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Cursor animation state from raw interaction inputs.
 * Output composes via `max(progress)` and `farPressed || nearPressed`.
 */
export class CursorAnimator {
  private farFieldSM: FarFieldStateMachine
  private nearFieldSM = new NearFieldStateMachine()
  private actionTimer = new ActionTimer()
  private twoHandArc = new TwoHandArcAnimator()

  /**
   * @param confirmMs - Confirm-down tween duration. 0 for instant (mouse/mobile).
   * @param releaseMs - Release tween duration. 0 for instant (mouse/mobile).
   */
  constructor(confirmMs: number, releaseMs: number) {
    this.farFieldSM = new FarFieldStateMachine(confirmMs, releaseMs)
  }

  private compositeProgress_ = 0
  private compositeClosed_ = false
  private nonInteractableProgress_ = 0
  private baseAlpha_ = 0.5
  private timerStartAngle_ = Math.PI / 2

  /** Visual progression from idle ring (0) to pressed unified circle (1). */
  get progress(): number {
    return this.compositeProgress_
  }

  /** Whether the active cursor mode is in its fully-pressed state. */
  get isClosed(): boolean {
    return this.compositeClosed_
  }

  /** Base opacity: 0.5 when released, 1.0 when pressed. */
  get baseAlpha(): number {
    return this.baseAlpha_
  }

  /** Timer arc fill amount, 0 (empty) to 1 (full). */
  get timerFillAmount(): number {
    return this.actionTimer.fillValue
  }

  /** Timer arc start angle in radians. Drifts as the arc fills. */
  get timerStartAngle(): number {
    return this.timerStartAngle_
  }

  /** Timer arc thickness multiplier for ramp-in and thin-out animations. */
  get timerThicknessMult(): number {
    return this.actionTimer.thicknessMult
  }

  /** 0 when hovering over an interactable, 1 when not. Animated over 120ms. */
  get nonInteractableProgress(): number {
    return this.nonInteractableProgress_
  }

  get strokeArcExtent(): number {
    return this.twoHandArc.strokeArcExtent
  }

  get strokeArcCenter(): number {
    return this.twoHandArc.strokeArcCenter
  }

  get unifyingProgress(): number {
    return this.twoHandArc.unifyingProgress
  }

  get unifyingAlpha(): number {
    return this.twoHandArc.unifyingAlpha
  }

  /** Advances animation state by one frame. */
  tick(input: CursorAnimatorInput): void {
    const {
      interactionStrength,
      isPinchTriggerActive,
      nearFieldDistCm,
      isPokeTriggerActive,
      isNonInteractable,
      holdTimerProgress,
      holdThresholdMs,
      isSecondaryTriggering,
      multipleInteractorsActive,
      handType,
      dtMs
    } = input

    // Freeze far-field during secondary trigger so the cursor stays pressed
    if (!isSecondaryTriggering) {
      this.farFieldSM.tick(interactionStrength, isPinchTriggerActive, dtMs)
    }
    this.nearFieldSM.tick(nearFieldDistCm, isPokeTriggerActive)

    this.compositeProgress_ = Math.max(this.farFieldSM.progress, this.nearFieldSM.progress)
    this.compositeClosed_ = this.farFieldSM.isClosed || this.nearFieldSM.isPressed

    this.actionTimer.tick(dtMs, holdTimerProgress, holdThresholdMs, isSecondaryTriggering)

    this.baseAlpha_ = this.compositeClosed_ || isSecondaryTriggering ? 1.0 : 0.5
    this.timerStartAngle_ = Math.PI / 2 - this.actionTimer.fillValue * TIMER_FILL_ROTATION

    const niTarget = isNonInteractable ? 1.0 : 0.0
    this.nonInteractableProgress_ = tweenLinear(
      this.nonInteractableProgress_,
      niTarget,
      dtMs / NON_INTERACTABLE_ANIM_MS
    )

    this.twoHandArc.tick(multipleInteractorsActive, this.compositeClosed_, handType, dtMs)
  }
}
