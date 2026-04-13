import { createServer } from 'node:net'
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
const SHURU_PREVIEW_HOST = '127.0.0.1'

const shuruNotImplemented = (operation: string) =>
  new RpcError({
    message: `Shuru ${operation} lands in a later slice. This iteration supports sandbox create/destroy plus localhost preview URLs.`,
    code: 'SHURU_NOT_IMPLEMENTED',
  })

const buildShuruPreviewUrl = (port: number): string =>
  `http://${SHURU_PREVIEW_HOST}:${String(port)}`

const getEphemeralPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, SHURU_PREVIEW_HOST, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close((error) => {
          reject(error ?? new Error('Unable to determine the allocated port'))
        })
        return
      }

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(address.port)
      })
    })
  })

const allocatePreviewPort = async (
  allocatedPorts: ReadonlySet<number>
): Promise<number> => {
  while (true) {
    const port = await getEphemeralPort()
    if (!allocatedPorts.has(port)) {
      return port
    }
  }
}

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
      const allocatedPreviewPorts = new Set<number>()
      const workspacePreviewPorts = new Map<string, number>()

      const releasePreviewPort = (
        workspaceId: string,
        fallbackPort: number | null
      ) =>
        Effect.sync(() => {
          const allocatedPort =
            workspacePreviewPorts.get(workspaceId) ?? fallbackPort
          workspacePreviewPorts.delete(workspaceId)

          if (allocatedPort !== null) {
            allocatedPreviewPorts.delete(allocatedPort)
          }
        })

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

          const previewPort =
            params.devServerConfig.port === null
              ? null
              : yield* Effect.tryPromise({
                  try: () => allocatePreviewPort(allocatedPreviewPorts),
                  catch: (error) =>
                    new RpcError({
                      message: `Failed to allocate a localhost preview port for workspace "${params.workspaceId}": ${error instanceof Error ? error.message : String(error)}`,
                      code: 'SHURU_START_FAILED',
                    }),
                })

          if (previewPort !== null) {
            yield* Effect.sync(() => {
              allocatedPreviewPorts.add(previewPort)
            })
          }

          const sandbox = yield* shuruClient
            .startSandbox({
              portForward:
                previewPort === null || params.devServerConfig.port === null
                  ? null
                  : {
                      guestPort: params.devServerConfig.port,
                      hostPort: previewPort,
                    },
              workspaceId: params.workspaceId,
              worktreePath: params.worktreePath,
            })
            .pipe(
              Effect.catchAll((error) =>
                releasePreviewPort(params.workspaceId, previewPort).pipe(
                  Effect.andThen(Effect.fail(error))
                )
              )
            )

          if (previewPort !== null) {
            yield* Effect.sync(() => {
              workspacePreviewPorts.set(params.workspaceId, previewPort)
            })
          }

          store.commit(
            events.sandboxStarted({
              workspaceId: params.workspaceId,
              sandboxId: sandbox.sandboxId,
              sandboxPort: previewPort ?? undefined,
              sandboxUrl: previewPort === null ? '' : SHURU_PREVIEW_HOST,
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
            yield* releasePreviewPort(workspaceId, null)
            return
          }

          yield* shuruClient.stopSandbox(workspaceId).pipe(
            Effect.either,
            Effect.tap((result) =>
              result._tag === 'Right'
                ? releasePreviewPort(workspaceId, workspace.value.sandboxPort)
                : Effect.logWarning(
                    `Failed to stop Shuru runtime for workspace "${workspaceId}": ${result.left.message}`
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
        function* (workspaceId: string, _port: number) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspace = pipe(
            allWorkspaces,
            Arr.findFirst((candidate) => candidate.id === workspaceId)
          )

          if (
            workspace._tag === 'None' ||
            workspace.value.sandboxId === null ||
            workspace.value.sandboxPort === null
          ) {
            return yield* new RpcError({
              message: `Cannot get preview URL: workspace "${workspaceId}" has no active Shuru preview`,
              code: 'NOT_FOUND',
            })
          }

          if (workspace.value.sandboxUrl !== SHURU_PREVIEW_HOST) {
            store.commit(
              events.sandboxUrlChanged({
                workspaceId,
                sandboxUrl: SHURU_PREVIEW_HOST,
              })
            )
          }

          return buildShuruPreviewUrl(workspace.value.sandboxPort)
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
