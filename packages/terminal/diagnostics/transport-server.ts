import { createServer, type Server } from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import {
  type TerminalAttachEvent,
  TerminalRpcError,
  TerminalRpcs,
} from '@laborer/shared/rpc'
import { Effect, Layer, PubSub } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/unstable/http'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'
import { TerminalRpcsLive } from '../src/rpc/handlers.js'
import { directLayer } from '../src/services/pty-direct.js'
import {
  type TerminalLifecycleEvent,
  TerminalManager,
} from '../src/services/terminal-manager.js'

export type DiagnosticMode = 'minimal' | 'pty'

export interface DiagnosticServerOptions {
  readonly host: string
  readonly loadBlockMs: number
  readonly loadEveryMs: number
  readonly mode: DiagnosticMode
  readonly port: number
}

const minimalTerminalManagerLayer = Layer.effect(
  TerminalManager,
  Effect.gen(function* () {
    const lifecycleEvents = yield* PubSub.unbounded<TerminalLifecycleEvent>()
    const subscribers = new Map<
      string,
      Map<string, (event: TerminalAttachEvent) => boolean>
    >()
    const terminals = new Map<
      string,
      {
        readonly id: string
        readonly workspaceId: string
        status: 'running' | 'stopped'
      }
    >()
    let cursor = 0

    const publish = (terminalId: string, event: TerminalAttachEvent): void => {
      const attached = subscribers.get(terminalId)
      if (attached === undefined) {
        return
      }
      for (const [leaseId, subscriber] of attached) {
        if (!subscriber(event)) {
          attached.delete(leaseId)
        }
      }
    }

    const terminalRecord = (terminal: {
      readonly id: string
      readonly workspaceId: string
      readonly status: 'running' | 'stopped'
    }) => ({
      agentProcessIds: [],
      agentStatus: null,
      args: [],
      command: 'diagnostic-echo',
      cwd: '/diagnostic',
      foregroundProcess: null,
      hasChildProcess: false,
      id: terminal.id,
      processChain: [],
      sessionTitle: null,
      status: terminal.status,
      workspaceId: terminal.workspaceId,
    })

    const service: Pick<
      TerminalManager['Service'],
      | 'acknowledge'
      | 'attach'
      | 'hostStatus'
      | 'kill'
      | 'lifecycleEvents'
      | 'listTerminals'
      | 'remove'
      | 'resize'
      | 'restart'
      | 'spawn'
      | 'transportMetrics'
      | 'unsubscribe'
      | 'write'
    > = {
      acknowledge: () => Effect.void,
      attach: (terminalId, options, subscriber) =>
        Effect.gen(function* () {
          const terminal = terminals.get(terminalId)
          if (terminal === undefined) {
            return yield* new TerminalRpcError({
              code: 'TERMINAL_NOT_FOUND',
              message: `Terminal not found: ${terminalId}`,
            })
          }
          const leaseId = options.leaseId ?? crypto.randomUUID()
          let attached = subscribers.get(terminalId)
          if (attached === undefined) {
            attached = new Map()
            subscribers.set(terminalId, attached)
          }
          attached.set(leaseId, subscriber)
          subscriber({ _tag: 'Snapshot', cursor, data: '' })
          subscriber({
            _tag: 'Meta',
            epoch: 'diagnostic-minimal',
            status: terminal.status,
          })
          subscriber({ _tag: 'ReplayComplete' })
          return { subscriberId: leaseId }
        }),
      hostStatus: () =>
        Effect.succeed({
          expectedVersion: 'diagnostic-minimal',
          runningVersion: 'diagnostic-minimal',
          state: 'healthy' as const,
        }),
      kill: (terminalId) =>
        Effect.sync(() => {
          const terminal = terminals.get(terminalId)
          if (terminal !== undefined) {
            terminal.status = 'stopped'
          }
          publish(terminalId, { _tag: 'Exit', exitCode: 0, signal: 0 })
        }),
      lifecycleEvents,
      listTerminals: () =>
        Effect.succeed([...terminals.values()].map(terminalRecord)),
      remove: (terminalId) =>
        Effect.sync(() => {
          terminals.delete(terminalId)
          subscribers.delete(terminalId)
        }),
      resize: () => Effect.void,
      restart: (terminalId) =>
        Effect.sync(() => {
          const terminal = terminals.get(terminalId)
          if (terminal === undefined) {
            throw new Error(`Terminal not found: ${terminalId}`)
          }
          terminal.status = 'running'
          return terminalRecord(terminal)
        }),
      spawn: ({ id, workspaceId }) =>
        Effect.sync(() => {
          const terminal = {
            id: id ?? crypto.randomUUID(),
            status: 'running' as const,
            workspaceId,
          }
          terminals.set(terminal.id, terminal)
          return terminalRecord(terminal)
        }),
      transportMetrics: () =>
        Effect.succeed({
          ackLatencyMs: 0,
          backlogBytes: 0,
          resetCount: 0,
          wsBufferedBytes: null,
        }),
      unsubscribe: (terminalId, subscriberId) =>
        Effect.sync(() => {
          subscribers.get(terminalId)?.delete(subscriberId)
        }),
      write: (terminalId, data) =>
        Effect.sync(() => {
          cursor += new TextEncoder().encode(data).length
          publish(terminalId, { _tag: 'Delta', cursor, data })
        }),
    }

    return TerminalManager.of(service as TerminalManager['Service'])
  })
)

