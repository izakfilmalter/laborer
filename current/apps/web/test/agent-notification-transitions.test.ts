/**
 * Unit tests for detectNotificationTransitions — a pure function that
 * determines which workspaces just transitioned to 'needs_input'
 * and should trigger a desktop notification.
 *
 * @see apps/web/src/lib/agent-notification-transitions.ts
 */

import { describe, expect, it } from 'vitest'
import { detectNotificationTransitions } from '../src/lib/agent-notification-transitions'

describe('detectNotificationTransitions', () => {
  it('returns empty array when no workspaces exist', () => {
    const result = detectNotificationTransitions(new Map(), new Map())
    expect(result).toEqual([])
  })

  it('returns workspace ID when status transitions from working to needs_input', () => {
    const prev = new Map([['ws-1', 'working' as const]])
    const curr = new Map([['ws-1', 'needs_input' as const]])
    const result = detectNotificationTransitions(prev, curr)
    expect(result).toEqual(['ws-1'])
  })

  it('does not return workspace ID when status stays needs_input', () => {
    const prev = new Map([['ws-1', 'needs_input' as const]])
    const curr = new Map([['ws-1', 'needs_input' as const]])
    const result = detectNotificationTransitions(prev, curr)
    expect(result).toEqual([])
  })

  it('does not return workspace ID when status transitions from null to needs_input', () => {
    // null → waiting means the workspace was freshly loaded with agent already
    // idle — this is not a "just finished" transition, so don't notify.
    const prev = new Map<string, 'working' | 'needs_input'>()
    const curr = new Map([['ws-1', 'needs_input' as const]])
    const result = detectNotificationTransitions(prev, curr)
    expect(result).toEqual([])
  })

  it('returns multiple workspace IDs when several transition simultaneously', () => {
    const prev = new Map([
      ['ws-1', 'working' as const],
      ['ws-2', 'working' as const],
      ['ws-3', 'needs_input' as const],
    ])
    const curr = new Map([
      ['ws-1', 'needs_input' as const],
      ['ws-2', 'needs_input' as const],
      ['ws-3', 'needs_input' as const],
    ])
    const result = detectNotificationTransitions(prev, curr)
    expect(result).toEqual(expect.arrayContaining(['ws-1', 'ws-2']))
    expect(result).not.toContain('ws-3')
    expect(result).toHaveLength(2)
  })

  it('does not return workspace ID when status transitions from working to null', () => {
    // Agent cleared (e.g., non-agent process took over) — not a notification event
    const prev = new Map([['ws-1', 'working' as const]])
    const curr = new Map<string, 'working' | 'needs_input'>()
    const result = detectNotificationTransitions(prev, curr)
    expect(result).toEqual([])
  })
})
