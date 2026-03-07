/**
 * PortAllocator — Effect Service
 *
 * Manages allocation and deallocation of ports from a configured range
 * (PORT_RANGE_START to PORT_RANGE_END from env) for workspace dev servers.
 * Each workspace gets a unique port to avoid conflicts.
 *
 * Uses Effect Ref for thread-safe (fiber-safe) concurrent access to the
 * allocated ports set. This prevents race conditions when multiple
 * workspaces are created simultaneously.
 *
 * Graceful shutdown (Issue #130):
 * On server shutdown (SIGINT/SIGTERM), the layer finalizer clears all
 * allocated ports and logs the count. This ensures consistent state on
 * restart — the full port range is available. While ports are in-memory
 * only (not OS-level reserved), clean accounting prevents potential
 * issues if port state is ever persisted.
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const allocator = yield* PortAllocator
 *   const port = yield* allocator.allocate()
 *   // ... use port for workspace
 *   yield* allocator.free(port)
 * })
 * ```
 *
 * Issue #29: allocate method
 * Issue #30: free method
 * Issue #31: exhaustion handling (built into allocate)
 * Issue #32: concurrent allocation safety (Ref-based atomicity)
 * Issue #130: graceful shutdown — free all ports
 */

import { RpcError } from '@laborer/shared/rpc'
import { Context, Effect, Layer, Ref } from 'effect'

/** Logger tag used for structured Effect.log output in this module. */
const logPrefix = 'PortAllocator'

/**
 * PortAllocator Effect Context Tag
 *
 * Tagged service that manages port allocation from a configured range.
 * Ports are tracked in memory via an Effect Ref for fiber-safe access.
 */
class PortAllocator extends Context.Tag('@laborer/PortAllocator')<
  PortAllocator,
  {
    /**
     * Allocate the next available port from the configured range.
     * Returns the port number on success.
     * Fails with RpcError if all ports are exhausted.
     */
    readonly allocate: () => Effect.Effect<number, RpcError>
    /**
     * Free a previously allocated port, making it available for reallocation.
     * Fails with RpcError if the port was not allocated.
     */
    readonly free: (port: number) => Effect.Effect<void, RpcError>
  }
>() {
  /**
   * Create a PortAllocator layer with a specific port range.
   *
   * Uses Layer.scoped to support Effect.addFinalizer for graceful shutdown.
   * On shutdown, all allocated ports are freed and the count is logged.
   *
   * @param rangeStart - First port in the allocation range (inclusive)
   * @param rangeEnd - Last port in the allocation range (inclusive)
   */
  static readonly make = (rangeStart: number, rangeEnd: number) =>
    Layer.scoped(
      PortAllocator,
      Effect.gen(function* () {
        // Track allocated ports in a Ref (fiber-safe mutable state)
        const allocatedRef = yield* Ref.make(new Set<number>())

        const allocate = Effect.fn('PortAllocator.allocate')(function* () {
          // Atomically find and allocate the next available port
          return yield* Ref.modify(allocatedRef, (allocated) => {
            for (let port = rangeStart; port <= rangeEnd; port++) {
              if (!allocated.has(port)) {
                const next = new Set(allocated)
                next.add(port)
                return [port, next] as const
              }
            }
            // All ports exhausted — return a sentinel that we handle below
            return [-1, allocated] as const
          }).pipe(
            Effect.flatMap((port) =>
              port === -1
                ? Effect.fail(
                    new RpcError({
                      message: `All ports in range ${rangeStart}-${rangeEnd} are allocated (${rangeEnd - rangeStart + 1} ports)`,
                      code: 'PORT_EXHAUSTED',
                    })
                  )
                : Effect.succeed(port)
            )
          )
        })

        const free = Effect.fn('PortAllocator.free')(function* (port: number) {
          // Atomically check and remove the port from the allocated set
          const wasAllocated = yield* Ref.modify(allocatedRef, (allocated) => {
            if (!allocated.has(port)) {
              return [false, allocated] as const
            }
            const next = new Set(allocated)
            next.delete(port)
            return [true, next] as const
          })

          if (!wasAllocated) {
            return yield* new RpcError({
              message: `Port ${port} is not currently allocated (range: ${rangeStart}-${rangeEnd})`,
              code: 'PORT_NOT_ALLOCATED',
            })
          }
        })

        // -----------------------------------------------------------
        // Graceful shutdown finalizer (Issue #130)
        // -----------------------------------------------------------
        // When the server shuts down (SIGINT/SIGTERM), Effect tears
        // down all layer scopes. This finalizer clears the allocated
        // ports set and logs the count for observability. This ensures:
        // 1. Clean accounting — all ports are marked as freed
        // 2. On restart, the full port range is available
        // 3. Shutdown progress is observable in server output
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const allocated = yield* Ref.get(allocatedRef)

            if (allocated.size === 0) {
              yield* Effect.log(
                `Shutdown: no allocated ports to free (range ${rangeStart}-${rangeEnd})`
              ).pipe(Effect.annotateLogs('module', logPrefix))
              return
            }

            const portList = [...allocated].sort((a, b) => a - b).join(', ')

            // Clear all allocated ports
            yield* Ref.set(allocatedRef, new Set<number>())

            yield* Effect.log(
              `Shutdown: freed ${allocated.size} allocated port(s): [${portList}] (range ${rangeStart}-${rangeEnd})`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          })
        )

        return PortAllocator.of({ allocate, free })
      })
    )

  /**
   * Default layer using env-configured port range.
   * Reads PORT_RANGE_START and PORT_RANGE_END from @laborer/env/server.
   */
  static readonly layer = Effect.gen(function* () {
    // Import env lazily to avoid import-time side effects during testing
    const { env } = yield* Effect.promise(() => import('@laborer/env/server'))
    return {
      rangeStart: env.PORT_RANGE_START,
      rangeEnd: env.PORT_RANGE_END,
    }
  }).pipe(
    Effect.map(({ rangeStart, rangeEnd }) =>
      PortAllocator.make(rangeStart, rangeEnd)
    ),
    Layer.unwrapEffect
  )
}

export { PortAllocator }
