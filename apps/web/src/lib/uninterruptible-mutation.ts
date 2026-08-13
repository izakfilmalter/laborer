/**
 * Wraps an Effect in an uninterruptible region so it completes even when the
 * subscribing atom fiber is interrupted (e.g. on React component unmount).
 *
 * AtomRpc mutations run inside interruptible fibers by default. When a React
 * component unmounts, the atom registry disposes the fiber, sending an RPC
 * Interrupt message that cancels the in-flight request. Wrapping the effect
 * in `Effect.uninterruptible` prevents this — the mutation runs to completion
 * regardless of component lifecycle.
 *
 * @see packages/shared/src/rpc-transport-messageport-client.ts — transport layer
 * @see Atom.ts makeResultFn line 1146 — hardcodes uninterruptible=false
 */

import { Effect } from 'effect'

export const wrapUninterruptible = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => Effect.uninterruptible(effect)
