import { RpcError } from '@laborer/shared/rpc'
import { Effect, Layer } from 'effect'
import { SandboxProvider } from '../../src/services/sandbox-provider.js'

/**
 * No-op SandboxProvider for tests that compose `WorktreeReconciler.layer`
 * but don't exercise sandbox lifecycle. All methods except
 * `reconcileState` / `checkAvailability` return NOT_IMPLEMENTED errors.
 *
 * Tests that need to observe calls should build their own mock instead.
 */
const notImplemented = (method: string) => () =>
  Effect.fail(
    new RpcError({
      message: `${method} not implemented in test`,
      code: 'NOT_IMPLEMENTED',
    })
  )

export const NoopSandboxProvider = Layer.succeed(
  SandboxProvider,
  SandboxProvider.of({
    createSandbox: notImplemented('createSandbox'),
    destroySandbox: () => Effect.void,
    pauseSandbox: notImplemented('pauseSandbox'),
    resumeSandbox: notImplemented('resumeSandbox'),
    getPreviewUrl: notImplemented('getPreviewUrl'),
    spawnTerminal: notImplemented('spawnTerminal'),
    resizeTerminal: notImplemented('resizeTerminal'),
    killTerminal: notImplemented('killTerminal'),
    removeTerminal: notImplemented('removeTerminal'),
    reconcileState: () => Effect.void,
    checkAvailability: () => Effect.succeed({ available: false }),
    setAutoStopInterval: notImplemented('setAutoStopInterval'),
  })
)
