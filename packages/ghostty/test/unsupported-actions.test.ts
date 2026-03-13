import { afterEach, describe, expect, it } from 'vitest'

import {
  GHOSTTY_ACTION_REGISTRY,
  getSupportedActions,
  getUnsupportedActionCounts,
  getUnsupportedActions,
  getUnsupportedActionsByReason,
  isUnsupportedAction,
  recordUnsupportedAction,
  resetUnsupportedActionCounts,
} from '../src/unsupported-actions.ts'

describe('unsupported actions registry', () => {
  afterEach(() => {
    resetUnsupportedActionCounts()
  })

  // -------------------------------------------------------------------------
  // Registry completeness
  // -------------------------------------------------------------------------

  it('enumerates all 64 Ghostty actions in the registry', () => {
    const actionCount = Object.keys(GHOSTTY_ACTION_REGISTRY).length
    // 64 total actions from ghostty_action_tag_e
    // = 7 supported + 1 handled_internally + 56 unsupported = 64 total
    expect(actionCount).toBe(64)
  })

  it('classifies all actions as supported, handled_internally, or unsupported', () => {
    for (const [name, entry] of Object.entries(GHOSTTY_ACTION_REGISTRY)) {
      expect(
        ['supported', 'handled_internally', 'unsupported'].includes(
          entry.status
        )
      ).toBe(true)
      expect(typeof entry.description).toBe('string')
      expect(entry.description.length).toBeGreaterThan(0)
      if (entry.status === 'unsupported') {
        expect(typeof entry.reason).toBe('string')
        expect(entry.reason.length).toBeGreaterThan(0)
      }
      // Verify the name doesn't have a prefix
      expect(name.startsWith('unsupported:')).toBe(false)
    }
  })

  it('includes the 7 supported actions from Issue 7', () => {
    const supported = getSupportedActions()
    expect(supported).toContain('set_title')
    expect(supported).toContain('pwd')
    expect(supported).toContain('ring_bell')
    expect(supported).toContain('child_exited')
    expect(supported).toContain('close_window')
    expect(supported).toContain('cell_size')
    expect(supported).toContain('renderer_health')
    expect(supported.length).toBe(7)
  })

  it('classifies render as handled_internally', () => {
    const renderKey = 'render'
    const entry = GHOSTTY_ACTION_REGISTRY[renderKey]
    expect(entry).toBeDefined()
    if (entry !== undefined) {
      expect(entry.status).toBe('handled_internally')
    }
  })

  // -------------------------------------------------------------------------
  // Unsupported action classification
  // -------------------------------------------------------------------------

  it('returns 56 unsupported actions', () => {
    const unsupported = getUnsupportedActions()
    expect(unsupported.length).toBe(56)
  })

  it('identifies unsupported actions by name', () => {
    expect(isUnsupportedAction('mouse_shape')).toBe(true)
    expect(isUnsupportedAction('new_split')).toBe(true)
    expect(isUnsupportedAction('desktop_notification')).toBe(true)
  })

  it('identifies unsupported actions with unsupported: prefix', () => {
    expect(isUnsupportedAction('unsupported:mouse_shape')).toBe(true)
    expect(isUnsupportedAction('unsupported:new_split')).toBe(true)
  })

  it('does not classify supported actions as unsupported', () => {
    expect(isUnsupportedAction('set_title')).toBe(false)
    expect(isUnsupportedAction('pwd')).toBe(false)
    expect(isUnsupportedAction('ring_bell')).toBe(false)
  })

  it('does not classify unknown actions as unsupported', () => {
    expect(isUnsupportedAction('totally_unknown')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Reason-based grouping
  // -------------------------------------------------------------------------

  it('groups unsupported actions by reason', () => {
    const grouped = getUnsupportedActionsByReason()
    expect(grouped.size).toBeGreaterThan(0)

    // PRD-specified categories should all be present
    expect(grouped.has('split_management')).toBe(true)
    expect(grouped.has('tab_management')).toBe(true)
    expect(grouped.has('window_management')).toBe(true)
    expect(grouped.has('search_ui')).toBe(true)
    expect(grouped.has('key_overlay')).toBe(true)
    expect(grouped.has('url_handling')).toBe(true)
    expect(grouped.has('notification')).toBe(true)
    expect(grouped.has('progress_reporting')).toBe(true)
    expect(grouped.has('scrollbar_ui')).toBe(true)
  })

  it('assigns split management actions to split_management category', () => {
    const grouped = getUnsupportedActionsByReason()
    const splitActions = grouped.get('split_management') ?? []
    expect(splitActions).toContain('new_split')
    expect(splitActions).toContain('goto_split')
    expect(splitActions).toContain('resize_split')
    expect(splitActions).toContain('equalize_splits')
    expect(splitActions).toContain('toggle_split_zoom')
  })

  it('assigns tab management actions to tab_management category', () => {
    const grouped = getUnsupportedActionsByReason()
    const tabActions = grouped.get('tab_management') ?? []
    expect(tabActions).toContain('new_tab')
    expect(tabActions).toContain('close_tab')
    expect(tabActions).toContain('move_tab')
    expect(tabActions).toContain('goto_tab')
  })

  // -------------------------------------------------------------------------
  // Rate-limited logging / counting
  // -------------------------------------------------------------------------

  it('records unsupported action counts', () => {
    recordUnsupportedAction('mouse_shape', 1)
    recordUnsupportedAction('mouse_shape', 1)
    recordUnsupportedAction('new_split', 2)

    const counts = getUnsupportedActionCounts()
    expect(counts.get('mouse_shape')).toBe(2)
    expect(counts.get('new_split')).toBe(1)
  })

  it('returns incrementing count from recordUnsupportedAction', () => {
    expect(recordUnsupportedAction('open_url', 1)).toBe(1)
    expect(recordUnsupportedAction('open_url', 1)).toBe(2)
    expect(recordUnsupportedAction('open_url', 1)).toBe(3)
  })

  it('resets counts correctly', () => {
    recordUnsupportedAction('mouse_shape', 1)
    expect(getUnsupportedActionCounts().get('mouse_shape')).toBe(1)

    resetUnsupportedActionCounts()
    expect(getUnsupportedActionCounts().size).toBe(0)
  })

  it('tracks counts independently per action name', () => {
    recordUnsupportedAction('mouse_shape', 1)
    recordUnsupportedAction('mouse_shape', 1)
    recordUnsupportedAction('mouse_shape', 1)
    recordUnsupportedAction('new_split', 2)

    const counts = getUnsupportedActionCounts()
    expect(counts.get('mouse_shape')).toBe(3)
    expect(counts.get('new_split')).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Safety: unsupported actions don't crash
  // -------------------------------------------------------------------------

  it('handles recording of unknown action names gracefully', () => {
    // Even unrecognized action names should not crash
    expect(() =>
      recordUnsupportedAction('totally_unknown_action', 0)
    ).not.toThrow()
    expect(getUnsupportedActionCounts().get('totally_unknown_action')).toBe(1)
  })

  it('handles empty action name gracefully', () => {
    expect(() => recordUnsupportedAction('', 0)).not.toThrow()
  })

  it('handles zero surface ID gracefully', () => {
    expect(() => recordUnsupportedAction('mouse_shape', 0)).not.toThrow()
  })
})
