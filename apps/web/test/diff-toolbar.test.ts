import { describe, expect, it } from 'vitest'
import {
  areAllDiffFilesCollapsed,
  nextDiffStyleOverride,
  resolveDiffStyle,
  responsiveDiffStyle,
  sumDiffStats,
  withCollapseAll,
} from '@/lib/diff-toolbar'

describe('diff style resolution', () => {
  it('follows the pane width while there is no override', () => {
    expect(resolveDiffStyle(null, responsiveDiffStyle(false))).toBe('split')
    expect(resolveDiffStyle(null, responsiveDiffStyle(true))).toBe('unified')
  })

  it('lets an explicit choice beat the measured width', () => {
    expect(resolveDiffStyle('split', 'unified')).toBe('split')
    expect(resolveDiffStyle('unified', 'split')).toBe('unified')
  })

  it('keeps an explicit choice across a resize', () => {
    const override = nextDiffStyleOverride('split', 'split')
    const pinned = nextDiffStyleOverride('split', 'unified')

    // Picking "split" while the pane was already wide stays automatic,
    // so shrinking still flips to unified...
    expect(resolveDiffStyle(override, 'unified')).toBe('unified')
    // ...whereas picking "split" in a narrow pane pins it.
    expect(resolveDiffStyle(pinned, 'unified')).toBe('split')
  })

  it('clears the override when the pick matches the responsive default', () => {
    expect(nextDiffStyleOverride('unified', 'unified')).toBeNull()
    expect(nextDiffStyleOverride('split', 'split')).toBeNull()
  })

  it('sets an override when the pick fights the responsive default', () => {
    expect(nextDiffStyleOverride('split', 'unified')).toBe('split')
    expect(nextDiffStyleOverride('unified', 'split')).toBe('unified')
  })
})

describe('collapse-all state', () => {
  const collapsed = (paths: readonly string[]) => (path: string) =>
    paths.includes(path)

  it('is false when no file is rendered', () => {
    expect(areAllDiffFilesCollapsed([], collapsed([]))).toBe(false)
  })

  it('is false while any file is expanded', () => {
    expect(
      areAllDiffFilesCollapsed(['a.ts', 'b.ts'], collapsed(['a.ts']))
    ).toBe(false)
  })

  it('is true once every file is collapsed', () => {
    expect(
      areAllDiffFilesCollapsed(['a.ts', 'b.ts'], collapsed(['a.ts', 'b.ts']))
    ).toBe(true)
  })

  it('collapses every listed file without dropping other overrides', () => {
    const previous = new Map([
      ['a.ts', false],
      ['gone.ts', false],
    ])

    const next = withCollapseAll(previous, ['a.ts', 'b.ts'], true)

    expect(next.get('a.ts')).toBe(true)
    expect(next.get('b.ts')).toBe(true)
    expect(next.get('gone.ts')).toBe(false)
  })

  it('expands every listed file, overriding the size default', () => {
    const next = withCollapseAll(new Map([['big.ts', true]]), ['big.ts'], false)

    expect(next.get('big.ts')).toBe(false)
  })

  it('does not mutate the previous map', () => {
    const previous = new Map([['a.ts', false]])

    withCollapseAll(previous, ['a.ts'], true)

    expect(previous.get('a.ts')).toBe(false)
  })
})

describe('diff stat totals', () => {
  it('is zero for no changed files', () => {
    expect(sumDiffStats([])).toEqual({ added: 0, removed: 0 })
  })

  it('sums added and removed across files', () => {
    expect(
      sumDiffStats([
        { added: 3, removed: 1 },
        { added: 10, removed: 0 },
        { added: 0, removed: 7 },
      ])
    ).toEqual({ added: 13, removed: 8 })
  })
})