const makeRpcRoute = () => {
  const protocol = Layer.effect(
    RpcServer.Protocol,
    Effect.gen(function* () {
      const { httpEffect, protocol } =
        yield* RpcServer.makeProtocolWithHttpEffectWebsocket
      const router = yield* HttpRouter.HttpRouter
      yield* router.add('GET', '/ws', httpEffect)
      return protocol
    })
  )
  return RpcServer.layer(TerminalRpcs).pipe(
    Layer.provide(protocol),
    Layer.provide(TerminalRpcsLive)
  )
}

const loadInjectionLayer = (blockMs: number, everyMs: number) =>
  blockMs <= 0 || everyMs <= 0
    ? Layer.empty
    : Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.sync(() => {
            const timer = setInterval(() => {
              const deadline = performance.now() + blockMs
              while (performance.now() < deadline) {
                // Deliberately block this diagnostic server's event loop.
              }
            }, everyMs)
            return timer
          }),
          (timer) => Effect.sync(() => clearInterval(timer))
        )
      )

export const makeDiagnosticServerLayer = (
  options: DiagnosticServerOptions,
  server: Server = createServer()
) => {
  const managerLayer =
    options.mode === 'pty'
      ? TerminalManager.layer.pipe(Layer.provide(directLayer))
      : minimalTerminalManagerLayer
  const rpcRoute = makeRpcRoute().pipe(Layer.provide(managerLayer))
  const healthRoute = HttpRouter.add('GET', '/health', () =>
    HttpServerResponse.json({
      loadBlockMs: options.loadBlockMs,
      loadEveryMs: options.loadEveryMs,
      mode: options.mode,
      status: 'ok',
    })
  )
  const httpServerLayer = NodeHttpServer.layer(() => server, {
    gracefulShutdownTimeout: 0,
    host: options.host,
    port: options.port,
  })

  return HttpRouter.serve(Layer.merge(rpcRoute, healthRoute)).pipe(
    Layer.provide(RpcSerialization.layerJson),
    Layer.provideMerge(
      loadInjectionLayer(options.loadBlockMs, options.loadEveryMs)
    ),
    Layer.provide(httpServerLayer)
  )
}

export const diagnosticServerUrl = (server: Server): string => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Diagnostic server did not bind a TCP address')
  }
  return `ws://127.0.0.1:${String(address.port)}/ws`
}
