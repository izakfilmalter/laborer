/**
 * DaytonaSandboxProvider — SandboxProvider implementation for Daytona cloud sandboxes
 *
 * Implements the `SandboxProvider` interface using the Daytona SDK (via `DaytonaClient`)
 * to manage cloud sandbox lifecycle, terminal access, preview URLs, and state reconciliation.
 *
 * Fully implemented methods:
 * - `createSandbox` (Issues 13, 21) — core sandbox creation flow with snapshot caching
 * - `destroySandbox` (Issue 14) — sandbox teardown with best-effort cleanup
 * - `pauseSandbox` / `resumeSandbox` (Issue 19) — idempotent stop/start with auto-stop config
 * - Git sync: push worktree HEAD to sandbox via SSH (Issue 15)
 * - `spawnTerminal` (Issue 16) — WebSocket PTY session creation via Daytona SDK
 *
 * - `reconcileState` (Issue 20) — polling loop that syncs LiveStore with
 *   actual Daytona sandbox states every 30 seconds, forked as a daemon fiber
 *
 * - `checkAvailability` (Issue 12) — verifies API connectivity with result caching
 *
 * - `getPreviewUrl` (Issue 18) — resolves Daytona preview URLs via SDK and
 *   persists them to LiveStore for UI display
 *
 * ### spawnTerminal flow (Issue 16):
 * 1. Look up workspace in LiveStore to get the `sandboxId`
 * 2. Fetch the Daytona sandbox via `DaytonaClient.get(sandboxId)`
 * 3. Create a PTY session via `sandbox.process.createPty()` with:
 *    - Unique session ID (crypto.randomUUID())
 *    - Terminal dimensions from opts (cols/rows, defaults 80x24)
 *    - Working directory: /home/daytona/project
 *    - Environment: TERM=xterm-256color, COLORTERM=truecolor
 *    - `onData` callback for terminal output (stored for Issue 17 bridge)
 * 4. Wait for the WebSocket connection to be established
 * 5. If a command is specified, send it as input to the PTY
 * 6. Store the PtyHandle in an in-memory map keyed by terminal ID
 *    (accessible via `getDaytonaPtyHandle` for Issue 17 bridge)
 * 7. Return a TerminalHandle with metadata
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
 *
 * ### pauseSandbox flow (Issue 19):
 * 1. Looks up workspace → get sandboxId (error if missing)
 * 2. Fetches sandbox from Daytona API to check current state
 * 3. Idempotent: if sandbox is already stopped/archived, commits SandboxPaused and returns
 * 4. Calls `DaytonaClient.stop(sandbox)` to stop the cloud sandbox
 * 5. SSH config cleanup hook (Issue 22)
 * 6. Commits `v2.SandboxPaused` event to LiveStore
 *
 * ### pushCodeToSandbox flow (Issue 15):
 * 1. Get SSH access: `sandbox.createSshAccess(10)` — 10-minute token
 * 2. Init git repo in sandbox: `sandbox.process.executeCommand('git init ...')`
 * 3. Add temporary local git remote: `git remote add sandbox-{wid} ssh://{token}@ssh.app.daytona.io/...`
 * 4. Push worktree HEAD: `git push sandbox-{wid} HEAD:main --force`
 * 5. Checkout pushed code in sandbox: `sandbox.process.executeCommand('git checkout -f main')`
 * 6. Clean up local remote: `git remote remove sandbox-{wid}`
 *
 * ### resumeSandbox flow (Issue 19):
 * 1. Looks up workspace → get sandboxId (error if missing)
 * 2. Fetches sandbox from Daytona API to check current state
 * 3. Idempotent: if sandbox is already started, commits SandboxResumed and returns
 * 4. Calls `DaytonaClient.start(sandbox)` to start the cloud sandbox
 * 5. SSH config setup hook (Issue 22)
 * 6. Commits `v2.SandboxResumed` event to LiveStore
 */

import { CodeLanguage, Image, type PtyHandle } from '@daytonaio/sdk'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  pipe,
  Ref,
} from 'effect'

import {
  buildAddRemoteArgs,
  buildPushArgs,
  buildRemoteName,
  buildRemoveRemoteArgs,
  buildSandboxCheckoutCommand,
  buildSandboxInitCommand,
  buildSshGitEnv,
  buildSshRemoteUrl,
} from '../lib/git-sync.js'
import { buildCacheHash, buildSnapshotName } from '../lib/snapshot-cache.js'
import { spawnGit } from '../lib/spawn-git.js'
import type { DaytonaSandbox } from './daytona-client.js'
import { DaytonaClient } from './daytona-client.js'
import { DAYTONA_TERMINAL_ID_PREFIX } from './daytona-terminal-data-channel.js'
import { detectLockfile } from './deps-image-service.js'
import { LaborerStore } from './laborer-store.js'
import { DAYTONA_RECONCILE_POLL_INTERVAL_MS } from './polling-intervals.js'
import type {
  CreateSandboxParams,
  ProviderStatus,
  SandboxProvider,
} from './sandbox-provider.js'

