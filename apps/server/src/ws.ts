/** biome-ignore-all lint: rpc error mapping is kept direct for terminal transport boundaries. */
import { HttpLayerRouter, HttpServerResponse } from '@effect/platform'
import { RpcSerialization, RpcServer } from '@effect/rpc'
import type { ProjectsEvent } from '@laborer/contracts/projects'
import { WS_METHODS, WsRpcGroup } from '@laborer/contracts/rpc'
import type {
  ServerConfigStreamEvent,
  ServerLifecycleStreamEvent,
} from '@laborer/contracts/server'
import { ShellOpenInEditorError } from '@laborer/contracts/shell'
import type { TerminalEvent } from '@laborer/contracts/terminal'
import {
  TerminalCwdError,
  TerminalNotRunningError,
  TerminalSessionLookupError,
  type TerminalSessionSnapshot,
} from '@laborer/contracts/terminal'
import { Effect, Layer, Stream } from 'effect'

import { ServerRuntimeConfig } from './config'
import { EditorOpener } from './open-in-editor'
import { ProjectStore } from './project-store'
import { ServerLifecycleEvents } from './server-lifecycle-events'
import { TerminalManager } from './terminal-manager'

const unknownMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return fallback
}

const mapShellOpenError = (input: { readonly path: string }, error: unknown) =>
  error instanceof ShellOpenInEditorError
    ? error
    : new ShellOpenInEditorError({
        path: input.path,
        message: unknownMessage(
          error,
          `Unable to open ${input.path} in an editor.`
        ),
        cause: error,
      })

const mapTerminalOpenError = (
  input: {
    readonly cwd: string
    readonly terminalId: string
    readonly threadId: string
  },
  error: unknown
) => {
  if (
    error instanceof TerminalCwdError ||
    error instanceof TerminalSessionLookupError ||
    error instanceof TerminalNotRunningError
  ) {
    return error
  }

  return new TerminalCwdError({
    cwd: input.cwd,
    message: unknownMessage(
      error,
      `Unable to open terminal ${input.terminalId} for thread ${input.threadId}.`
    ),
    cause: error,
  })
}

const mapTerminalSessionError = (
  input: {
    readonly terminalId: TerminalSessionSnapshot['terminalId']
    readonly threadId: TerminalSessionSnapshot['threadId']
  },
  error: unknown
) => {
  if (
    error instanceof TerminalCwdError ||
    error instanceof TerminalSessionLookupError ||
    error instanceof TerminalNotRunningError
  ) {
    return error
  }

  return new TerminalSessionLookupError({
    threadId: input.threadId,
    terminalId: input.terminalId,
    message: unknownMessage(
      error,
      `Unable to resolve terminal ${input.terminalId} for thread ${input.threadId}.`
    ),
  })
}

const WsRpcLayer = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const config = yield* ServerRuntimeConfig
    const editorOpener = yield* EditorOpener
    const projects = yield* ProjectStore
    const lifecycle = yield* ServerLifecycleEvents
    const terminals = yield* TerminalManager

    return WsRpcGroup.of({
      [WS_METHODS.projectsList]: () => projects.list(),
      [WS_METHODS.projectsAdd]: (input) => projects.add(input),
      [WS_METHODS.projectsCreateThread]: (input) =>
        projects.createThread(input),
      [WS_METHODS.shellOpenInEditor]: (input) =>
        editorOpener.openInEditor(input).pipe(
          Effect.catchAll((error) =>
            Effect.fail(mapShellOpenError(input, error))
          ),
          Effect.map(() => ({}))
        ),
      [WS_METHODS.serverGetConfig]: () => Effect.succeed(config),
      [WS_METHODS.terminalOpen]: (input) =>
        terminals
          .open(input)
          .pipe(
            Effect.catchAll((error) =>
              Effect.fail(mapTerminalOpenError(input, error))
            )
          ),
      [WS_METHODS.terminalWrite]: (input) =>
        terminals.write(input).pipe(
          Effect.catchAll((error) =>
            Effect.fail(mapTerminalSessionError(input, error))
          ),
          Effect.map(() => ({}))
        ),
      [WS_METHODS.terminalResize]: (input) =>
        terminals.resize(input).pipe(
          Effect.catchAll((error) =>
            Effect.fail(mapTerminalSessionError(input, error))
          ),
          Effect.map(() => ({}))
        ),
      [WS_METHODS.terminalClear]: (input) =>
        terminals.clear(input).pipe(
          Effect.catchAll((error) =>
            Effect.fail(mapTerminalSessionError(input, error))
          ),
          Effect.map(() => ({}))
        ),
      [WS_METHODS.terminalRestart]: (input) =>
        terminals
          .restart(input)
          .pipe(
            Effect.catchAll((error) =>
              Effect.fail(mapTerminalOpenError(input, error))
            )
          ),
      [WS_METHODS.terminalClose]: (input) =>
        terminals.close(input).pipe(
          Effect.catchAll((error) =>
            Effect.fail(mapTerminalSessionError(input, error))
          ),
          Effect.map(() => ({}))
        ),
      [WS_METHODS.subscribeProjects]: () =>
        Stream.unwrap(
          projects.list().pipe(
            Effect.map((snapshot) =>
              Stream.concat(
                Stream.fromIterable([
                  {
                    version: 1,
                    type: 'snapshot',
                    snapshot,
                  } satisfies ProjectsEvent,
                ]),
                projects.stream
              )
            )
          )
        ),
      [WS_METHODS.subscribeServerConfig]: () =>
        Stream.concat(
          Stream.fromIterable([
            {
              version: 1,
              type: 'snapshot',
              config,
            } satisfies ServerConfigStreamEvent,
          ]),
          Stream.never
        ),
      [WS_METHODS.subscribeServerLifecycle]: () =>
        Stream.unwrap(
          lifecycle.snapshot.pipe(
            Effect.map((snapshot) =>
              Stream.concat(
                Stream.fromIterable<ServerLifecycleStreamEvent>(
                  snapshot.events
                ),
                lifecycle.stream
              )
            )
          )
        ),
      [WS_METHODS.subscribeTerminalEvents]: () =>
        terminals.events.pipe(Stream.map((event): TerminalEvent => event)),
    })
  })
)

export const healthRouteLayer = HttpLayerRouter.add(
  'GET',
  '/health',
  Effect.succeed(HttpServerResponse.unsafeJson({ status: 'ok' }))
)

export const websocketRpcRouteLayer = RpcServer.layerHttpRouter({
  group: WsRpcGroup,
  path: '/ws',
  protocol: 'websocket',
}).pipe(Layer.provide(WsRpcLayer), Layer.provide(RpcSerialization.layerJson))
