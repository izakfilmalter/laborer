import type { FileDiffMetadata } from '@pierre/diffs'
import { describe, expect, it } from 'vitest'
import {
  getReviewPositionAnchor,
  isFileDiffCollapsed,
  isLineInFileDiff,
  resolvePullRequestReviewPosition,
} from '@/components/pull-request/diff-logic'

/** Only the hunk ranges matter here; the viewer fills the rest in when it renders. */
function fileWithHunks(
  hunks: readonly {
    deletionStart: number
    deletionCount: number
    additionStart: number
    additionCount: number
    hunkContent?: readonly (
      | { type: 'context'; lines: number }
      | { type: 'change'; deletions: number; additions: number }
    )[]
  }[]
): FileDiffMetadata {
  return { name: 'src/app.ts', hunks } as unknown as FileDiffMetadata
}

describe('isLineInFileDiff', () => {
  const file = fileWithHunks([
    {
      deletionStart: 10,
      deletionCount: 3,
      additionStart: 10,
      additionCount: 5,
    },
    {
      deletionStart: 40,
      deletionCount: 0,
      additionStart: 42,
      additionCount: 2,
    },
  ])

  it('places a line inside a hunk, on the side that hunk counts', () => {
    expect(isLineInFileDiff(file, 'right', 12)).toBe(true)
    expect(isLineInFileDiff(file, 'left', 11)).toBe(true)
  })

  it('includes the first line of a hunk and excludes the one past its last', () => {
    // The boundaries are where an off-by-one would quietly move a
    // conversation between lists.
    expect(isLineInFileDiff(file, 'right', 10)).toBe(true)
    expect(isLineInFileDiff(file, 'right', 14)).toBe(true)
    expect(isLineInFileDiff(file, 'right', 15)).toBe(false)
    expect(isLineInFileDiff(file, 'left', 9)).toBe(false)
    expect(isLineInFileDiff(file, 'left', 12)).toBe(true)
    expect(isLineInFileDiff(file, 'left', 13)).toBe(false)
  })

  it('keeps the two sides apart, since one line number means two lines', () => {
    // The second hunk is a pure insertion: nothing is on its left.
    expect(isLineInFileDiff(file, 'right', 43)).toBe(true)
    expect(isLineInFileDiff(file, 'left', 40)).toBe(false)
  })

  it('places nothing in a file whose hunks the host withheld', () => {
    expect(isLineInFileDiff(fileWithHunks([]), 'right', 1)).toBe(false)
  })
})

describe('isFileDiffCollapsed', () => {
  const NO_TOGGLES: ReadonlySet<string> = new Set()

  it('folds every file before the reader has touched anything', () => {
    expect(isFileDiffCollapsed('a.ts', null, NO_TOGGLES)).toBe(true)
  })

  it('opens every file once the toolbar has asked for it', () => {
    expect(isFileDiffCollapsed('a.ts', 'expanded', NO_TOGGLES)).toBe(false)
  })

  it('keeps a file the reader opened open as the next slice arrives', () => {
    const toggled = new Set(['b.ts'])
    expect(isFileDiffCollapsed('b.ts', null, toggled)).toBe(false)
    expect(isFileDiffCollapsed('c.ts', null, toggled)).toBe(true)
  })

  it('still answers to a toggle after either toolbar press', () => {
    expect(isFileDiffCollapsed('a.ts', 'expanded', new Set(['a.ts']))).toBe(
      true
    )
    expect(isFileDiffCollapsed('a.ts', 'folded', new Set(['a.ts']))).toBe(false)
  })
})

describe('resolvePullRequestReviewPosition', () => {
  // One hunk: 2 context lines, then 1 deleted + 2 added, then 1 context.
  const file = fileWithHunks([
    {
      deletionStart: 10,
      deletionCount: 4,
      additionStart: 10,
      additionCount: 5,
      hunkContent: [
        { type: 'context', lines: 2 },
        { type: 'change', deletions: 1, additions: 2 },
        { type: 'context', lines: 1 },
      ],
    },
  ])

  it('names an added line by its new-file number', () => {
    expect(resolvePullRequestReviewPosition(file, 12, 'additions')).toEqual({
      kind: 'added',
      newLine: 12,
    })
    expect(resolvePullRequestReviewPosition(file, 13, 'additions')).toEqual({
      kind: 'added',
      newLine: 13,
    })
  })

  it('names a deleted line by its old-file number', () => {
    expect(resolvePullRequestReviewPosition(file, 12, 'deletions')).toEqual({
      kind: 'deleted',
      oldLine: 12,
    })
  })

  it('names an unchanged line on both sides, keeping the selected side', () => {
    expect(resolvePullRequestReviewPosition(file, 10, 'additions')).toEqual({
      kind: 'context',
      oldLine: 10,
      newLine: 10,
      side: 'right',
    })
    expect(resolvePullRequestReviewPosition(file, 11, 'deletions')).toEqual({
      kind: 'context',
      oldLine: 11,
      newLine: 11,
      side: 'left',
    })
  })

  it('walks the trailing context with both counters moved past the change', () => {
    // After 2 context (old 10-11 / new 10-11), 1 deletion (old 12) and 2
    // additions (new 12-13), the trailing context line is old 13 / new 14.
    expect(resolvePullRequestReviewPosition(file, 14, 'additions')).toEqual({
      kind: 'context',
      oldLine: 13,
      newLine: 14,
      side: 'right',
    })
  })

  it('returns null for a line outside every rendered hunk', () => {
    expect(resolvePullRequestReviewPosition(file, 99, 'additions')).toBeNull()
    expect(resolvePullRequestReviewPosition(file, 1, 'deletions')).toBeNull()
  })

  it('defaults an unsided selection to the new file', () => {
    expect(resolvePullRequestReviewPosition(file, 12, undefined)).toEqual({
      kind: 'added',
      newLine: 12,
    })
  })
})

describe('getReviewPositionAnchor', () => {
  it('pins each position kind to the line and side the viewer draws', () => {
    expect(getReviewPositionAnchor({ kind: 'added', newLine: 5 })).toEqual({
      line: 5,
      side: 'right',
    })
    expect(getReviewPositionAnchor({ kind: 'deleted', oldLine: 7 })).toEqual({
      line: 7,
      side: 'left',
    })
    expect(
      getReviewPositionAnchor({
        kind: 'context',
        oldLine: 3,
        newLine: 4,
        side: 'left',
      })
    ).toEqual({ line: 3, side: 'left' })
  })
})
