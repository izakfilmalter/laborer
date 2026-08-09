/**
 * Unit tests for the shared Agent status presentation vocabulary.
 *
 * These assert the properties that make the four states scannable — each
 * state is visually distinct, only the attention state animates urgently,
 * and stale detection is never dressed up as fresh activity.
 *
 * @see apps/web/src/lib/agent-status-presentation.ts
 */

import type { AgentStatus } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  describeAgentStatus,
  getAgentStatusBadgeClassName,
  getAgentStatusPresentation,
} from '../src/lib/agent-status-presentation'

const ALL_STATUSES: readonly AgentStatus[] = [
  'working',
  'needs_input',
  'idle',
  'unknown',
]

const snapshot = (
  status: AgentStatus,
  overrides: { stale?: boolean; source?: 'hook' | 'ps' } = {}
) => ({
  status,
  source: overrides.source ?? ('ps' as const),
  changedAt: 0,
  stale: overrides.stale ?? false,
  seen: true,
})

describe('agent status presentation', () => {
  it('gives every status a distinct label and colour treatment', () => {
    const labels = ALL_STATUSES.map((s) => getAgentStatusPresentation(s).label)
    const badges = ALL_STATUSES.map(
      (s) => getAgentStatusPresentation(s).badgeClassName
    )

    expect(new Set(labels).size).toBe(ALL_STATUSES.length)
    expect(new Set(badges).size).toBe(ALL_STATUSES.length)
  })

  it('marks only needs input as the attention state', () => {
    const attention = ALL_STATUSES.filter(
      (s) => getAgentStatusPresentation(s).isAttention
    )

    expect(attention).toEqual(['needs_input'])
  })

  it('reserves the urgent ping for needs input and rests the at-rest states', () => {
    expect(getAgentStatusPresentation('needs_input').motion).toBe('ping')
    expect(getAgentStatusPresentation('working').motion).toBe('breathe')
    expect(getAgentStatusPresentation('idle').motion).toBe('none')
    expect(getAgentStatusPresentation('unknown').motion).toBe('none')
  })

  it('dims and dashes a stale badge without changing its state', () => {
    const fresh = getAgentStatusBadgeClassName(snapshot('working'))
    const stale = getAgentStatusBadgeClassName(
      snapshot('working', { stale: true })
    )

    expect(fresh).not.toContain('opacity-70')
    expect(stale).toContain('opacity-70')
    expect(stale).toContain('border-dashed')
  })

  it('gives every status a hollow dot treatment for stale detection', () => {
    for (const status of ALL_STATUSES) {
      const presentation = getAgentStatusPresentation(status)

      expect(presentation.dotStaleClassName).toContain('border-')
      expect(presentation.dotStaleClassName).not.toContain('bg-')
    }
  })

  it('describes provenance in operator language', () => {
    expect(describeAgentStatus(snapshot('idle', { source: 'hook' }))).toContain(
      'agent hook'
    )
    expect(describeAgentStatus(snapshot('idle', { source: 'ps' }))).toContain(
      'process inspection'
    )
  })

  it('says out loud when a status may be out of date', () => {
    expect(describeAgentStatus(snapshot('working', { stale: true }))).toContain(
      'stale'
    )
    expect(describeAgentStatus(snapshot('working'))).not.toContain('stale')
  })
})
