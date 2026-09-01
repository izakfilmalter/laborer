/**
 * The terminal grid renders whole rows, so flooring the row count strands up
 * to one row of pane height. That slack is pushed above row 0 so the prompt
 * stays flush with the bottom of the pane.
 */
import { describe, expect, it } from 'vitest'
import { terminalBottomSlack } from '@/panes/terminal-pane'

describe('terminalBottomSlack', () => {
  it('offsets the grid by the height left under the last row', () => {
    expect(
      terminalBottomSlack({ paneHeight: 875, gridHeight: 864, rows: 54 })
    ).toBe(11)
  })

  it('is zero when the grid already fills the pane', () => {
    expect(
      terminalBottomSlack({ paneHeight: 864, gridHeight: 864, rows: 54 })
    ).toBe(0)
  })

  it('is zero when the grid overflows the pane', () => {
    expect(
      terminalBottomSlack({ paneHeight: 860, gridHeight: 864, rows: 54 })
    ).toBe(0)
  })

  it('ignores an unmeasured grid rather than pushing rows out of view', () => {
    // The renderer runs a frame behind `open()`, so the screen can measure 0.
    expect(
      terminalBottomSlack({ paneHeight: 875, gridHeight: 0, rows: 54 })
    ).toBe(0)
    // A slack of a full row means the row count is stale, not that space is free.
    expect(
      terminalBottomSlack({ paneHeight: 880, gridHeight: 864, rows: 54 })
    ).toBe(0)
  })
})
