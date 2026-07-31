import {Singleton} from "../Decorators/Singleton"
import {LensConfig} from "./LensConfig"
import NativeLogger from "./NativeLogger"
import {UpdateDispatcherPriority} from "./UpdateDispatcher"

const TAG = "FrameCache"
const log = new NativeLogger(TAG)

/**
 * A cached function wrapper that stores the result of expensive computations
 * and automatically flushes the cache at the start of each frame.
 */
interface CachedFunction<T> {
  (): T
  /** Force clear the cache (normally done automatically each frame) */
  clearCache(): void
  /** Check if the result is currently cached */
  isCached(): boolean
}

/**
 * FrameCache provides automatic per-frame caching for expensive function calls.
 *
 * This utility allows you to wrap expensive methods so that:
 * 1. The first call in a frame executes the original function and caches the result
 * 2. Subsequent calls in the same frame return the cached result
 * 3. The cache is automatically cleared at the start of each new frame
 *
 * Usage:
 * ```typescript
 * // Get the singleton instance
 * private frameCache = FrameCache.getInstance()
 *
 * // Wrap an expensive method
 * private getCachedHandOrientation = this.frameCache.wrap(
 *   'getHandOrientation',
 *   () => this.computeHandOrientation()
 * )
 *
 * // Use the cached version
 * const orientation = this.getCachedHandOrientation()
 * ```
 */
@Singleton
export class FrameCache {
  public static getInstance: () => FrameCache

  private entries = new Map<string, CachedFunction<any>>()
  private flushCallbacks: (() => void)[] = []
  private isInitialized = false

  constructor() {
    this.initializeGlobalFlushIfNeeded()
  }

  /**
   * Wrap a function with per-frame caching.
   * Uses a single closure — no intermediate class or multi-hop chain.
   *
   * @param key Unique identifier for this cached function
   * @param fn The expensive function to cache
   * @returns A cached version of the function
   */
  wrap<T>(key: string, fn: () => T): CachedFunction<T> {
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      log.w(`Cache key '${key}' already exists in FrameCache. Returning existing cached function.`)
      return existing as CachedFunction<T>
    }

    let cachedResult: T | undefined
    let hasCachedResult = false

    const callableFn = (() => {
      if (hasCachedResult) return cachedResult!
      cachedResult = fn()
      hasCachedResult = true
      return cachedResult!
    }) as CachedFunction<T>

    callableFn.clearCache = () => {
      cachedResult = undefined
      hasCachedResult = false
    }
    callableFn.isCached = () => hasCachedResult

    this.entries.set(key, callableFn)
    this.flushCallbacks.push(callableFn.clearCache)

    log.v(`Registered cached function '${key}' in FrameCache`)
    return callableFn
  }

  /**
   * Wrap a method with per-frame caching, preserving 'this' context.
   * Produces a single closure bound via `.bind()` — no `fn.call(context)` per invocation.
   *
   * @param key Unique identifier for this cached function
   * @param context The object context ('this')
   * @param fn The expensive method to cache
   * @returns A cached version of the method
   */
  wrapMethod<T, TContext>(key: string, context: TContext, fn: (this: TContext) => T): () => T {
    return this.wrap(key, fn.bind(context))
  }

  /**
   * Clear all caches managed by this instance.
   * Iterates a flat array of clearCache callbacks — no Map overhead.
   */
  flushAll(): void {
    const callbacks = this.flushCallbacks
    for (let i = 0; i < callbacks.length; i++) {
      callbacks[i]()
    }
  }

  /**
   * Remove a cached function and its flush callback.
   */
  remove(key: string): boolean {
    const entry = this.entries.get(key)
    if (entry === undefined) {
      return false
    }

    this.entries.delete(key)

    const idx = this.flushCallbacks.indexOf(entry.clearCache)
    if (idx !== -1) {
      this.flushCallbacks.splice(idx, 1)
    }

    log.v(`Removed cached function '${key}' from FrameCache`)
    return true
  }

  /**
   * Initialize global cache flushing if not already done.
   * Only called once due to singleton pattern.
   */
  private initializeGlobalFlushIfNeeded(): void {
    if (this.isInitialized) {
      return
    }

    this.isInitialized = true

    LensConfig.getInstance().updateDispatcher.createUpdateEvent(
      "FrameCache_GlobalFlush",
      () => this.flushAll(),
      UpdateDispatcherPriority.FlushCache
    )

    log.i("Initialized global cache flushing for FrameCache")
  }
}

// Global instance for convenience
export const frameCache = FrameCache.getInstance()
