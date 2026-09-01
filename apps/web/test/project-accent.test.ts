import {
  PROJECT_COLORS,
  projectColorForName,
} from '@laborer/shared/project-colors'
import { describe, expect, it } from 'vitest'
import { projectAccent, projectColorToken } from '@/lib/project-accent'

describe('projectColorToken', () => {
  it('uses the stored accent when the build knows the token', () => {
    expect(projectColorToken({ color: 'violet', name: 'laborer' })).toBe(
      'violet'
    )
  })

  it('derives an accent for a project stored before accents existed', () => {
    expect(projectColorToken({ color: null, name: 'laborer' })).toBe(
      projectColorForName('laborer')
    )
  })

  it('derives an accent for a token this build does not know', () => {
    expect(projectColorToken({ color: 'chartreuse', name: 'laborer' })).toBe(
      projectColorForName('laborer')
    )
  })
})

describe('projectAccent', () => {
  it('gives every palette token a full set of classes', () => {
    for (const color of PROJECT_COLORS) {
      const accent = projectAccent({ color, name: 'laborer' })
      expect(accent.activeHeaderClassName).toContain(color)
      expect(accent.dotClassName).toContain(color)
      expect(accent.headerClassName).toContain(color)
      expect(accent.iconClassName).toContain(color)
    }
  })

  it('never returns an empty class, so no project renders uncoloured', () => {
    const accent = projectAccent({ name: 'unregistered' })
    expect(accent.headerClassName.length).toBeGreaterThan(0)
    expect(accent.iconClassName.length).toBeGreaterThan(0)
  })
})
