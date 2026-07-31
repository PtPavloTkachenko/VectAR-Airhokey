/**
 * Event class with typed event arguments
 */

export type callback<Arg> = (args: Arg) => void
export type unsubscribe = () => void

/**
 * Represents the public api of an event.
 */
export interface PublicApi<Arg> {
  add(cb: callback<Arg>): unsubscribe
  remove(cb: callback<Arg>): void
  readonly hasListeners: boolean
}

export default class Event<Arg = void> implements PublicApi<Arg> {
  private subscribers: callback<Arg>[]

  constructor(...callbacks: (callback<Arg> | undefined)[]) {
    for (let i = callbacks.length - 1; i >= 0; i--) {
      if (callbacks[i] === undefined) {
        callbacks.splice(i, 1)
      }
    }
    this.subscribers = callbacks as callback<Arg>[]
  }

  /**
   * Register an event handler
   *
   * @param handler to register
   * @returns the function to invoke when unsubscribing from the event.
   */
  public add(handler: callback<Arg>): unsubscribe {
    this.subscribers.push(handler)
    return () => this.remove(handler)
  }

  /**
   * Unregister an event handler
   *
   * @param handler to remove
   */
  public remove(handler: callback<Arg>) {
    this.subscribers = this.subscribers.filter((h) => {
      return h !== handler
    })
  }

  /**
   * @returns whether there are any subscribers registered to this event
   */
  get hasListeners(): boolean {
    return this.subscribers.length > 0
  }

  /**
   * Invoke the event and notify handlers
   *
   * @param arg Event args to pass to the handlers
   */
  public invoke(arg: Arg) {
    this.subscribers.forEach((handler) => {
      handler(arg)
    })
  }

  /**
   * Returns this event viewed through the PublicApi interface, which exposes
   * only `add`, `remove`, and `hasListeners` and hides `invoke` from external
   * callers.
   */
  public publicApi(): PublicApi<Arg> {
    return this as PublicApi<Arg>
  }
}
