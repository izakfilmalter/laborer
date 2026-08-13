import { describe, expect, it, vi } from 'vitest'
import {
  AgentNotificationCoordinator,
  type AgentStatusFact,
  type NativeNotificationRequest,
  type NotificationScheduler,
} from '../src/agent-notification-coordinator.js'

class ManualScheduler implements NotificationScheduler<number> {
  readonly #callbacks = new Map<number, () => void>()
  #nextId = 0

  clear(timer: number): void {
    this.#callbacks.delete(timer)
  }

  schedule(_delayMs: number, callback: () => void): number {
    const id = ++this.#nextId
    this.#callbacks.set(id, callback)
    return id
  }

  flush(): void {
    const callbacks = [...this.#callbacks.values()]
    this.#callbacks.clear()
    for (const callback of callbacks) {
      callback()
    }
  }
}

const fact = (
  status: AgentStatusFact['status'],
  overrides: Partial<AgentStatusFact> = {}
): AgentStatusFact => ({
  agentId: 'terminal-1:1',
  agentName: 'Claude',
  status,
  terminalId: 'terminal-1',
  workspaceId: 'workspace-1',
  ...overrides,
})

function harness() {
  const scheduler = new ManualScheduler()
  const shown: NativeNotificationRequest[] = []
  const route = vi.fn()
  let focused = false
  const coordinator = new AgentNotificationCoordinator({
    contextForWorkspace: () => 'feature/notifications',
    hasFocusedWindow: () => focused,
    route,
    scheduler,
    show: (request) => shown.push(request),
  })
  return {
    coordinator,
    route,
    scheduler,
    setFocused: (value: boolean) => {
      focused = value
    },
    shown,
  }
}

describe('AgentNotificationCoordinator', () => {
  it('hydrates silently, then delivers each terminal transition exactly once', () => {
    const h = harness()
    h.coordinator.observe(fact('working'))
    h.coordinator.observe(
      fact('working', { terminalId: 'terminal-2', agentId: 'terminal-2:1' })
    )
    h.coordinator.observe(fact('needs_input'))
    h.coordinator.observe(
      fact('needs_input', {
        terminalId: 'terminal-2',
        agentId: 'terminal-2:1',
      })
    )
    h.scheduler.flush()

    expect(h.shown).toHaveLength(2)
    expect(h.shown[0]).toMatchObject({
      body: 'feature/notifications',
      title: 'Claude needs input',
    })

    h.coordinator.observe(fact('working'))
    h.coordinator.observe(fact('idle'))
    h.scheduler.flush()
    expect(h.shown.map(({ title }) => title)).toEqual([
      'Claude needs input',
      'Claude needs input',
      'Claude finished',
    ])
  })

  it('does not replay an attention state observed during hydration', () => {
    const h = harness()
    h.coordinator.observe(fact('needs_input'))
    h.scheduler.flush()
    expect(h.shown).toEqual([])
  })

  it('ignores transitions that do not enter attention or complete work', () => {
    const h = harness()
    h.coordinator.observe(fact('idle'))
    h.coordinator.observe(fact('unknown'))
    h.coordinator.observe(fact('working'))
    h.scheduler.flush()
    expect(h.shown).toEqual([])
  })

  it('replaces pending delivery when status flaps', () => {
    const h = harness()
    h.coordinator.observe(fact('working'))
    h.coordinator.observe(fact('needs_input'))
    h.coordinator.observe(fact('working'))
    h.scheduler.flush()
    expect(h.shown).toEqual([])
  })

  it('revalidates state and agent generation at delivery', () => {
    const h = harness()
    h.coordinator.observe(fact('working'))
    h.coordinator.observe(fact('needs_input'))
    h.coordinator.observe(fact('needs_input', { agentId: 'terminal-1:2' }))
    h.scheduler.flush()
    expect(h.shown).toEqual([])
  })

  it('suppresses native delivery while any app window is focused', () => {
    const h = harness()
    h.coordinator.observe(fact('working'))
    h.coordinator.observe(fact('needs_input'))
    h.setFocused(true)
    h.scheduler.flush()
    expect(h.shown).toEqual([])
  })

  it('routes a click to the exact workspace and terminal', () => {
    const h = harness()
    h.coordinator.observe(fact('working'))
    h.coordinator.observe(fact('needs_input'))
    h.scheduler.flush()
    h.shown[0]?.onClick()
    expect(h.route).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
      workspaceId: 'workspace-1',
    })
  })
})
