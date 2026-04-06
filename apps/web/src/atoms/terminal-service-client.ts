/**
 * TerminalServiceClient — AtomRpc client for the standalone terminal service.
 *
 * Communicates via a direct MessagePort connection to the terminal utility
 * process (no HTTP, no JSON serialization). The port is acquired lazily
 * via `desktopBridge.acquireServicePort('terminal')` when the first RPC
 * is made.
 *
 * This is separate from LaborerClient (which talks to the main server).
 * The terminal service manages PTY processes, terminal lifecycle, and
 * terminal state independently.
 *
 * Mutations are wrapped in `Effect.uninterruptible` so that in-flight RPC
 * requests complete even when the subscribing React component unmounts.
 *
 * @see Issue #9: Renderer terminal UI wired to MessagePort
 * @see packages/terminal/src/utility-main.ts — Terminal utility process entry
 */

import { Reactivity } from '@effect/experimental'
import { RpcClient } from '@effect/rpc'
import { Atom, AtomRpc } from '@effect-atom/atom'
import { TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer } from 'effect'

import { acquireServicePort } from '@/lib/desktop'

const terminalProtocol: Layer.Layer<RpcClient.Protocol> = Layer.scoped(
  RpcClient.Protocol,
  Effect.gen(function* () {
    const port = yield* Effect.promise(() => acquireServicePort('terminal'))
    if (!port) {
      return yield* Effect.die(
        'Terminal utility process is not running — could not acquire MessagePort'
      )
    }
    return yield* makeClientProtocolMessagePort(
      port as unknown as RpcMessagePort
    )
  })
)

/**
 * TerminalServiceClient — typed AtomRpc client for the terminal service.
 *
 * Provides `mutation` and `query` helpers for all TerminalRpcs endpoints:
 * - terminal.spawn, terminal.write, terminal.resize, terminal.kill
 * - terminal.remove, terminal.restart, terminal.list
 *
 * Mutations are uninterruptible — they run to completion even when the
 * subscribing React component unmounts.
 */
export class TerminalServiceClient extends AtomRpc.Tag<TerminalServiceClient>()(
  'TerminalServiceClient',
  {
    group: TerminalRpcs,
    protocol: terminalProtocol,
  }
) {}
// Override the default mutation factory with uninterruptible effects.
// See laborer-client.ts for detailed explanation.
;(TerminalServiceClient as unknown as Record<string, unknown>).mutation =
  Atom.family((tag: string) =>
    TerminalServiceClient.runtime.fn<{
      readonly payload: unknown
      readonly reactivityKeys?:
        | readonly unknown[]
        | Readonly<Record<string, readonly unknown[]>>
        | undefined
      readonly headers?: unknown
    }>()(
      Effect.fnUntraced(function* ({ headers, payload, reactivityKeys }) {
        const client = yield* TerminalServiceClient
        const effect = client(
          tag as never,
          payload as never,
          {
            headers,
          } as never
        )
        return yield* Effect.uninterruptible(
          reactivityKeys ? Reactivity.mutation(effect, reactivityKeys) : effect
        )
      })
    )
  )
