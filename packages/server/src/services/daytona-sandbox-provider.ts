/**
 * DaytonaSandboxProvider — SandboxProvider implementation for Daytona cloud sandboxes
 *
 * Implements the `SandboxProvider` interface using the Daytona SDK (via `DaytonaClient`)
 * to manage cloud sandbox lifecycle, terminal access, preview URLs, and state reconciliation.
 *
 * Fully implemented methods:
 * - `createSandbox` (Issue 13) — core sandbox creation flow
 * - `destroySandbox` (Issue 14) — sandbox teardown with best-effort cleanup
 *
 * Stub methods (to be implemented in downstream issues):
 * - `pauseSandbox` / `resumeSandbox` (Issue 19)
 * - `getPreviewUrl` (Issue 18)
 * - `spawnTerminal` (Issue 16)
 * - `reconcileState` (Issue 20)
 * - `checkAvailability` (Issue 12)
 *
 * ### destroySandbox flow (Issue 14):
 * 1. Looks up the workspace in LiveStore to get the `sandboxId`
 * 2. If no workspace or no `sandboxId`, returns gracefully (idempotent)
 * 3. Calls `DaytonaClient.get(sandboxId)` to fetch the sandbox
 *    - If NOT_FOUND (404): sandbox already gone, treated as success
 *    - Other errors from `.get()` are logged as warnings; we still attempt cleanup
 * 4. Calls `DaytonaClient.delete(sandbox)` to destroy the cloud sandbox
 *    - Errors from `.delete()` are logged as warnings (best-effort, never fails the destroy)
 * 5. Cleans up SSH config entries (hook prepared for Issue 22)
 * 6. Commits `v2.SandboxStopped` event to LiveStore
 */

import { CodeLanguage } from '@daytonaio/sdk'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Array as Arr, Context, Effect, Layer, pipe } from 'effect'

import { DaytonaClient } from './daytona-client.js'
import { LaborerStore } from './laborer-store.js'
import type { CreateSandboxParams } from './sandbox-provider.js'
import { SandboxProvider } from './sandbox-provider.js'

/** Module-level log annotation for structured logging. */
const logPrefix = 'DaytonaSandboxProvider'

/** Default auto-stop interval in minutes (15 minutes of idle). */
const DEFAULT_AUTO_STOP_INTERVAL = 15

/** Default auto-archive interval in minutes (7 days). */
const DEFAULT_AUTO_ARCHIVE_INTERVAL = 7 * 24 * 60

/** Disable auto-delete: let laborer manage sandbox lifecycle. */
const AUTO_DELETE_INTERVAL_DISABLED = -1

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

/**
 * Tag identifying the Daytona-specific `SandboxProvider` implementation.
 *
 * The `layer` on this class builds a `SandboxProvider` value by delegating
 * to `DaytonaClient` and `LaborerStore`.
 */
