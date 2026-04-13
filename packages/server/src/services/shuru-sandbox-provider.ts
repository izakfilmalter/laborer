import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Array as Arr, Context, Effect, Layer, pipe } from 'effect'

import { LaborerStore } from './laborer-store.js'
import type {
  CreateSandboxParams,
  SandboxProvider,
} from './sandbox-provider.js'
import { ShuruClient } from './shuru-client.js'
import { ShuruDetection } from './shuru-detection.js'

const logPrefix = 'ShuruSandboxProvider'

const shuruNotImplemented = (operation: string) =>
  new RpcError({
    message: `Shuru ${operation} lands in a later slice. This iteration only supports sandbox create and destroy.`,
    code: 'SHURU_NOT_IMPLEMENTED',
  })

class ShuruSandboxProvider extends Context.Tag('@laborer/ShuruSandboxProvider')<
  ShuruSandboxProvider,
  SandboxProvider['Type']
>() {
  static readonly layer: Layer.Layer<
    ShuruSandboxProvider,
    never,
    LaborerStore | ShuruClient | ShuruDetection
  > = Layer.effect(
    ShuruSandboxProvider,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const shuruClient = yield* ShuruClient
      const shuruDetection = yield* ShuruDetection

      const createSandbox = Effect.fn('ShuruSandboxProvider.createSandbox')(
        function* (params: CreateSandboxParams) {
          if (params.worktreePath.length === 0) {
            return yield* new RpcError({
              message:
                'Shuru sandbox creation requires a local worktree path, but none was provided.',
              code: 'SHURU_CONFIG_ERROR',
            })
          }

          yield* Effect.logInfo(
            `Creating Shuru sandbox for workspace "${params.workspaceId}" from worktree "${params.worktreePath}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          const sandbox = yield* shuruClient.startSandbox({
            workspaceId: params.workspaceId,
            worktreePath: params.worktreePath,
          })

          store.commit(
            events.sandboxStarted({
              workspaceId: params.workspaceId,
              sandboxId: sandbox.sandboxId,
              sandboxUrl: '',
              sandboxImage: 'shuru',
              sandboxProvider: 'shuru',
            })
          )

          if (params.onReady !== undefined) {
            yield* params.onReady(params.workspaceId)
          }
        }
      )

      const destroySandbox = Effect.fn('ShuruSandboxProvider.destroySandbox')(
        function* (workspaceId: string) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspace = pipe(
            allWorkspaces,
            Arr.findFirst((candidate) => candidate.id === workspaceId)
          )

          if (workspace._tag === 'None') {
            return
          }

          yield* shuruClient
            .stopSandbox(workspaceId)
            .pipe(
              Effect.catchAll((error) =>
                Effect.logWarning(
                  `Failed to stop Shuru runtime for workspace "${workspaceId}": ${error.message}`
                ).pipe(Effect.annotateLogs('module', logPrefix))
              )
            )

          if (workspace.value.sandboxId !== null) {
            store.commit(events.sandboxStopped({ workspaceId }))
          }
        }
      )

      const pauseSandbox = Effect.fn('ShuruSandboxProvider.pauseSandbox')(
        function* () {
          return yield* shuruNotImplemented('pause/resume')
        }
      )

      const resumeSandbox = Effect.fn('ShuruSandboxProvider.resumeSandbox')(
        function* () {
          return yield* shuruNotImplemented('pause/resume')
        }
      )

      const getPreviewUrl = Effect.fn('ShuruSandboxProvider.getPreviewUrl')(
        function* () {
          return yield* shuruNotImplemented('preview URLs')
        }
      )

      const spawnTerminal = Effect.fn('ShuruSandboxProvider.spawnTerminal')(
        function* () {
          return yield* shuruNotImplemented('dev-server terminals')
        }
      )

      const resizeTerminal = Effect.fn('ShuruSandboxProvider.resizeTerminal')(
        function* () {
          return yield* shuruNotImplemented('terminal resize')
        }
      )

      const killTerminal = Effect.fn('ShuruSandboxProvider.killTerminal')(
        function* () {
          return yield* shuruNotImplemented('terminal kill')
        }
      )

      const removeTerminal = Effect.fn('ShuruSandboxProvider.removeTerminal')(
        function* () {
          return yield* shuruNotImplemented('terminal removal')
        }
      )

      const reconcileState = Effect.fn('ShuruSandboxProvider.reconcileState')(
        function* () {
          yield* Effect.logDebug(
            'Shuru reconciliation is a no-op until the stale-runtime slice lands.'
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      const checkAvailability = Effect.fn(
        'ShuruSandboxProvider.checkAvailability'
      )(function* () {
        return yield* shuruDetection.check()
      })

      const setAutoStopInterval = Effect.fn(
        'ShuruSandboxProvider.setAutoStopInterval'
      )(function* () {
        // Shuru does not currently expose a provider-managed auto-stop setting.
      })

      return ShuruSandboxProvider.of({
        createSandbox,
        destroySandbox,
        pauseSandbox,
        resumeSandbox,
        getPreviewUrl,
        spawnTerminal,
        resizeTerminal,
        killTerminal,
        removeTerminal,
        reconcileState,
        checkAvailability,
        setAutoStopInterval,
      })
    })
  )
}

export { ShuruSandboxProvider }
