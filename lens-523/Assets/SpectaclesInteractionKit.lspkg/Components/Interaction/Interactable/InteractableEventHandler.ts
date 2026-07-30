import {InteractorInputType} from "../../../Core/Interactor/Interactor"

/**
 * Minimum fields required from event arguments for the handler to process events.
 * The generic type parameter allows the full event type to flow through to callbacks.
 */
export type InteractableEventHandlerArgs = {
  interactor: {
    inputType: InteractorInputType
    currentDragVector: vec3 | null
    previousDragVector: vec3 | null
    planecastDragVector: vec3 | null
  }
}

/**
 * Extended args for drag events.
 */
export type DragEventArgs<T extends InteractableEventHandlerArgs> = T & {
  dragVector: vec3
}

/**
 * Callbacks that the event handler will invoke.
 * Generic type T allows the full event args to flow through.
 */
export type InteractableEventCallbacks<T extends InteractableEventHandlerArgs> = {
  // Hover events
  onHoverEnter: (args: T) => void
  onInteractorHoverEnter: (args: T) => void
  onHoverUpdate: (args: T) => void
  onInteractorHoverExit: (args: T) => void
  onHoverExit: (args: T) => void

  // Trigger events
  onTriggerStart: (args: T) => void
  onInteractorTriggerStart: (args: T) => void
  onTriggerUpdate: (args: T) => void
  onInteractorTriggerEnd: (args: T) => void
  onTriggerEnd: (args: T) => void
  onInteractorTriggerEndOutside: (args: T) => void
  onTriggerEndOutside: (args: T) => void
  onTriggerCanceled: (args: T) => void

  // Drag events
  onDragStart: (args: DragEventArgs<T>) => void
  onDragUpdate: (args: DragEventArgs<T>) => void
  onDragEnd: (args: DragEventArgs<T>) => void

  // Secondary trigger events
  onSecondaryTriggerStart: (args: T) => void
  onInteractorSecondaryTriggerStart: (args: T) => void
  onSecondaryTriggerUpdate: (args: T) => void
  onInteractorSecondaryTriggerEnd: (args: T) => void
  onSecondaryTriggerEnd: (args: T) => void
  onInteractorSecondaryTriggerEndOutside: (args: T) => void
  onSecondaryTriggerEndOutside: (args: T) => void
  onSecondaryTriggerCanceled: (args: T) => void
}

/**
 * Manages the event handling logic for Interactables:
 * - Tracking which interactors are hovering/triggering (via bitflags)
 * - Determining compound events (first hover vs additional hover)
 *
 * The generic type T allows the full event args type to flow through
 * to callbacks while the handler only accesses the fields it needs.
 */
export class InteractableEventHandler<T extends InteractableEventHandlerArgs> {
  private _hoveringInteractor: InteractorInputType = InteractorInputType.None
  private _triggeringInteractor: InteractorInputType = InteractorInputType.None
  private _secondaryTriggeringInteractor: InteractorInputType = InteractorInputType.None

  private readonly callbacks: InteractableEventCallbacks<T>

  constructor(callbacks: InteractableEventCallbacks<T>) {
    this.callbacks = callbacks
  }

  get hoveringInteractor(): InteractorInputType {
    return this._hoveringInteractor
  }

  get triggeringInteractor(): InteractorInputType {
    return this._triggeringInteractor
  }

  get secondaryTriggeringInteractor(): InteractorInputType {
    return this._secondaryTriggeringInteractor
  }

  hoverEnter(eventArgs: T): void {
    if (this._hoveringInteractor === InteractorInputType.None) {
      this.callbacks.onHoverEnter(eventArgs)
    }

    this._hoveringInteractor |= eventArgs.interactor.inputType
    this.callbacks.onInteractorHoverEnter(eventArgs)
  }

  hoverUpdate(eventArgs: T): void {
    if (this._hoveringInteractor === InteractorInputType.None) {
      return
    }

    this.callbacks.onHoverUpdate(eventArgs)
  }

  hoverExit(eventArgs: T): void {
    this._hoveringInteractor &= ~eventArgs.interactor.inputType

    this.callbacks.onInteractorHoverExit(eventArgs)

    if (this._hoveringInteractor === InteractorInputType.None) {
      this.callbacks.onHoverExit(eventArgs)
    }
  }