/** Module-level log annotation for structured logging. */
const logPrefix = 'DaytonaSandboxProvider'

/** Default working directory inside Daytona sandboxes. */
const DAYTONA_PROJECT_DIR = '/home/daytona/project'

// ---------------------------------------------------------------------------
// In-memory PTY handle registry
// ---------------------------------------------------------------------------

/**
 * Map of terminal session ID → Daytona `PtyHandle`.
 *
 * `spawnTerminal` stores handles here after creating a PTY session.
 * The xterm.js bridge (Issue 17) retrieves handles via
 * `getDaytonaPtyHandle(sessionId)` to pipe data between the WebSocket
 * PTY and the terminal component.
 *
 * Handles are removed when the PTY exits or is explicitly killed.
 */
const daytonaPtyHandles = new Map<string, PtyHandle>()

/**
 * Retrieve a live Daytona `PtyHandle` by terminal session ID.
 *
 * Used by the terminal bridge (Issue 17) to wire xterm.js input/output
 * to the Daytona WebSocket PTY session.
 *
 * @returns The `PtyHandle` if the session is active, or `undefined` if
 *          the session has ended or was never created.
 */
const getDaytonaPtyHandle = (sessionId: string): PtyHandle | undefined =>
  daytonaPtyHandles.get(sessionId)

/**
 * Remove a Daytona `PtyHandle` from the in-memory registry.
 * Called when a PTY session exits or is explicitly killed.
 */
