import type { AgentStatus } from '@laborer/shared/rpc'

interface AgentStatusFact {
  readonly agentId: string
  readonly agentName: string
  readonly status: AgentStatus | null
  readonly terminalId: string
  readonly workspaceId: string
}

interface NotificationClickIntent {
  readonly terminalId: string
  readonly workspaceId: string
}

interface NativeNotificationRequest {
  readonly body: string
  readonly onClick: () => void
  readonly title: string
}

interface NotificationScheduler<TTimer = unknown> {
  clear(timer: TTimer): void
  schedule(delayMs: number, callback: () => void): TTimer
}

interface AgentNotificationCoordinatorOptions<TTimer = unknown> {
  readonly contextForWorkspace: (workspaceId: string) => string
  readonly delayMs?: number
  readonly hasFocusedWindow: () => boolean
  readonly route: (intent: NotificationClickIntent) => void
  readonly scheduler: NotificationScheduler<TTimer>
  readonly show: (request: NativeNotificationRequest) => void
}

type NotificationKind = 'finished' | 'needs_input'

interface PendingNotification<TTimer> {
  readonly agentId: string
  readonly kind: NotificationKind
  readonly timer: TTimer
}

const isCompletion = (previous: AgentStatus, current: AgentStatus): boolean =>
  (previous === 'working' || previous === 'needs_input') && current === 'idle'

/**
 * The single main-process owner of native agent notifications.
 *
 * Facts may arrive often, but policy is terminal-keyed: the first fact only
 * hydrates history, each later fact replaces pending delivery, and delivery
 * revalidates status, agent generation, and app-wide focus.
 */
class AgentNotificationCoordinator<TTimer = unknown> {
  readonly #current = new Map<string, AgentStatusFact>()
  readonly #pending = new Map<string, PendingNotification<TTimer>>()
  readonly #options: AgentNotificationCoordinatorOptions<TTimer>

  constructor(options: AgentNotificationCoordinatorOptions<TTimer>) {
    this.#options = options
  }

  observe(fact: AgentStatusFact): void {
    const previous = this.#current.get(fact.terminalId)
    this.#cancelPending(fact.terminalId)

    if (fact.status === null) {
      this.#current.delete(fact.terminalId)
      return
    }

    this.#current.set(fact.terminalId, fact)

    // Initial state is hydration, not a transition. Agent replacement also
    // establishes a fresh history rather than replaying its current state.
    if (!(previous?.status && previous.agentId === fact.agentId)) {
      return
    }

    let kind: NotificationKind | null = null
    if (fact.status === 'needs_input' && previous.status !== 'needs_input') {
      kind = 'needs_input'
    } else if (isCompletion(previous.status, fact.status)) {
      kind = 'finished'
    }

    if (kind === null) {
      return
    }

    const delayMs = this.#options.delayMs ?? 1000
    const timer = this.#options.scheduler.schedule(delayMs, () => {
      this.#deliver(fact.terminalId, fact.agentId, kind)
    })
    this.#pending.set(fact.terminalId, { agentId: fact.agentId, kind, timer })
  }

  dispose(): void {
    for (const { timer } of this.#pending.values()) {
      this.#options.scheduler.clear(timer)
    }
    this.#pending.clear()
    this.#current.clear()
  }

  #cancelPending(terminalId: string): void {
    const pending = this.#pending.get(terminalId)
    if (pending === undefined) {
      return
    }
    this.#options.scheduler.clear(pending.timer)
    this.#pending.delete(terminalId)
  }

  #deliver(terminalId: string, agentId: string, kind: NotificationKind): void {
    const pending = this.#pending.get(terminalId)
    if (pending?.agentId !== agentId || pending.kind !== kind) {
      return
    }
    this.#pending.delete(terminalId)

    const fact = this.#current.get(terminalId)
    const stateStillHolds =
      kind === 'needs_input'
        ? fact?.status === 'needs_input'
        : fact?.status === 'idle'
    if (!(fact && fact.agentId === agentId && stateStillHolds)) {
      return
    }
    if (this.#options.hasFocusedWindow()) {
      return
    }

    const intent = {
      terminalId: fact.terminalId,
      workspaceId: fact.workspaceId,
    }
    this.#options.show({
      title: `${fact.agentName} ${kind === 'needs_input' ? 'needs input' : 'finished'}`,
      body: this.#options.contextForWorkspace(fact.workspaceId),
      onClick: () => this.#options.route(intent),
    })
  }
}

const nativeNotificationScheduler: NotificationScheduler<
  ReturnType<typeof setTimeout>
> = {
  clear: clearTimeout,
  schedule: (delayMs, callback) => setTimeout(callback, delayMs),
}

export { AgentNotificationCoordinator, nativeNotificationScheduler }
export type {
  AgentNotificationCoordinatorOptions,
  AgentStatusFact,
  NativeNotificationRequest,
  NotificationClickIntent,
  NotificationScheduler,
}