  triggerStart(eventArgs: T): void {
    if (this._triggeringInteractor === InteractorInputType.None) {
      this.callbacks.onTriggerStart(eventArgs)
    }

    this._triggeringInteractor |= eventArgs.interactor.inputType
    this.callbacks.onInteractorTriggerStart(eventArgs)
  }

  triggerUpdate(eventArgs: T): void {
    this.callbacks.onTriggerUpdate(eventArgs)

    this.dragStartOrUpdate(eventArgs)
  }

  triggerEnd(eventArgs: T): void {
    this._triggeringInteractor &= ~eventArgs.interactor.inputType

    this.callbacks.onInteractorTriggerEnd(eventArgs)

    if (this._triggeringInteractor === InteractorInputType.None) {
      this.callbacks.onTriggerEnd(eventArgs)
    }

    this.dragEnd(eventArgs)
  }

  triggerEndOutside(eventArgs: T): void {
    this._triggeringInteractor &= ~eventArgs.interactor.inputType

    this.callbacks.onInteractorTriggerEndOutside(eventArgs)

    if (this._triggeringInteractor === InteractorInputType.None) {
      this.callbacks.onTriggerEndOutside(eventArgs)
    }

    this.dragEnd(eventArgs)
  }

  triggerCanceled(eventArgs: T): void {
    this._triggeringInteractor &= ~eventArgs.interactor.inputType

    this.callbacks.onTriggerCanceled(eventArgs)

    this.dragEnd(eventArgs)
  }

  secondaryTriggerStart(eventArgs: T): void {
    if (this._secondaryTriggeringInteractor === InteractorInputType.None) {
      this.callbacks.onSecondaryTriggerStart(eventArgs)
    }

    this._secondaryTriggeringInteractor |= eventArgs.interactor.inputType
    this.callbacks.onInteractorSecondaryTriggerStart(eventArgs)
  }

  secondaryTriggerUpdate(eventArgs: T): void {
    this.callbacks.onSecondaryTriggerUpdate(eventArgs)
  }

  secondaryTriggerEnd(eventArgs: T): void {
    this._secondaryTriggeringInteractor &= ~eventArgs.interactor.inputType
    this.callbacks.onInteractorSecondaryTriggerEnd(eventArgs)

    if (this._secondaryTriggeringInteractor === InteractorInputType.None) {
      this.callbacks.onSecondaryTriggerEnd(eventArgs)
    }
  }

  secondaryTriggerEndOutside(eventArgs: T): void {
    this._secondaryTriggeringInteractor &= ~eventArgs.interactor.inputType
    this.callbacks.onInteractorSecondaryTriggerEndOutside(eventArgs)

    if (this._secondaryTriggeringInteractor === InteractorInputType.None) {
      this.callbacks.onSecondaryTriggerEndOutside(eventArgs)
    }
  }

  secondaryTriggerCanceled(eventArgs: T): void {
    this._secondaryTriggeringInteractor &= ~eventArgs.interactor.inputType
    this.callbacks.onSecondaryTriggerCanceled(eventArgs)
  }

  reset(): void {
    this._hoveringInteractor = InteractorInputType.None
    this._triggeringInteractor = InteractorInputType.None
    this._secondaryTriggeringInteractor = InteractorInputType.None
  }

  private dragStartOrUpdate(eventArgs: T): void {
    const currentDrag = eventArgs.interactor.currentDragVector
    if (currentDrag === null) {
      return
    }

    const dragArgs = {...eventArgs, dragVector: currentDrag} as DragEventArgs<T>

    if (eventArgs.interactor.previousDragVector === null) {
      this.callbacks.onDragStart(dragArgs)
    } else {
      this.callbacks.onDragUpdate(dragArgs)
    }
  }

  private dragEnd(eventArgs: T): void {
    const previousDrag = eventArgs.interactor.previousDragVector
    if (previousDrag === null) {
      return
    }

    this.callbacks.onDragEnd({
      ...eventArgs,
      dragVector: previousDrag
    } as DragEventArgs<T>)
  }
}
