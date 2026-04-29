/**
 * SandboxProviderRouter — Routes sandbox operations to Docker or Daytona
 *
 * This module creates a routing `SandboxProvider` that dispatches to either
 * `DockerSandboxProvider` or `DaytonaSandboxProvider` based on per-workspace
 * configuration.
 *
 * Routing logic:
 * - `createSandbox`: reads `devServerConfig.provider` from the params
 * - All other methods: looks up the workspace's `sandboxProvider` column in
 *   LiveStore to determine which provider to use
 * - `reconcileState`: runs both providers' reconciliation (Docker events +
 *   Daytona polling)
 * - `checkAvailability`: returns the Docker provider's status (the primary
 *   provider). Daytona availability is checked separately via Issue 12.
 *
 * When `DAYTONA_API_KEY` is not configured, the Daytona provider is not
 * available. Requests routed to Daytona return a clear error message.
 *
 * Issue 23: End-to-end integration — Daytona workspace creation flow
 */

import { RpcError } from '@laborer/shared/rpc'
import { tables } from '@laborer/shared/schema'
import { Array as Arr, Effect, Layer, Option, pipe } from 'effect'

import {
  DaytonaClient,
  type DaytonaClientMissingKeyError,
} from './daytona-client.js'
import { DaytonaSandboxProvider } from './daytona-sandbox-provider.js'
import { DAYTONA_TERMINAL_ID_PREFIX } from './daytona-terminal-data-channel.js'
import { DockerSandboxProvider } from './docker-sandbox-provider.js'
import { LaborerStore } from './laborer-store.js'
import type { CreateSandboxParams } from './sandbox-provider.js'
import { SandboxProvider } from './sandbox-provider.js'

/** Module-level log annotation for structured logging. */
const logPrefix = 'SandboxProviderRouter'

// ---------------------------------------------------------------------------
// Daytona unavailable error — returned when Daytona is requested but the
// API key is not configured.
// ---------------------------------------------------------------------------

const daytonaUnavailableError = new RpcError({
  message:
    'Daytona provider is not available. Set DAYTONA_API_KEY in your environment to enable cloud sandboxes.',
  code: 'DAYTONA_UNAVAILABLE',
})

const noSandboxConfiguredError = new RpcError({
  message: 'This workspace is configured with no sandbox provider.',
  code: 'NO_SANDBOX_CONFIGURED',
})

// ---------------------------------------------------------------------------
// Router layer
// ---------------------------------------------------------------------------

/**
 * Build the routing `SandboxProvider` layer.
 *
 * Requires `DockerSandboxProvider` (always available) and optionally
 * `DaytonaSandboxProvider` (only available when `DAYTONA_API_KEY` is set).
 *
 * The Daytona provider layer is built with `Layer.catchAll` to gracefully
 * handle the `DaytonaClientMissingKeyError` from `DaytonaClient.layer`.
 * When the error is caught, a stub is provided instead.
 *
 * Dependencies are composed into a single layer that provides `SandboxProvider`.
 */
const SandboxProviderRouterLayer: Layer.Layer<
  SandboxProvider,
  never,
  DockerSandboxProvider | LaborerStore
