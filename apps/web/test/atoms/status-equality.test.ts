/**
 * Regression coverage for the structural status equalities that keep the
 * shared terminal-host and slack-daemon atoms from notifying consumers when
 * a poll observed no change.
 *
 * @see apps/web/src/atoms/terminal-host-status.ts
 * @see apps/web/src/atoms/slack-daemon-status.ts
 */

import { AtomRegistry } from 'effect/unstable/reactivity'
import { describe, expect, it } from 'vitest'

import {
  areSlackDaemonStatusesEqual,
  slackDaemonStatusAtom,
} from '../../src/atoms/slack-daemon-status'
import {
  areTerminalHostStatusesEqual,
  terminalHostStatusAtom,
} from '../../src/atoms/terminal-host-status'

describe('areTerminalHostStatusesEqual', () => {
  it('treats structurally equal statuses as equal', () => {
    expect(
      areTerminalHostStatusesEqual(
        { expectedVersion: '2', runningVersion: '1', state: 'outdated' },
        { expectedVersion: '2', runningVersion: '1', state: 'outdated' }
      )
    ).toBe(true)
    expect(areTerminalHostStatusesEqual(undefined, undefined)).toBe(true)
  })

  it('detects any field change', () => {
    const base = {
      expectedVersion: '2',
      runningVersion: '2',
      state: 'healthy',
    } as const
    expect(
      areTerminalHostStatusesEqual(base, { ...base, state: 'restarting' })
    ).toBe(false)
    expect(
      areTerminalHostStatusesEqual(base, { ...base, runningVersion: '1' })
    ).toBe(false)
    expect(areTerminalHostStatusesEqual(base, undefined)).toBe(false)
  })
})

describe('areSlackDaemonStatusesEqual', () => {
  it('compares by status value', () => {
    expect(
      areSlackDaemonStatusesEqual({ status: 'running' }, { status: 'running' })
    ).toBe(true)
    expect(
      areSlackDaemonStatusesEqual({ status: 'running' }, { status: 'stopped' })
    ).toBe(false)
    expect(areSlackDaemonStatusesEqual(undefined, { status: 'error' })).toBe(
      false
    )
  })
})

describe('shared status atoms', () => {
  it('skip listener notification when an equal status is written', () => {
    const registry = AtomRegistry.make()
    let terminalNotifications = 0
    let slackNotifications = 0
    registry.subscribe(terminalHostStatusAtom, () => {
      terminalNotifications += 1
    })
    registry.subscribe(slackDaemonStatusAtom, () => {
      slackNotifications += 1
    })

    registry.set(terminalHostStatusAtom, {
      expectedVersion: '2',
      state: 'healthy',
    })
    registry.set(terminalHostStatusAtom, {
      expectedVersion: '2',
      state: 'healthy',
    })
    expect(terminalNotifications).toBe(1)

    registry.set(slackDaemonStatusAtom, { status: 'running' })
    registry.set(slackDaemonStatusAtom, { status: 'running' })
    expect(slackNotifications).toBe(1)

    registry.set(slackDaemonStatusAtom, { status: 'stopped' })
    expect(slackNotifications).toBe(2)
    registry.dispose()
  })
})
