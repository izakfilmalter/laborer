/**
 * Deferred Service — Background initialization with placeholder proxies
 *
 * Provides a pattern for deferring heavy service initialization to a
 * background fiber while immediately providing placeholder proxies that
 * return typed "service initializing" errors for any method call.
 *
 * This enables the server's health endpoint to respond before all
 * services finish building. RPC handlers that invoke deferred services
 * before initialization completes receive an RpcError with code
 * 'SERVICE_INITIALIZING', which the renderer can interpret to show
 * appropriate loading states.
 *
 * Architecture:
 * - All deferred service Tags are provided with delegating proxies
 *   backed by Refs (initially pointing to placeholder implementations)
 * - A single background fiber builds the full DeferredServicesLive layer
 * - Once built, each Ref is swapped to the real service implementation
 * - All future RPC calls go through to the real services
 *
 * @see PRD section: "Server Layer Graph Splitting" (background initialization)
 * @see Issue #14: Server deferred layer group (background initialization)
 */

import { RpcError } from '@laborer/shared/rpc'
import { Context, Effect, Layer, Ref } from 'effect'

/**
 * Sentinel code used in RpcError to signal that a deferred service is
 * still initializing. The renderer checks for this code to show
 * "service loading..." UI instead of a generic error.
 */
export const SERVICE_INITIALIZING_CODE = 'SERVICE_INITIALIZING'

/**
 * Creates an RpcError indicating the service is still initializing.
 */
export const serviceInitializingError = (serviceName: string) =>
  new RpcError({
    message: `${serviceName} is still initializing — please retry shortly`,
    code: SERVICE_INITIALIZING_CODE,
  })

/**
 * Creates a placeholder proxy that returns SERVICE_INITIALIZING errors.
 *
 * For services whose methods return Effect.Effect<X, RpcError>,
 * the proxy returns Effect.fail(serviceInitializingError(...)).
 *
 * Methods in `overrides` are used instead of the default error behavior,
 * allowing specific methods to return valid placeholder data (e.g.,
 * DockerDetection.check returning { available: false }).
 */
export const makeServiceProxy = <T extends object>(
  serviceName: string,
  overrides: Partial<T> = {}
): T =>
  new Proxy(overrides as T, {
    get: (target, prop) => {
      if (typeof prop === 'symbol') {
        return undefined
      }
      if (prop in target) {
        return (target as Record<string, unknown>)[prop]
      }
      return (..._args: readonly unknown[]) =>
        Effect.fail(serviceInitializingError(serviceName))
    },
  })

/**
 * Creates a Ref-backed delegating proxy for a service.
 *
 * Returns { ref, proxy } where:
 * - `ref` holds the current implementation (starts with placeholder)
 * - `proxy` delegates all method calls through the Ref
 *
 * When the Ref is updated with the real service, all subsequent calls
 * automatically go through to it.
 */
export const makeRefDelegatingService = <Id, S extends object>(
  tag: Context.Tag<Id, S>,
  overrides: Partial<S> = {}
) =>
  Effect.gen(function* () {
    const serviceName = tag.key
    const placeholder = makeServiceProxy<S>(serviceName, overrides)
    const ref = yield* Ref.make<S>(placeholder)

    const proxy = new Proxy({} as S, {
      get: (_target, prop) => {
        if (typeof prop === 'symbol') {
          return undefined
        }
        return (...args: readonly unknown[]) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(ref)
            const method = (current as Record<string, unknown>)[prop]
            if (typeof method === 'function') {
              return yield* (
                method as (
                  ...a: readonly unknown[]
                ) => Effect.Effect<unknown, unknown, unknown>
              )(...args)
            }
            return method
          })
      },
    }) as S

    return { ref, proxy }
  })

/**
 * Tracks initialization state for all deferred services.
 *
 * Provides a Ref<boolean> that starts as `false` and is set to `true`
 * when all deferred services have initialized. Used by Issue #15
 * (Server "fully initialized" event) to signal the renderer.
 */
export class DeferredServicesReady extends Context.Tag(
  '@laborer/DeferredServicesReady'
)<DeferredServicesReady, { readonly ref: Ref.Ref<boolean> }>() {}

export const DeferredServicesReadyLayer = Layer.effect(
  DeferredServicesReady,
  Effect.gen(function* () {
    const ref = yield* Ref.make(false)
    return DeferredServicesReady.of({ ref })
  })
)
