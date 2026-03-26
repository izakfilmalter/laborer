/**
 * TerminalServiceClient — AtomRpc client for the standalone terminal service.
 *
 * In Electron mode, communicates via a direct MessagePort connection to
 * the terminal utility process (no HTTP, no JSON serialization). The port
 * is acquired lazily via `desktopBridge.acquireServicePort('terminal')`
 * when the first RPC is made.
 *
 * In browser dev mode (Vite), falls back to HTTP at `/terminal-rpc`.
 *
 * This is separate from LaborerClient (which talks to the main server).
 * The terminal service manages PTY processes, terminal lifecycle, and
 * terminal state independently.
 *
 * @see Issue #9: Renderer terminal UI wired to MessagePort
 * @see packages/terminal/src/utility-main.ts — Terminal utility process entry
 */

import { FetchHttpClient } from '@effect/platform'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { AtomRpc } from '@effect-atom/atom'
import { TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer } from 'effect'

import { getDesktopBridge, isElectron, terminalRpcUrl } from '@/lib/desktop'

/**
 * Build the RPC client protocol layer based on the runtime context.
 *
 * - Electron: MessagePort acquired from `desktopBridge.acquireServicePort('terminal')`.
 *   The port is acquired lazily inside `Layer.scoped` when the layer is first built
 *   (i.e., when a React component first subscribes to a query/mutation atom).
 *   No `RpcSerialization.layerJson` or `FetchHttpClient.layer` needed — MessagePort
 *   uses structured clone natively.
 *
 * - Browser dev: HTTP at `/terminal-rpc` (Vite proxy rewrites to terminal's /rpc).
 */
const terminalProtocol: Layer.Layer<RpcClient.Protocol> = isElectron()
  ? Layer.scoped(
      RpcClient.Protocol,
      Effect.gen(function* () {
        const bridge = getDesktopBridge()
        if (!bridge) {
          return yield* Effect.die(
            'DesktopBridge unavailable in Electron context'
          )
        }
        const port = yield* Effect.promise(() =>
          bridge.acquireServicePort('terminal')
        )
        if (!port) {
          return yield* Effect.die(
            'Terminal utility process is not running — could not acquire MessagePort'
          )
        }
        // Cast Web MessagePort to RpcMessagePort — the runtime handles both
        // API styles (.onmessage setter vs .on('message') method) correctly.
        // The type mismatch is because Web's onmessage uses MessageEvent while
        // RpcMessagePort uses a simpler { data: unknown } shape.
        return yield* makeClientProtocolMessagePort(port as RpcMessagePort)
      })
    )
  : RpcClient.layerProtocolHttp({ url: terminalRpcUrl() }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerJson)
    )

/**
 * TerminalServiceClient — typed AtomRpc client for the terminal service.
 *
 * Provides `mutation` and `query` helpers for all TerminalRpcs endpoints:
 * - terminal.spawn, terminal.write, terminal.resize, terminal.kill
 * - terminal.remove, terminal.restart, terminal.list
 */
export class TerminalServiceClient extends AtomRpc.Tag<TerminalServiceClient>()(
  'TerminalServiceClient',
  {
    group: TerminalRpcs,
    protocol: terminalProtocol,
  }
) {}
