import { describe, expect, it } from 'vitest'

import { formatTrayTooltip } from '../src/tray.js'

describe('formatTrayTooltip', () => {
  it('returns "No running workspaces" for count 0', () => {
    expect(formatTrayTooltip(0)).toBe('Laborer — No running workspaces')
  })

  it('returns singular form for count 1', () => {
    expect(formatTrayTooltip(1)).toBe('Laborer — 1 running workspace')
  })

  it('returns plural form for count 2', () => {
    expect(formatTrayTooltip(2)).toBe('Laborer — 2 running workspaces')
  })

  it('returns plural form for large counts', () => {
    expect(formatTrayTooltip(42)).toBe('Laborer — 42 running workspaces')
  })

  it('handles negative count as non-zero (edge case)', () => {
    // Negative counts should not occur in practice, but the function
    // should not crash. It falls through to the plural path.
    expect(formatTrayTooltip(-1)).toBe('Laborer — -1 running workspaces')
  })
})
