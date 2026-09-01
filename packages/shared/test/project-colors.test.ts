import {
  nextProjectColor,
  PROJECT_COLORS,
  projectColorForName,
} from '@laborer/shared/project-colors'
import { describe, expect, it } from 'vitest'

describe('projectColorForName', () => {
  it('derives the same accent for the same name every time', () => {
    expect(projectColorForName('laborer')).toBe(projectColorForName('laborer'))
  })

  it('ignores case and surrounding whitespace', () => {
    expect(projectColorForName('  Laborer ')).toBe(
      projectColorForName('laborer')
    )
  })

  it('only ever returns a palette token', () => {
    const names = ['laborer', 'website', '', 'ünïcode', 'a'.repeat(400)]
    for (const name of names) {
      expect(PROJECT_COLORS).toContain(projectColorForName(name))
    }
  })
})

describe('nextProjectColor', () => {
  it('gives every project a distinct accent while the palette has room', () => {
    const taken: string[] = []
    for (let index = 0; index < PROJECT_COLORS.length; index += 1) {
      taken.push(nextProjectColor(`project-${index}`, taken))
    }
    expect(new Set(taken).size).toBe(PROJECT_COLORS.length)
  })

  it('falls back to the name-derived accent once the palette is exhausted', () => {
    expect(nextProjectColor('laborer', [...PROJECT_COLORS])).toBe(
      projectColorForName('laborer')
    )
  })

  it('ignores unaccented projects when choosing', () => {
    expect(nextProjectColor('laborer', [null, null])).toBe(PROJECT_COLORS[0])
  })
})
