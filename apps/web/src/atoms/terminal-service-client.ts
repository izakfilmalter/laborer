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
 * @see Issue #9: Renderer terminal UI wired to MessagePort
 * @see packages/terminal/src/utility-main.ts — Terminal utility process entry
 */

import { TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer } from 'effect'
import { AtomRpc } from 'effect/unstable/reactivity'
import { RpcClient } from 'effect/unstable/rpc'

import { acquireServicePort } from '@/lib/desktop'

const terminalProtocol: Layer.Layer<RpcClient.Protocol> = Layer.effect(
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
 */
export class TerminalServiceClient extends AtomRpc.Service<TerminalServiceClient>()(
  'TerminalServiceClient',
  {
    group: TerminalRpcs,
    protocol: terminalProtocol,
  }
) {}
