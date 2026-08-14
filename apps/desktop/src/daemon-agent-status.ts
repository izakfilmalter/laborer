import { type AgentStatus, DaemonRpcs } from '@laborer/shared/rpc'
import { Effect, Fiber, Layer, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import {
  layerWebSocket,
  layerWebSocketConstructorGlobal,
} from 'effect/unstable/socket/Socket'
import type { AgentStatusFact } from './agent-notification-coordinator.js'

interface TerminalStatusInfo {
  readonly agentStatus: { readonly status: AgentStatus } | null
  readonly foregroundProcess: {
    readonly category: string
    readonly label: string
  } | null
  readonly id: string
  readonly processChain: readonly {
    readonly category: string
    readonly label: string
  }[]
  readonly workspaceId: string
}

interface AgentOwner {
  readonly generation: number
  readonly id: string
  readonly label: string
  readonly present: boolean
}

/** Projects daemon terminal snapshots into stable notification facts. */
export class AgentStatusFactProjector {
  readonly #owners = new Map<string, AgentOwner>()

  /** Reconcile a fresh daemon snapshot, clearing terminals lost while offline. */
  reconcile(terminals: readonly TerminalStatusInfo[]): AgentStatusFact[] {
    const terminalIds = new Set(terminals.map((terminal) => terminal.id))
    const facts = terminals.map((terminal) => this.project(terminal))
    for (const terminalId of this.#owners.keys()) {
      if (!terminalIds.has(terminalId)) {
        facts.push(this.remove(terminalId))
      }
    }
    return facts
  }

  remove(terminalId: string): AgentStatusFact {
    const owner = this.#owners.get(terminalId)
    this.#owners.delete(terminalId)
    return {
      agentId: owner?.id ?? `${terminalId}:none`,
      agentName: owner?.label ?? 'Agent',
      status: null,
      terminalId,
      workspaceId: '',
    }
  }

  project(terminal: TerminalStatusInfo): AgentStatusFact {
    const detected =
      terminal.processChain.find((process) => process.category === 'agent') ??
      (terminal.foregroundProcess?.category === 'agent'
        ? terminal.foregroundProcess
        : null)
    const previous = this.#owners.get(terminal.id)
    let owner = previous

    if (detected !== null) {
      const startsGeneration =
        previous === undefined ||
        !previous.present ||
        previous.label !== detected.label
      const generation = startsGeneration
        ? (previous?.generation ?? 0) + 1
        : previous.generation
      owner = {
        generation,
        id: `${terminal.id}:${String(generation)}`,
        label: detected.label,
        present: true,
      }
      this.#owners.set(terminal.id, owner)
    } else if (terminal.agentStatus !== null && owner === undefined) {
      owner = {
        generation: 1,
        id: `${terminal.id}:1`,
        label: 'Agent',
        present: false,
      }
      this.#owners.set(terminal.id, owner)
    }

    const fact = {
      agentId: owner?.id ?? `${terminal.id}:none`,
      agentName: owner?.label ?? 'Agent',
      status: terminal.agentStatus?.status ?? null,
      terminalId: terminal.id,
      workspaceId: terminal.workspaceId,
    }

    if (
      detected === null &&
      owner?.present &&
      (fact.status === null || fact.status === 'idle')
    ) {
      this.#owners.set(terminal.id, { ...owner, present: false })
    }
    return fact
  }
}

const RECONNECT_DELAY_MS = 3000

/** Electron main is an ordinary daemon RPC subscriber for native notices. */
export class DaemonAgentStatusSubscription {
  readonly #projector = new AgentStatusFactProjector()
  readonly #observe: (fact: AgentStatusFact) => void
  #fiber: Fiber.Fiber<void, never> | null = null

  constructor(observe: (fact: AgentStatusFact) => void) {
    this.#observe = observe
  }

  start(origin: string): void {
    this.stop()
    const socketUrl = new URL('/ws', origin)
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'

    const self = this
    const connect = Effect.gen(function* () {
      const client = yield* RpcClient.make(DaemonRpcs)
      const terminals = yield* client['terminal.list']()
      yield* Effect.sync(() => {
        for (const fact of self.#projector.reconcile(terminals)) {
          self.#observe(fact)
        }
      })
      yield* Stream.runForEach(client['terminal.events'](), (event) =>
        Effect.sync(() => {
          if (event._tag === 'ProcessChanged') {
            self.#observe(self.#projector.project(event.terminal))
          } else if (
            event._tag === 'Exited' ||
            event._tag === 'Removed' ||
            event._tag === 'Restarted'
          ) {
            self.#observe(self.#projector.remove(event.id))
          }
        })
      )
    })

    const protocol = RpcClient.layerProtocolSocket({
      retryTransientErrors: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerWebSocket(socketUrl.href).pipe(
            Layer.provide(layerWebSocketConstructorGlobal)
          ),
          RpcSerialization.layerJson
        )
      )
    )
    const reconnecting = connect.pipe(
      Effect.provide(protocol),
      Effect.scoped,
      // A remotely completed stream is also a disconnect. Back off on both
      // success and failure so an orderly close cannot create a hot loop.
      Effect.andThen(Effect.sleep(RECONNECT_DELAY_MS)),
      Effect.catch(() => Effect.sleep(RECONNECT_DELAY_MS)),
      Effect.forever
    )
    this.#fiber = Effect.runFork(reconnecting)
  }

  stop(): void {
    if (this.#fiber !== null) {
      Effect.runFork(Fiber.interrupt(this.#fiber))
      this.#fiber = null
    }
  }
}
