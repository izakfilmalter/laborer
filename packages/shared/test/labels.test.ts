import { LABEL_COLORS, labelColorForName } from '@laborer/shared/labels'
import { describe, expect, it } from 'vitest'

describe('labelColorForName', () => {
  it('derives the same color for the same name every time', () => {
    expect(labelColorForName('needs review')).toBe(
      labelColorForName('needs review')
    )
  })

  it('ignores case and surrounding whitespace', () => {
    expect(labelColorForName('  Needs Review ')).toBe(
      labelColorForName('needs review')
    )
  })

  it('only ever returns a palette token', () => {
    const names = ['bug', 'chore', 'urgent', 'design', 'infra', '', 'ünïcode']
    for (const name of names) {
      expect(LABEL_COLORS).toContain(labelColorForName(name))
    }
  })

  it('spreads names across the palette', () => {
    const names = Array.from({ length: 200 }, (_, index) => `label-${index}`)
    const used = new Set(names.map(labelColorForName))
    expect(used.size).toBe(LABEL_COLORS.length)
  })
})
