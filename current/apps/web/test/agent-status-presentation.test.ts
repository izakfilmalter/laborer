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
  getAgentStatusSurface,
  showsWorkspaceAgentStatus,
} from '../src/lib/agent-status-presentation'

const ALL_STATUSES: readonly AgentStatus[] = [
  'working',
  'needs_input',
  'idle',
  'unknown',
]

/** The shared ink weight every hued status label uses. */
const HUED_LABEL_INK = /text-[a-z]+-400/

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

  it('separates done from the lifecycle dots by shape', () => {
    expect(getAgentStatusPresentation('done').glyph).toBe('check')

    for (const status of ALL_STATUSES) {
      expect(getAgentStatusPresentation(status).glyph).toBe('dot')
    }
  })

  it('says out loud when a status may be out of date', () => {
    expect(describeAgentStatus(snapshot('working', { stale: true }))).toContain(
      'stale'
    )
    expect(describeAgentStatus(snapshot('working'))).not.toContain('stale')
  })
})

describe('agent status surface accents', () => {
  it('accents only the states worth interrupting for', () => {
    for (const status of ['idle', 'unknown'] as const) {
      const surface = getAgentStatusSurface(status)

      expect(surface.cardClassName).toBe('')
      expect(surface.headerClassName).toBe('')
      expect(surface.rowClassName).toBe('')
    }

    expect(getAgentStatusSurface(null).rowClassName).toBe('')
    expect(getAgentStatusSurface(undefined).cardClassName).toBe('')
  })

  it('gives needs input and done distinct row and card treatments', () => {
    const attention = getAgentStatusSurface('needs_input')
    const done = getAgentStatusSurface('done')

    expect(attention.rowClassName).not.toBe(done.rowClassName)
    expect(attention.cardClassName).not.toBe(done.cardClassName)
    expect(attention.headerClassName).not.toBe(done.headerClassName)
    expect(done.rowClassName).not.toBe('')
    expect(done.cardClassName).not.toBe('')
  })

  it('reserves the loudest card treatment for a blocked agent', () => {
    // Only "act now" glows; an unseen result is present but never shouts
    // over the workspace that is actually waiting on the operator.
    expect(getAgentStatusSurface('needs_input').cardClassName).toContain(
      'shadow-'
    )
    expect(getAgentStatusSurface('done').cardClassName).not.toContain('shadow-')
  })

  it('keeps an accented row in its own hue on hover', () => {
    // The generic hover treatment repaints the row in accent grey, which
    // would erase the one cue telling the operator this row wants them.
    for (const status of ['needs_input', 'done'] as const) {
      const surface = getAgentStatusSurface(status)

      expect(surface.rowHoverClassName).not.toContain('bg-accent')
      expect(surface.rowHoverClassName).toContain('hover:bg-')
    }

    expect(getAgentStatusSurface('needs_input').rowHoverClassName).not.toBe(
      getAgentStatusSurface('done').rowHoverClassName
    )
  })

  it('leaves quiet rows on the shared hover treatment', () => {
    for (const status of ['idle', 'unknown', 'working'] as const) {
      expect(getAgentStatusSurface(status).rowHoverClassName).toContain(
        'hover:bg-accent'
      )
    }

    expect(getAgentStatusSurface(null).rowHoverClassName).toContain(
      'hover:bg-accent'
    )
  })

  it('never draws an attention header lighter than the active frame', () => {
    for (const status of ['needs_input', 'done'] as const) {
      expect(getAgentStatusSurface(status).headerClassName).toContain(
        'border-b-2'
      )
    }
  })

  it('keeps working quiet everywhere but the frame header it owns', () => {
    const working = getAgentStatusSurface('working')

    expect(working.cardClassName).toBe('')
    expect(working.frameClassName).toBe('')
    expect(working.rowClassName).toBe('')
    expect(working.headerClassName).not.toBe('')
  })

  it('outlines the whole frame for the states worth walking back for', () => {
    // A header strip is invisible on a screen of tiled terminals; the two
    // states that want the operator claim the frame around them instead.
    for (const status of ['needs_input', 'done'] as const) {
      expect(getAgentStatusSurface(status).frameClassName).not.toBe('')
    }

    for (const status of ['idle', 'unknown'] as const) {
      expect(getAgentStatusSurface(status).frameClassName).toBe('')
    }

    expect(getAgentStatusSurface(null).frameClassName).toBe('')
    expect(getAgentStatusSurface(undefined).frameClassName).toBe('')
  })

  it('keeps the frame outline hues apart so two frames never look alike', () => {
    const attention = getAgentStatusSurface('needs_input')
    const done = getAgentStatusSurface('done')

    expect(attention.frameClassName).toContain('amber')
    expect(done.frameClassName).toContain('violet')
  })

  it('inks every hued label at the same weight for both themes', () => {
    // A lighter step reads well on the dark default and washes out the
    // moment the operator switches to the light theme, so the hued states
    // share one ink weight instead of each flattering dark mode.
    for (const status of ['working', 'needs_input', 'done'] as const) {
      expect(getAgentStatusPresentation(status).badgeClassName).toMatch(
        HUED_LABEL_INK
      )
    }
  })

  it('surfaces only the workspace-level states worth summarising', () => {
    for (const status of ['needs_input', 'done', 'working'] as const) {
      expect(showsWorkspaceAgentStatus(status)).toBe(true)
    }

    for (const status of ['idle', 'unknown'] as const) {
      expect(showsWorkspaceAgentStatus(status)).toBe(false)
    }

    expect(showsWorkspaceAgentStatus(null)).toBe(false)
    expect(showsWorkspaceAgentStatus(undefined)).toBe(false)
  })
})