> = Layer.effect(
  SandboxProvider,
  Effect.gen(function* () {
    const docker = yield* DockerSandboxProvider
    const { store } = yield* LaborerStore

    // Try to get the Daytona provider. It may not be available if
    // DAYTONA_API_KEY is not set — in that case, `daytona` is null
    // and any request routed to Daytona returns a clear error.
    //
    // We use Effect.serviceOption to optionally resolve it.
    const daytonaOption = yield* Effect.serviceOption(DaytonaSandboxProvider)
    const daytona = Option.getOrNull(daytonaOption)

    if (daytona !== null) {
      yield* Effect.logInfo(
        'SandboxProviderRouter initialized with Docker + Daytona providers'
      ).pipe(Effect.annotateLogs('module', logPrefix))
    } else {
      yield* Effect.logInfo(
        'SandboxProviderRouter initialized with Docker provider only (DAYTONA_API_KEY not configured)'
      ).pipe(Effect.annotateLogs('module', logPrefix))
    }

    // ── Provider resolution ─────────────────────────────────────

    /**
     * Resolve the provider for a workspace by looking up `sandboxProvider`
     * in LiveStore. Returns Docker for Docker workspaces (or unknown),
     * and Daytona for Daytona workspaces.
     */
    const resolveForWorkspace = (
      workspaceId: string
    ): Effect.Effect<SandboxProvider['Type'], RpcError> =>
      Effect.gen(function* () {
        const allWorkspaces = store.query(tables.workspaces)
        const workspaceOpt = pipe(
          allWorkspaces,
          Arr.findFirst((w) => w.id === workspaceId)
        )

        if (workspaceOpt._tag === 'None') {
          return yield* new RpcError({
            message: `Workspace not found: ${workspaceId}`,
            code: 'NOT_FOUND',
          })
        }

        const workspace = workspaceOpt.value
        if (workspace.sandboxProvider === 'daytona') {
          if (daytona === null) {
            return yield* daytonaUnavailableError
          }
          return daytona
        }

        if (workspace.sandboxProvider === 'none') {
          return yield* noSandboxConfiguredError
        }

        // Default to Docker for null, 'docker', or any unknown value
        return docker
      })

    /**
     * Resolve the provider for a createSandbox call by reading the
     * `devServerConfig.provider` field from the params.
     */
    const resolveForCreate = (
      params: CreateSandboxParams
    ): Effect.Effect<SandboxProvider['Type'], RpcError> =>
      Effect.gen(function* () {
        const provider = params.devServerConfig.provider
        if (provider === 'daytona') {
          if (daytona === null) {
            return yield* daytonaUnavailableError
          }
          return daytona
        }
        if (provider === 'none') {
          return yield* noSandboxConfiguredError
        }
        // Default to Docker for null or 'docker'
        return docker
      })

    // ── Routed methods ──────────────────────────────────────────

    const createSandbox = Effect.fn('SandboxProviderRouter.createSandbox')(
      function* (params: CreateSandboxParams) {
        const provider = yield* resolveForCreate(params)
        yield* provider.createSandbox(params)
      }
    )

    const destroySandbox = Effect.fn('SandboxProviderRouter.destroySandbox')(
      function* (workspaceId: string) {
        const provider = yield* resolveForWorkspace(workspaceId)
        yield* provider.destroySandbox(workspaceId)
      }
    )

    const pauseSandbox = Effect.fn('SandboxProviderRouter.pauseSandbox')(
      function* (workspaceId: string) {
        const provider = yield* resolveForWorkspace(workspaceId)
        yield* provider.pauseSandbox(workspaceId)
      }
    )

    const resumeSandbox = Effect.fn('SandboxProviderRouter.resumeSandbox')(
      function* (workspaceId: string) {
        const provider = yield* resolveForWorkspace(workspaceId)
        yield* provider.resumeSandbox(workspaceId)
      }
    )

    const getPreviewUrl = Effect.fn('SandboxProviderRouter.getPreviewUrl')(
      function* (workspaceId: string, port: number) {
        const provider = yield* resolveForWorkspace(workspaceId)
        return yield* provider.getPreviewUrl(workspaceId, port)
      }
    )

    const spawnTerminal = Effect.fn('SandboxProviderRouter.spawnTerminal')(
      function* (workspaceId: string, opts?) {
        const provider = yield* resolveForWorkspace(workspaceId)
        return yield* provider.spawnTerminal(workspaceId, opts)
      }
    )

    const setAutoStopInterval = Effect.fn(
      'SandboxProviderRouter.setAutoStopInterval'
    )(function* (workspaceId: string, interval: number) {
      const provider = yield* resolveForWorkspace(workspaceId)
      yield* provider.setAutoStopInterval(workspaceId, interval)
    })

    // ── Terminal lifecycle routing ──────────────────────────────
    // Terminal operations are routed by checking the `daytona:` prefix
    // on the terminal ID. This mirrors the data port routing in the
    // Electron main process (ipc.ts).

    /**
     * Resolve the provider for a terminal operation by checking the
     * terminal ID prefix. Daytona terminal IDs start with `daytona:`.
     */
    const resolveForTerminal = (
      terminalId: string
    ): SandboxProvider['Type'] => {
      if (terminalId.startsWith(DAYTONA_TERMINAL_ID_PREFIX)) {
        if (daytona === null) {
          // This shouldn't happen in practice — Daytona terminal IDs
          // only exist if the Daytona provider was available at spawn time.
          // But handle gracefully just in case.
          return docker
        }
        return daytona
      }
      return docker
    }

    const resizeTerminal = Effect.fn('SandboxProviderRouter.resizeTerminal')(
      function* (terminalId: string, cols: number, rows: number) {
        const provider = resolveForTerminal(terminalId)
        yield* provider.resizeTerminal(terminalId, cols, rows)
      }
    )

    const killTerminal = Effect.fn('SandboxProviderRouter.killTerminal')(
      function* (terminalId: string) {
        const provider = resolveForTerminal(terminalId)
        yield* provider.killTerminal(terminalId)
      }
    )

    const removeTerminal = Effect.fn('SandboxProviderRouter.removeTerminal')(
      function* (terminalId: string) {
        const provider = resolveForTerminal(terminalId)
        yield* provider.removeTerminal(terminalId)
      }
    )

    // ── Non-routed methods ──────────────────────────────────────

    /**
     * Run state reconciliation for both providers.
     * Docker reconciliation is handled by ContainerService layer construction.
     * Daytona reconciliation is handled by its daemon polling loop.
     */
    const reconcileState = Effect.fn('SandboxProviderRouter.reconcileState')(
      function* () {
        yield* docker.reconcileState()
        if (daytona !== null) {
          yield* daytona.reconcileState()
        }
      }
    )

    /**
     * Check availability of the Docker provider (the primary provider).
     * Daytona availability is separately checked via Issue 12's enhanced
     * `checkAvailability` on the Daytona provider.
     */
    const checkAvailability = Effect.fn(
      'SandboxProviderRouter.checkAvailability'
    )(function* () {
      return yield* docker.checkAvailability()
    })

    return SandboxProvider.of({
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

// ---------------------------------------------------------------------------
// Composed layers for DeferredServiceStack
// ---------------------------------------------------------------------------

/**
 * Full SandboxProvider layer with Docker always available and Daytona
 * optionally available based on `DAYTONA_API_KEY`.
 *
 * This replaces `DockerSandboxProvider.layer` in the `DeferredServiceStack`.
 *
 * Layer construction:
 * 1. Build `DockerSandboxProvider.layer` (always succeeds)
 * 2. Attempt to build `DaytonaSandboxProvider.layer` via `DaytonaClient.layer`
 *    - If `DAYTONA_API_KEY` is set: Daytona provider is available
 *    - If missing: `DaytonaClientMissingKeyError` is caught, Daytona not available
 * 3. Build `SandboxProviderRouterLayer` which routes between the two
 */
const SandboxProviderRoutedLayer: Layer.Layer<
  SandboxProvider | DockerSandboxProvider,
  never,
  | LaborerStore
  | import('./container-service.js').ContainerService
  | import('./deps-image-service.js').DepsImageService
  | import('./docker-detection.js').DockerDetection
  | import('./terminal-client.js').TerminalClient
> = SandboxProviderRouterLayer.pipe(
  // Provide DockerSandboxProvider (always available)
  Layer.provideMerge(DockerSandboxProvider.layer),
  // Optionally provide DaytonaSandboxProvider — catch missing API key
  Layer.provide(
    DaytonaSandboxProvider.layer.pipe(
      Layer.provide(DaytonaClient.layer),
      Layer.catchAll(
        (_error: DaytonaClientMissingKeyError) =>
          // When DAYTONA_API_KEY is missing, don't provide DaytonaSandboxProvider.
          // The router uses Effect.serviceOption to handle its absence.
          Layer.empty
      )
    )
  )
)

export { SandboxProviderRoutedLayer }