const removeDaytonaPtyHandle = (sessionId: string): void => {
  daytonaPtyHandles.delete(sessionId)
}

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
    DaytonaSandboxProvider,
    never,
    DaytonaClient | LaborerStore
  > = Layer.scoped(
    DaytonaSandboxProvider,
    Effect.gen(function* () {
      const daytonaClient = yield* DaytonaClient
      const { store } = yield* LaborerStore

      // Cached availability check result — checked once, cached for the session.
      const cachedAvailability = yield* Ref.make<ProviderStatus | null>(null)

      yield* Effect.logInfo('DaytonaSandboxProvider initialized').pipe(
        Effect.annotateLogs('module', logPrefix)
      )

      // ── pushCodeToSandbox ─────────────────────────────────────
      // Issue 15: Push the local worktree HEAD to the Daytona sandbox via SSH.
      //
      // Steps:
      // 1. Report progress: "pushing-code"
      // 2. Get SSH access token from Daytona API (10-minute expiry)
      // 3. Initialize a bare git repo inside the sandbox
      // 4. Add a temporary git remote pointing at the sandbox via SSH
      // 5. Push HEAD to the sandbox: `git push sandbox-{wid} HEAD:main --force`
      // 6. Checkout the pushed code in the sandbox working tree
      // 7. Clean up the temporary local git remote (always, even on failure)

      const pushCodeToSandbox = Effect.fn(
        'DaytonaSandboxProvider.pushCodeToSandbox'
      )(function* (
        sandbox: DaytonaSandbox,
        workspaceId: string,
        worktreePath: string
      ) {
        // Step 1: Report progress
        store.commit(
          events.sandboxSetupStepChanged({
            workspaceId,
            step: 'pushing-code',
          })
        )

        yield* Effect.logInfo(
          `Pushing worktree code to Daytona sandbox "${sandbox.id}" for workspace "${workspaceId}"`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        // Step 2: Get SSH access token
        const sshAccess = yield* Effect.tryPromise({
          try: () => sandbox.createSshAccess(10),
          catch: (error) =>
            new RpcError({
              message: `Failed to create SSH access for sandbox "${sandbox.id}": ${error instanceof Error ? error.message : String(error)}`,
              code: 'DAYTONA_ERROR',
            }),
        })

        yield* Effect.logDebug(
          `SSH access created for sandbox "${sandbox.id}": token expires at ${String(sshAccess.expiresAt)}`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        // Step 3: Initialize git repo in sandbox (idempotent — safe to re-run)
        yield* Effect.tryPromise({
          try: () => sandbox.process.executeCommand(buildSandboxInitCommand()),
          catch: (error) =>
            new RpcError({
              message: `Failed to initialize git repo in sandbox "${sandbox.id}": ${error instanceof Error ? error.message : String(error)}`,
              code: 'DAYTONA_ERROR',
            }),
        })

        // Step 4: Add temporary local git remote
        const remoteName = buildRemoteName(workspaceId)
        const remoteUrl = buildSshRemoteUrl(sshAccess.token)
        const sshEnv = buildSshGitEnv()

        const addResult = yield* Effect.tryPromise({
          try: () =>
            spawnGit(buildAddRemoteArgs(remoteName, remoteUrl), {
              cwd: worktreePath,
            }),
          catch: (error) =>
            new RpcError({
              message: `Failed to add git remote "${remoteName}": ${error instanceof Error ? error.message : String(error)}`,
              code: 'GIT_ERROR',
            }),
        })

        if (addResult.exitCode !== 0) {
          // Remote might already exist from a previous failed attempt — try removing and re-adding
          yield* Effect.tryPromise({
            try: () =>
              spawnGit(buildRemoveRemoteArgs(remoteName), {
                cwd: worktreePath,
              }),
            catch: () => undefined as never, // Ignore remove errors
          }).pipe(Effect.ignore)

          const retryResult = yield* Effect.tryPromise({
            try: () =>
              spawnGit(buildAddRemoteArgs(remoteName, remoteUrl), {
                cwd: worktreePath,
              }),
            catch: (error) =>
              new RpcError({
                message: `Failed to add git remote "${remoteName}" (retry): ${error instanceof Error ? error.message : String(error)}`,
                code: 'GIT_ERROR',
              }),
          })

          if (retryResult.exitCode !== 0) {
            return yield* new RpcError({
              message: `git remote add failed: ${retryResult.stderr}`,
              code: 'GIT_ERROR',
            })
          }
        }

        // Step 5: Push HEAD to the sandbox remote
        // Use Effect.ensuring to guarantee remote cleanup even if push fails
        yield* Effect.tryPromise({
          try: () =>
            spawnGit(buildPushArgs(remoteName), {
              cwd: worktreePath,
              env: sshEnv,
              timeoutMs: 120_000, // 2 minutes for large repos
            }),
          catch: (error) =>
            new RpcError({
              message: `Failed to push to sandbox: ${error instanceof Error ? error.message : String(error)}`,
              code: 'GIT_ERROR',
            }),
        }).pipe(
          Effect.flatMap((pushResult) => {
            if (pushResult.exitCode !== 0) {
              return new RpcError({
                message: `git push failed (exit ${String(pushResult.exitCode)}): ${pushResult.stderr}`,
                code: 'GIT_ERROR',
              })
            }
            return Effect.logDebug(
              `Code pushed to sandbox "${sandbox.id}" successfully`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          }),
          // Step 7: Always clean up the local remote, even on push failure
          Effect.ensuring(
            Effect.tryPromise({
              try: () =>
                spawnGit(buildRemoveRemoteArgs(remoteName), {
                  cwd: worktreePath,
                }),
              catch: () => undefined as never, // Ignore cleanup errors
            }).pipe(Effect.ignore)
          )
        )

        // Step 6: Checkout the pushed code in the sandbox
        yield* Effect.tryPromise({
          try: () =>
            sandbox.process.executeCommand(buildSandboxCheckoutCommand()),
          catch: (error) =>
            new RpcError({
              message: `Failed to checkout code in sandbox "${sandbox.id}": ${error instanceof Error ? error.message : String(error)}`,
              code: 'DAYTONA_ERROR',
            }),
        })

        yield* Effect.logInfo(
          `Worktree code pushed and checked out in sandbox "${sandbox.id}" for workspace "${workspaceId}"`
        ).pipe(Effect.annotateLogs('module', logPrefix))
      })

      // ── resolveSnapshot ───────────────────────────────────────
      // Issue 21: Detect lockfile in the worktree, check for an existing
      // cached snapshot, or build a new one.
      //
      // Returns a snapshot name if a cached snapshot is available (or was
      // just built), or null if no snapshot caching applies.

      const resolveSnapshot = Effect.fn(
        'DaytonaSandboxProvider.resolveSnapshot'
      )(function* (
        worktreePath: string,
        projectName: string,
        workspaceId: string,
        image: string | null,
        installCommand: string | null
      ) {
        // Step 1: Detect lockfile in the worktree
        const lockfile = detectLockfile(worktreePath)
        if (lockfile === null) {
          yield* Effect.logDebug(
            `No lockfile found in "${worktreePath}", skipping snapshot caching`
          ).pipe(Effect.annotateLogs('module', logPrefix))
          return null
        }

        // Step 2: Determine the install command.
        // Use the explicit installCommand from config if set, otherwise
        // fall back to the auto-detected command from the lockfile.
        const effectiveInstallCommand =
          installCommand ?? lockfile.installCommand

        yield* Effect.logInfo(
          `Lockfile detected: ${lockfile.type} (hash: ${lockfile.hash}), install command: "${effectiveInstallCommand}"`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        // Step 3: Compute cache hash and snapshot name
        const cacheHash = buildCacheHash(lockfile.hash, image ?? undefined)
        const snapshotName = buildSnapshotName(projectName, cacheHash)

        yield* Effect.logDebug(`Snapshot cache key: "${snapshotName}"`).pipe(
          Effect.annotateLogs('module', logPrefix)
        )

        // Step 4: Check if the snapshot already exists
        const existingSnapshot = yield* Effect.tryPromise({
          try: () => daytonaClient.snapshot.get(snapshotName),
          catch: () => null,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)))

        if (existingSnapshot !== null) {
          yield* Effect.logInfo(
            `Snapshot cache hit: "${snapshotName}" (state: ${String(existingSnapshot.state)})`
          ).pipe(Effect.annotateLogs('module', logPrefix))
          return snapshotName
        }

        // Step 5: Cache miss — build a new snapshot
        yield* Effect.logInfo(
          `Snapshot cache miss: building "${snapshotName}"`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        store.commit(
          events.sandboxSetupStepChanged({
            workspaceId,
            step: 'building-snapshot',
          })
        )

        // Build an Image definition with the install command.
        // When an explicit base image is configured, use it.
        // Otherwise, use the default Daytona image as the base.
        const baseImage =
          image !== null
            ? Image.base(image)
            : Image.base('daytonaio/sdk:latest')
        const snapshotImage = baseImage.runCommands(effectiveInstallCommand)

        yield* Effect.tryPromise({
          try: () =>
            daytonaClient.snapshot.create(
              { name: snapshotName, image: snapshotImage },
              {
                onLogs: (chunk) => {
                  // Stream build logs to the UI via setup step events
                  store.commit(
                    events.sandboxSetupStepChanged({
                      workspaceId,
                      step: chunk,
                    })
                  )
                },
              }
            ),
          catch: (error) =>
            new RpcError({
              message: `Failed to build snapshot "${snapshotName}": ${error instanceof Error ? error.message : String(error)}`,
              code: 'DAYTONA_ERROR',
            }),
        })

        yield* Effect.logInfo(
          `Snapshot built successfully: "${snapshotName}"`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        return snapshotName
      })

      // ── createSandbox ─────────────────────────────────────────
      // Core Daytona integration: create a cloud sandbox for a workspace.
      //
      // Steps:
      // 1. Report progress: "creating-sandbox"
      // 2. Determine image from devServer config or use Daytona default
      // 2b. Issue 21: Detect lockfile, check for cached snapshot
      // 3. Create sandbox via DaytonaClient (from snapshot if cached, else from image)
      // 4. SDK waits for sandbox to reach "started" state
      // 5. Report progress: "starting-sandbox"
      // 6. Commit v2.SandboxStarted event with sandboxProvider: "daytona"
      // 7. Push worktree code to sandbox via SSH (Issue 15)
      // 8. Invoke onReady callback if provided

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
          const image = devServerConfig.image

          // Step 2b (Issue 21): Attempt snapshot caching.
          // If a lockfile is found and an install command is available,
          // check for a cached snapshot. If found, create from snapshot.
          // If not, build a snapshot for future use.
          const snapshotName = yield* resolveSnapshot(
            params.worktreePath,
            projectName,
            workspaceId,
            image,
            devServerConfig.installCommand
          ).pipe(
            Effect.catchAll((error) => {
              // Snapshot caching is best-effort. If it fails (e.g., API error
              // building the snapshot), fall back to creating without a snapshot.
              return Effect.gen(function* () {
                yield* Effect.logWarning(
                  `Snapshot caching failed, falling back to image-based creation: ${error instanceof RpcError ? error.message : String(error)}`
                ).pipe(Effect.annotateLogs('module', logPrefix))
                return null
              })
            })
          )

          // Restore the "creating-sandbox" step after potential snapshot build steps
          store.commit(
            events.sandboxSetupStepChanged({
              workspaceId,
              step: 'creating-sandbox',
            })
          )

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
          // Priority: cached snapshot > image > default Daytona image.
          let sandbox: DaytonaSandbox
          if (snapshotName !== null) {
            // Create from cached (or freshly built) snapshot
            sandbox = yield* daytonaClient.createFromSnapshot({
              ...baseParams,
              snapshot: snapshotName,
            })
          } else if (image !== null) {
            // Create from explicit image (no snapshot caching)
            sandbox = yield* daytonaClient.create({ ...baseParams, image })
          } else {
            // Use Daytona default image (no image, no snapshot)
            sandbox = yield* daytonaClient.createFromSnapshot(baseParams)
          }

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

          // Step 6: Determine the preview URL.
          let sandboxUrl: string = sandbox.id
          const configPort = devServerConfig.port
          if (configPort != null) {
            const previewLink = yield* Effect.tryPromise({
              try: () => sandbox.getPreviewLink(configPort),
              catch: (error) =>
                new RpcError({
                  message: `Failed to get preview link for port ${configPort}: ${error instanceof Error ? error.message : String(error)}`,
                  code: 'DAYTONA_ERROR',
                }),
            })
            sandboxUrl = previewLink.url
          }

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

          // Step 8: Push worktree code to sandbox via SSH (Issue 15)
          yield* pushCodeToSandbox(sandbox, workspaceId, params.worktreePath)

          // Step 9: Clear setup step progress (setup complete)
          store.commit(
            events.sandboxSetupStepChanged({
              workspaceId,
              step: null,
            })
          )

          // Step 10: Invoke onReady callback if provided
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
      // Issue 19: Full implementation with idempotency.
      //
      // Maps to Daytona `sandbox.stop()`. Idempotent: pausing an
      // already-stopped or archived sandbox skips the SDK call and
      // still commits `v2.SandboxPaused` to sync LiveStore state.

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

          const sandboxId = workspaceOpt.value.sandboxId
          const sandbox = yield* daytonaClient.get(sandboxId)

          // Idempotent: if sandbox is already stopped or archived, skip the stop call.
          // Daytona states: started, stopped, archived, stopping, starting, etc.
          const state = String(sandbox.state)
          if (state === 'stopped' || state === 'archived') {
            yield* Effect.logDebug(
              `Daytona sandbox "${sandboxId}" already in state "${state}", skipping stop call`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          } else {
            yield* daytonaClient.stop(sandbox)
          }

          // TODO(Issue 22): Remove ~/.ssh/config entry for laborer-{workspaceId}

          store.commit(events.sandboxPaused({ workspaceId }))

          yield* Effect.logInfo(
            `Daytona sandbox paused for workspace "${workspaceId}" (sandbox: "${sandboxId}")`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      // ── resumeSandbox ─────────────────────────────────────────
      // Issue 19: Full implementation with idempotency.
      //
      // Maps to Daytona `sandbox.start()`. Idempotent: resuming an
      // already-started sandbox skips the SDK call and still commits
      // `v2.SandboxResumed` to sync LiveStore state.

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

          const sandboxId = workspaceOpt.value.sandboxId
          const sandbox = yield* daytonaClient.get(sandboxId)

          // Idempotent: if sandbox is already started, skip the start call.
          const state = String(sandbox.state)
          if (state === 'started') {
            yield* Effect.logDebug(
              `Daytona sandbox "${sandboxId}" already in state "started", skipping start call`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          } else {
            yield* daytonaClient.start(sandbox)
          }

          // TODO(Issue 22): Write/update ~/.ssh/config entry for laborer-{workspaceId}

          store.commit(events.sandboxResumed({ workspaceId }))

          yield* Effect.logInfo(
            `Daytona sandbox resumed for workspace "${workspaceId}" (sandbox: "${sandboxId}")`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      // ── getPreviewUrl ─────────────────────────────────────────
      // Issue 18: Returns the Daytona preview URL for a given port.
      // Calls sandbox.getPreviewLink(port) via the SDK and returns the URL.
      // Also updates sandboxUrl in LiveStore so the UI always has the
      // current preview URL.

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

          const url = previewLink.url

          // Persist the resolved preview URL to LiveStore so the UI
          // always displays the correct Daytona preview URL.
          store.commit(
            events.sandboxUrlChanged({ workspaceId, sandboxUrl: url })
          )

          return url
        }
      )

      // ── spawnTerminal ─────────────────────────────────────────
      // Issue 16: Create a Daytona PTY session over WebSocket.
      //
      // Steps:
      // 1. Look up workspace → get sandboxId (error if missing)
      // 2. Fetch sandbox from Daytona API
      // 3. Create a PTY session via sandbox.process.createPty()
      //    - Generates a unique session ID
      //    - Uses configured cols/rows (defaults: 80×24)
      //    - Sets working directory to /home/daytona/project
      //    - Configures TERM/COLORTERM env vars for color support
      //    - Registers an onData callback (stored for Issue 17 bridge)
      // 4. Wait for the WebSocket connection to be established
      // 5. Send initial command as input if opts.command is specified
      // 6. Store the PtyHandle in the in-memory registry
      // 7. Return a TerminalHandle with session metadata

      const spawnTerminal = Effect.fn('DaytonaSandboxProvider.spawnTerminal')(
        function* (workspaceId: string, opts?) {
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
              message: `Cannot spawn terminal: workspace "${workspaceId}" has no active Daytona sandbox`,
              code: 'NOT_FOUND',
            })
          }

          const sandboxId = workspaceOpt.value.sandboxId
          const sandbox = yield* daytonaClient.get(sandboxId)

          // Generate a unique session ID for this PTY.
          // The raw session ID is used with the Daytona SDK and as the
          // key in the PtyHandle registry. The prefixed ID (with `daytona:`)
          // is returned to the caller and used by the Electron main process
          // to route data ports to the server process instead of the
          // terminal utility process.
          const rawSessionId = crypto.randomUUID()
          const sessionId = `${DAYTONA_TERMINAL_ID_PREFIX}${rawSessionId}`
          const cols = opts?.cols ?? 80
          const rows = opts?.rows ?? 24
          const command = opts?.command ?? '/bin/sh'

          yield* Effect.logInfo(
            `Spawning Daytona PTY session "${sessionId}" in sandbox "${sandboxId}" for workspace "${workspaceId}" (${String(cols)}×${String(rows)})`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // Create the PTY session via the Daytona SDK.
          // The SDK opens a WebSocket to the sandbox's toolbox proxy
          // and returns a PtyHandle for sending input / receiving output.
          // Use the raw session ID (without prefix) as the SDK session ID.
          const ptyHandle = yield* Effect.tryPromise({
            try: () =>
              sandbox.process.createPty({
                id: rawSessionId,
                cols,
                rows,
                cwd: DAYTONA_PROJECT_DIR,
                envs: {
                  TERM: 'xterm-256color',
                  COLORTERM: 'truecolor',
                },
                onData: (_data: Uint8Array) => {
                  // Output data is received here from the WebSocket PTY.
                  // The xterm.js bridge (Issue 17) will read from the
                  // PtyHandle directly via getDaytonaPtyHandle(). This
                  // callback is required by the SDK but the actual
                  // piping to xterm happens in the bridge layer.
                },
              }),
            catch: (error) =>
              new RpcError({
                message: `Failed to create PTY session in sandbox "${sandboxId}": ${error instanceof Error ? error.message : String(error)}`,
                code: 'DAYTONA_ERROR',
              }),
          })

          // Wait for the WebSocket connection to be fully established
          // before returning the handle. This ensures the PTY is ready
          // to accept input immediately.
          yield* Effect.tryPromise({
            try: () => ptyHandle.waitForConnection(),
            catch: (error) =>
              new RpcError({
                message: `PTY connection failed for sandbox "${sandboxId}": ${error instanceof Error ? error.message : String(error)}`,
                code: 'DAYTONA_ERROR',
              }),
          })

          // Store the PtyHandle in the in-memory registry keyed by raw
          // session ID (without prefix). The bridge layer (Issue 17) strips
          // the `daytona:` prefix before looking up the handle.
          daytonaPtyHandles.set(rawSessionId, ptyHandle)

          yield* Effect.logInfo(
            `Daytona PTY session "${sessionId}" connected (sandbox: "${sandboxId}")`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // If a command was specified, send it as initial input.
          // This mirrors the Docker terminal flow where a command
          // can be auto-typed into the terminal on spawn.
          if (opts?.command !== undefined) {
            yield* Effect.tryPromise({
              try: () => ptyHandle.sendInput(`${opts.command}\n`),
              catch: (error) =>
                new RpcError({
                  message: `Failed to send initial command to PTY "${sessionId}": ${error instanceof Error ? error.message : String(error)}`,
                  code: 'DAYTONA_ERROR',
                }),
            })
          }

          return {
            id: sessionId,
            workspaceId,
            command,
            status: 'running' as const,
          }
        }
      )

      // ── reconcileState ────────────────────────────────────────
      // Issue 20: Full implementation.
      //
      // Polls the Daytona API every 30 seconds to detect sandbox state
      // drift (e.g. auto-stop after idle, external destroy, archive).
      //
      // On each tick:
      // 1. Query LiveStore for all workspaces with sandboxProvider=daytona
      //    and a non-null sandboxId
      // 2. For each, call DaytonaClient.get(sandboxId) to check actual state
      // 3. Compare actual vs LiveStore state; commit events for mismatches:
      //    - Daytona stopped + LS running → SandboxPaused
      //    - Daytona started + LS paused  → SandboxResumed
      //    - Daytona not found/destroyed  → SandboxStopped
      //    - Daytona archived + LS any    → SandboxPaused
      // 4. Errors on individual sandbox checks are logged and skipped.
      //
      // The loop is forked as a daemon fiber in the Layer.scoped setup.

      /**
       * Reconcile a single workspace's LiveStore state with the actual
       * Daytona sandbox state. Returns void; errors are caught and logged.
       */
      const reconcileOneWorkspace = Effect.fn(
        'DaytonaSandboxProvider.reconcileOneWorkspace'
      )(function* (workspace: {
        readonly id: string
        readonly sandboxId: string
        readonly sandboxStatus: string | null
      }) {
        const {
          id: workspaceId,
          sandboxId,
          sandboxStatus: lsStatus,
        } = workspace

        const sandbox = yield* daytonaClient.get(sandboxId).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              if (error.code === 'DAYTONA_NOT_FOUND') {
                // Sandbox destroyed externally — sync LiveStore
                if (lsStatus !== null) {
                  yield* Effect.logInfo(
                    `Reconcile: Daytona sandbox "${sandboxId}" not found (destroyed externally), syncing LiveStore`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                  store.commit(events.sandboxStopped({ workspaceId }))
                }
              } else {
                yield* Effect.logWarning(
                  `Reconcile: failed to fetch Daytona sandbox "${sandboxId}": ${error.message} (code: ${error.code})`
                ).pipe(Effect.annotateLogs('module', logPrefix))
              }
              return null
            })
          )
        )

        if (sandbox === null) {
          return
        }

        const daytonaState = String(sandbox.state)

        // Map Daytona states to our LiveStore states:
        // - 'started' / 'running' → 'running'
        // - 'stopped' / 'stopping' → 'paused'
        // - 'archived' / 'archiving' → 'paused'
        // - anything else unexpected → log and skip

        if (
          (daytonaState === 'started' || daytonaState === 'running') &&
          lsStatus !== 'running'
        ) {
          yield* Effect.logInfo(
            `Reconcile: sandbox "${sandboxId}" is ${daytonaState} in Daytona but "${lsStatus ?? 'null'}" in LiveStore, committing SandboxResumed`
          ).pipe(Effect.annotateLogs('module', logPrefix))
          store.commit(events.sandboxResumed({ workspaceId }))
        } else if (
          (daytonaState === 'stopped' || daytonaState === 'stopping') &&
          lsStatus !== 'paused'
        ) {
          yield* Effect.logInfo(
            `Reconcile: sandbox "${sandboxId}" is ${daytonaState} in Daytona but "${lsStatus ?? 'null'}" in LiveStore, committing SandboxPaused`
          ).pipe(Effect.annotateLogs('module', logPrefix))
          store.commit(events.sandboxPaused({ workspaceId }))
        } else if (
          (daytonaState === 'archived' || daytonaState === 'archiving') &&
          lsStatus !== 'paused'
        ) {
          yield* Effect.logInfo(
            `Reconcile: sandbox "${sandboxId}" is ${daytonaState} in Daytona but "${lsStatus ?? 'null'}" in LiveStore, committing SandboxPaused (archived treated as paused)`
          ).pipe(Effect.annotateLogs('module', logPrefix))
          store.commit(events.sandboxPaused({ workspaceId }))
        }
      })

      /**
       * Run one full reconciliation pass across all Daytona workspaces.
       */
      const runReconciliationPass = Effect.fn(
        'DaytonaSandboxProvider.runReconciliationPass'
      )(function* () {
        const allWorkspaces = store.query(tables.workspaces)
        const daytonaWorkspaces = pipe(
          allWorkspaces,
          Arr.filter(
            (ws) => ws.sandboxProvider === 'daytona' && ws.sandboxId !== null
          )
        )

        if (daytonaWorkspaces.length === 0) {
          return
        }

        yield* Effect.logDebug(
          `Reconciling Daytona state for ${String(daytonaWorkspaces.length)} workspace(s)`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        yield* Effect.forEach(
          daytonaWorkspaces,
          (workspace) =>
            reconcileOneWorkspace({
              id: workspace.id,
              sandboxId: workspace.sandboxId as string,
              sandboxStatus: workspace.sandboxStatus,
            }),
          { discard: true }
        )
      })

      /**
       * reconcileState — run one reconciliation pass.
       *
       * Exposed on the SandboxProvider interface so it can be called
       * directly in tests. In production the Layer forks a daemon fiber
       * that calls this repeatedly on a 30-second interval.
       */
      const reconcileState = Effect.fn('DaytonaSandboxProvider.reconcileState')(
        function* () {
          yield* runReconciliationPass()
        }
      )

      /**
       * The forever-polling daemon loop.
       *
       * Runs one immediate reconciliation pass on startup, then sleeps
       * and repeats forever until the fiber is interrupted.
       */
      const reconcileLoop: Effect.Effect<never> = Effect.gen(function* () {
        yield* Effect.logInfo(
          'Running initial Daytona state reconciliation pass'
        ).pipe(Effect.annotateLogs('module', logPrefix))
        yield* runReconciliationPass()

        return yield* Effect.gen(function* () {
          yield* Effect.sleep(
            Duration.millis(DAYTONA_RECONCILE_POLL_INTERVAL_MS)
          )
          yield* runReconciliationPass()
        }).pipe(Effect.forever)
      })

      // ── checkAvailability (Issue 12) ────────────────────────────
      // Verifies that the Daytona API is reachable by performing a
      // lightweight `list(limit=1)` call. The result is cached after
      // the first successful or failed check — Daytona availability
      // is unlikely to change during a server session.
      //
      // Since `DaytonaSandboxProvider.layer` depends on `DaytonaClient.layer`
      // (which dies if DAYTONA_API_KEY is missing), we know the API key is
      // present if this code executes. The check focuses on connectivity.

      const runAvailabilityCheck = Effect.gen(function* () {
        // Lightweight connectivity test: list with limit=1
        const status: ProviderStatus = yield* daytonaClient
          .list(undefined, undefined, 1)
          .pipe(
            Effect.map(
              (): ProviderStatus => ({
                available: true,
              })
            ),
            Effect.catchAll((error) => {
              const errorCode =
                error instanceof RpcError ? error.code : undefined

              // Provide actionable guidance based on error type
              let guidance: string
              if (errorCode === 'DAYTONA_RATE_LIMIT') {
                guidance =
                  'Daytona API rate limit reached. Try again in a few minutes.'
              } else if (errorCode === 'DAYTONA_TIMEOUT') {
                guidance =
                  'Daytona API is unreachable. Check your network connection and verify the API URL.'
              } else {
                guidance = `Daytona API check failed: ${error.message}. Verify your DAYTONA_API_KEY is valid and the API is reachable.`
              }

              return Effect.succeed<ProviderStatus>({
                available: false,
                error: guidance,
              })
            })
          )

        if (status.available) {
          yield* Effect.logInfo('Daytona API is available').pipe(
            Effect.annotateLogs('module', logPrefix)
          )
        } else {
          yield* Effect.logWarning(
            `Daytona API unavailable: ${status.error}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }

        return status
      })

      const checkAvailability = Effect.fn(
        'DaytonaSandboxProvider.checkAvailability'
      )(function* () {
        const cached = yield* Ref.get(cachedAvailability)
        if (cached !== null) {
          return cached
        }

        const status = yield* runAvailabilityCheck
        yield* Ref.set(cachedAvailability, status)
        return status
      })

      // ── setAutoStopInterval ──────────────────────────────────
      // Issue 19: Update the auto-stop interval for a Daytona sandbox.
      //
      // Calls `sandbox.setAutostopInterval()` via the SDK. The interval
      // is in minutes (0 disables auto-stop).

      const setAutoStopInterval = Effect.fn(
        'DaytonaSandboxProvider.setAutoStopInterval'
      )(function* (workspaceId: string, interval: number) {
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
            message: `Cannot set auto-stop: workspace "${workspaceId}" has no active Daytona sandbox`,
            code: 'NOT_FOUND',
          })
        }

        const sandboxId = workspaceOpt.value.sandboxId
        const sandbox = yield* daytonaClient.get(sandboxId)
        yield* daytonaClient.setAutostopInterval(sandbox, interval)

        yield* Effect.logInfo(
          `Auto-stop interval set to ${interval} minutes for workspace "${workspaceId}" (sandbox: "${sandboxId}")`
        ).pipe(Effect.annotateLogs('module', logPrefix))
      })

      // ── Run availability check eagerly ─────────────────────────
      // Cache the result during layer construction so it's ready before
      // the first `sandbox.providerStatus` RPC arrives.
      yield* checkAvailability()

      // ── Fork reconciliation daemon ────────────────────────────
      // The reconciliation loop runs for the lifetime of the service.
      // On service shutdown the fiber is interrupted automatically by
      // Effect's Scope management (Layer.scoped + forkDaemon).

      const reconcileFiber = yield* Effect.forkDaemon(reconcileLoop)

      yield* Effect.addFinalizer(() =>
        Fiber.interrupt(reconcileFiber).pipe(
          Effect.tap(() =>
            Effect.logInfo('Daytona state reconciliation loop stopped').pipe(
              Effect.annotateLogs('module', logPrefix)
            )
          ),
          Effect.asVoid
        )
      )

      // ── Return the SandboxProvider implementation ─────────────

      return DaytonaSandboxProvider.of({
        createSandbox,
        destroySandbox,
        pauseSandbox,
        resumeSandbox,
        getPreviewUrl,
        spawnTerminal,
        reconcileState,
        checkAvailability,
        setAutoStopInterval,
      })
    })
  )
}

export { DaytonaSandboxProvider, getDaytonaPtyHandle, removeDaytonaPtyHandle }
