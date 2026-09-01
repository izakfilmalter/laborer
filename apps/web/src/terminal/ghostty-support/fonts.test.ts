import { describe, expect, it } from 'vitest'

import { areFontAdvancesMonospace, cssFontFamilies } from './fonts'

describe('areFontAdvancesMonospace', () => {
  it('accepts a fixed advance and rejects any proportional glyph', () => {
    expect(areFontAdvancesMonospace([10, 10, 10, 10])).toBe(true)
    expect(areFontAdvancesMonospace([10, 10, 7, 10])).toBe(false)
    expect(areFontAdvancesMonospace([10, 10.02])).toBe(false)
  })

  it('fails open when canvas metrics are unavailable', () => {
    expect(areFontAdvancesMonospace([])).toBe(true)
    expect(areFontAdvancesMonospace([Number.NaN, Number.NaN])).toBe(true)
  })
})

describe('cssFontFamilies', () => {
  it('returns null for effectively empty input', () => {
    expect(cssFontFamilies('')).toBeNull()
    expect(cssFontFamilies('   ')).toBeNull()
    expect(cssFontFamilies(' , , ')).toBeNull()
  })

  it('quotes names with spaces and keeps single idents bare', () => {
    expect(cssFontFamilies('Fira Code')).toBe('"Fira Code"')
    expect(cssFontFamilies('monospace')).toBe('monospace')
    expect(cssFontFamilies('"Comic Mono"')).toBe('"Comic Mono"')
  })

  it('normalizes comma-separated lists and strips embedded quotes', () => {
    expect(cssFontFamilies(' Fira Code , Menlo ')).toBe('"Fira Code", Menlo')
    expect(cssFontFamilies('Bad"Name')).toBe('"BadName"')
  })

  it('quotes names that are not single CSS idents', () => {
    expect(cssFontFamilies('3270 Nerd Font')).toBe('"3270 Nerd Font"')
    expect(cssFontFamilies('M+ 1m')).toBe('"M+ 1m"')
  })
})