class DaytonaSandboxProvider extends Context.Tag(
  '@laborer/DaytonaSandboxProvider'
)<DaytonaSandboxProvider, SandboxProvider['Type']>() {
  /**
   * Provide the `SandboxProvider` service using the Daytona cloud backend.
   *
   * Dependencies:
   * - `DaytonaClient` — Daytona SDK operations (create, get, start, stop, delete)
   * - `LaborerStore` — LiveStore access for workspace lookups and event commits
   */
  static readonly layer: Layer.Layer<
    SandboxProvider,
    never,
    DaytonaClient | LaborerStore
  > = Layer.effect(
    SandboxProvider,
    Effect.gen(function* () {
      const daytonaClient = yield* DaytonaClient
      const { store } = yield* LaborerStore

      yield* Effect.logInfo('DaytonaSandboxProvider initialized').pipe(
        Effect.annotateLogs('module', logPrefix)
      )

      // ── createSandbox ─────────────────────────────────────────
      // Core Daytona integration: create a cloud sandbox for a workspace.
      //
      // Steps:
      // 1. Report progress: "creating-sandbox"
      // 2. Determine image from devServer config or use Daytona default
      // 3. Create sandbox via DaytonaClient.create() with labels, auto-stop, resources
      // 4. SDK waits for sandbox to reach "started" state
      // 5. Report progress: "starting-sandbox"
      // 6. Commit v2.SandboxStarted event with sandboxProvider: "daytona"
      // 7. Invoke onReady callback if provided

      const createSandbox = Effect.fn('DaytonaSandboxProvider.createSandbox')(
        function* (params: CreateSandboxParams) {
          const { branchName, devServerConfig, projectName, workspaceId } =
            params

          yield* Effect.logInfo(
            `Creating Daytona sandbox for workspace "${workspaceId}" (project: "${projectName}", branch: "${branchName}")`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // Step 1: Report progress — creating sandbox
          store.commit(
            events.sandboxSetupStepChanged({
              workspaceId,
              step: 'creating-sandbox',
            })
          )

          // Step 2: Determine image
          // Use devServer.image if set, otherwise pass no image to use
          // the Daytona default image (which includes Node 22, bun, git,
          // Claude Code, OpenCode, Codex).
          const image = devServerConfig.image

          // Step 3: Build common create params
          const baseParams = {
            language: CodeLanguage.TYPESCRIPT,
            labels: {
              'laborer-workspace-id': workspaceId,
              'laborer-project': projectName,
              'laborer-branch': branchName,
            },
            envVars: {} as Record<string, string>,
            autoStopInterval: DEFAULT_AUTO_STOP_INTERVAL,
            autoArchiveInterval: DEFAULT_AUTO_ARCHIVE_INTERVAL,
            autoDeleteInterval: AUTO_DELETE_INTERVAL_DISABLED,
          }

          // Step 4: Create the sandbox via the Daytona SDK.
          // When an image is specified, use CreateSandboxFromImageParams.
          // Otherwise, use CreateSandboxFromSnapshotParams (no snapshot = Daytona default).
          // The SDK handles waiting for the sandbox to reach "started" state.
          const sandbox =
            image !== null
              ? yield* daytonaClient.create({ ...baseParams, image })
              : yield* daytonaClient.createFromSnapshot(baseParams)

          yield* Effect.logInfo(
            `Daytona sandbox created: id="${sandbox.id}", state="${String(sandbox.state)}"`
          ).pipe(
            Effect.annotateLogs('module', logPrefix),
            Effect.annotateLogs('sandboxId', sandbox.id)
          )

          // Step 5: Report progress — sandbox started
          store.commit(
            events.sandboxSetupStepChanged({
              workspaceId,
              step: 'starting-sandbox',
            })
          )

          // Step 6: Determine the preview URL base
          // Daytona preview URLs follow the pattern:
          // https://{port}-{sandboxId}.preview.daytona.io
          // We store the sandbox ID as the URL base; the port is appended
          // when getPreviewUrl is called.
          const sandboxUrl = sandbox.id

          // Step 7: Commit v2.SandboxStarted event
          const sandboxImage = image !== null ? image : 'daytona-default'
          store.commit(
            events.sandboxStarted({
              workspaceId,
              sandboxId: sandbox.id,
              sandboxUrl,
              sandboxImage,
              ...(devServerConfig.port != null
                ? { sandboxPort: devServerConfig.port }
                : {}),
              sandboxProvider: 'daytona',
            })
          )

          yield* Effect.logInfo(
            `v2.SandboxStarted committed for workspace "${workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // Step 8: Invoke onReady callback if provided
          if (params.onReady !== undefined) {
            yield* params.onReady(workspaceId)
          }

          yield* Effect.logInfo(
            `Daytona sandbox setup complete for workspace "${workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      // ── destroySandbox ────────────────────────────────────────
      // Issue 14: Full implementation.
      //
      // Best-effort sandbox teardown:
      // 1. Look up workspace → get sandboxId (early return if missing)
      // 2. Fetch sandbox from Daytona API
      //    - NOT_FOUND → already gone, skip delete
      //    - Other fetch errors → log warning, skip delete
      // 3. Delete the sandbox (errors logged, never propagated)
      // 4. SSH config cleanup hook (Issue 22)
      // 5. Commit v2.SandboxStopped event

      const destroySandbox = Effect.fn('DaytonaSandboxProvider.destroySandbox')(
        function* (workspaceId: string) {
          // Step 1: Look up workspace to get the sandboxId
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            yield* Effect.logDebug(
              `Workspace "${workspaceId}" not found in LiveStore, skipping Daytona sandbox destroy`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            return
          }

          const workspace = workspaceOpt.value

          if (workspace.sandboxId === null) {
            yield* Effect.logDebug(
              `Workspace "${workspaceId}" has no sandboxId, skipping Daytona sandbox destroy`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            return
          }

          const sandboxId = workspace.sandboxId

          // Step 2: Fetch the sandbox from Daytona, distinguishing
          // "not found" (already destroyed) from other errors.
          const sandbox = yield* daytonaClient.get(sandboxId).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                if (error.code === 'DAYTONA_NOT_FOUND') {
                  yield* Effect.logDebug(
                    `Daytona sandbox "${sandboxId}" not found (already destroyed)`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                } else {
                  yield* Effect.logWarning(
                    `Failed to fetch Daytona sandbox "${sandboxId}" for deletion: ${error.message} (code: ${error.code})`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                }
                return null
              })
            )
          )

          // Step 3: Delete the sandbox if we fetched it successfully
          if (sandbox !== null) {
            yield* daytonaClient
              .delete(sandbox)
              .pipe(
                Effect.catchAll((error) =>
                  Effect.logWarning(
                    `Failed to delete Daytona sandbox "${sandboxId}": ${error.message} (code: ${error.code})`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                )
              )

            yield* Effect.logInfo(
              `Daytona sandbox "${sandboxId}" deleted successfully`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          }

          // Step 4: SSH config cleanup (Issue 22 will implement the actual cleanup)
          // TODO(Issue 22): Remove ~/.ssh/config entry for laborer-{workspaceId}

          // Step 5: Commit v2.SandboxStopped event regardless of deletion outcome.
          // The sandbox is gone from our perspective — either successfully deleted,
          // already destroyed, or unreachable. In all cases, we update LiveStore.
          store.commit(events.sandboxStopped({ workspaceId }))

          yield* Effect.logInfo(
            `Daytona sandbox destroy complete for workspace "${workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      // ── pauseSandbox ──────────────────────────────────────────
      // Stub: will be fully implemented in Issue 19.

      const pauseSandbox = Effect.fn('DaytonaSandboxProvider.pauseSandbox')(
        function* (workspaceId: string) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (
            workspaceOpt._tag === 'None' ||
            workspaceOpt.value.sandboxId === null
          ) {
            return yield* new RpcError({
              message: `Cannot pause: workspace "${workspaceId}" has no active Daytona sandbox`,
              code: 'NOT_FOUND',
            })
          }

          const sandbox = yield* daytonaClient.get(workspaceOpt.value.sandboxId)
          yield* daytonaClient.stop(sandbox)

          store.commit(events.sandboxPaused({ workspaceId }))

          yield* Effect.logInfo(
            `Daytona sandbox paused for workspace "${workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      // ── resumeSandbox ─────────────────────────────────────────
      // Stub: will be fully implemented in Issue 19.

      const resumeSandbox = Effect.fn('DaytonaSandboxProvider.resumeSandbox')(
        function* (workspaceId: string) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (
            workspaceOpt._tag === 'None' ||
            workspaceOpt.value.sandboxId === null
          ) {
            return yield* new RpcError({
              message: `Cannot resume: workspace "${workspaceId}" has no active Daytona sandbox`,
              code: 'NOT_FOUND',
            })
          }

          const sandbox = yield* daytonaClient.get(workspaceOpt.value.sandboxId)
          yield* daytonaClient.start(sandbox)

          store.commit(events.sandboxResumed({ workspaceId }))

          yield* Effect.logInfo(
            `Daytona sandbox resumed for workspace "${workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      // ── getPreviewUrl ─────────────────────────────────────────
      // Stub: will be fully implemented in Issue 18.

      const getPreviewUrl = Effect.fn('DaytonaSandboxProvider.getPreviewUrl')(
        function* (workspaceId: string, port: number) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (
            workspaceOpt._tag === 'None' ||
            workspaceOpt.value.sandboxId === null
          ) {
            return yield* new RpcError({
              message: `Cannot get preview URL: workspace "${workspaceId}" has no active Daytona sandbox`,
              code: 'NOT_FOUND',
            })
          }

          const sandbox = yield* daytonaClient.get(workspaceOpt.value.sandboxId)

          const previewLink = yield* Effect.tryPromise({
            try: () => sandbox.getPreviewLink(port),
            catch: (error) =>
              new RpcError({
                message: `Failed to get preview link for port ${port}: ${error instanceof Error ? error.message : String(error)}`,
                code: 'DAYTONA_ERROR',
              }),
          })

          return previewLink.url
        }
      )

      // ── spawnTerminal ─────────────────────────────────────────
      // Stub: will be implemented in Issue 16.

      const spawnTerminal = Effect.fn('DaytonaSandboxProvider.spawnTerminal')(
        function* (workspaceId: string, _opts?) {
          return yield* new RpcError({
            message: `Daytona terminal spawning not yet implemented (workspace: "${workspaceId}"). See Issue 16.`,
            code: 'NOT_IMPLEMENTED',
          })
        }
      )

      // ── reconcileState ────────────────────────────────────────
      // Stub: will be implemented in Issue 20.

      const reconcileState = Effect.fn('DaytonaSandboxProvider.reconcileState')(
        function* () {
          yield* Effect.logDebug(
            'Daytona state reconciliation not yet implemented. See Issue 20.'
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      // ── checkAvailability ─────────────────────────────────────
      // Stub: will be fully implemented in Issue 12.
      // For now, perform a basic check: verify API key is set and
      // attempt a lightweight SDK call.

      const checkAvailability = Effect.fn(
        'DaytonaSandboxProvider.checkAvailability'
      )(function* () {
        // Try listing sandboxes with limit=1 as a connectivity check
        const result = yield* daytonaClient.list(undefined, undefined, 1).pipe(
          Effect.map(() => ({
            available: true as const,
          })),
          Effect.catchAll((error) =>
            Effect.succeed({
              available: false as const,
              error: error.message,
            })
          )
        )

        return result
      })

      // ── Return the SandboxProvider implementation ─────────────

      return SandboxProvider.of({
        createSandbox,
        destroySandbox,
        pauseSandbox,
        resumeSandbox,
        getPreviewUrl,
        spawnTerminal,
        reconcileState,
        checkAvailability,
      })
    })
  )
}

export { DaytonaSandboxProvider }
