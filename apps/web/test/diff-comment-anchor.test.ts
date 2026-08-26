import type { SelectedLineRange } from '@pierre/diffs'
import { describe, expect, it } from 'vitest'
import {
  formatDiffCommentAnchorLabel,
  resolveDiffCommentAnchor,
} from '@/lib/diff-comment-anchor'

describe('resolveDiffCommentAnchor', () => {
  it('carries a multi-line addition range through unchanged', () => {
    expect(
      resolveDiffCommentAnchor('added.ts', {
        start: 12,
        end: 18,
        side: 'additions',
      })
    ).toEqual({
      filePath: 'added.ts',
      side: 'additions',
      startLine: 12,
      endLine: 18,
      label: 'added.ts:12-18',
    })
  })

  it('orders a range dragged upward low to high', () => {
    // The viewer reports `start` as the point the drag began, so an
    // upward drag arrives backwards.
    expect(
      resolveDiffCommentAnchor('src/app.tsx', {
        start: 40,
        end: 31,
        side: 'additions',
      })
    ).toMatchObject({ startLine: 31, endLine: 40, label: 'src/app.tsx:31-40' })
  })

  it('defaults an unsided range to the addition side', () => {
    expect(resolveDiffCommentAnchor('README.md', { start: 3, end: 3 })).toEqual(
      {
        filePath: 'README.md',
        side: 'additions',
        startLine: 3,
        endLine: 3,
        label: 'README.md:3',
      }
    )
  })

  it('keeps deletion-side line numbers on the deletion side', () => {
    expect(
      resolveDiffCommentAnchor('src/old.ts', {
        start: 7,
        end: 9,
        side: 'deletions',
      })
    ).toEqual({
      filePath: 'src/old.ts',
      side: 'deletions',
      startLine: 7,
      endLine: 9,
      label: 'src/old.ts:7-9 (original)',
    })
  })

  it('collapses a range that crosses sides onto the line it ended on', () => {
    // The two ends are numbered against two different files, so there is
    // no honest pair of line numbers spanning them. The end wins because
    // that is the line the viewer anchors its gutter affordance to.
    expect(
      resolveDiffCommentAnchor('src/app.tsx', {
        start: 20,
        end: 24,
        side: 'deletions',
        endSide: 'additions',
      })
    ).toEqual({
      filePath: 'src/app.tsx',
      side: 'additions',
      startLine: 24,
      endLine: 24,
      label: 'src/app.tsx:24',
    })
  })

  it('applies the same collapse to a cross-side drag that went upward', () => {
    expect(
      resolveDiffCommentAnchor('src/app.tsx', {
        start: 30,
        end: 12,
        side: 'additions',
        endSide: 'deletions',
      })
    ).toMatchObject({
      side: 'deletions',
      startLine: 12,
      endLine: 12,
    })
  })

  it('refuses a selection that cannot name a line', () => {
    const unusable: readonly SelectedLineRange[] = [
      { start: 0, end: 4 },
      { start: 4, end: 0 },
      { start: -2, end: -1 },
      { start: 1.5, end: 4 },
      { start: Number.NaN, end: 4 },
    ]
    for (const range of unusable) {
      expect(resolveDiffCommentAnchor('added.ts', range)).toBeNull()
    }
  })

  it('refuses a selection with no file to attach to', () => {
    expect(
      resolveDiffCommentAnchor('', { start: 1, end: 2, side: 'additions' })
    ).toBeNull()
  })
})

describe('formatDiffCommentAnchorLabel', () => {
  it('prints one number for a single-line anchor', () => {
    expect(
      formatDiffCommentAnchorLabel({
        filePath: 'added.ts',
        side: 'additions',
        startLine: 12,
        endLine: 12,
      })
    ).toBe('added.ts:12')
  })

  it('prints a range for a multi-line anchor', () => {
    expect(
      formatDiffCommentAnchorLabel({
        filePath: 'added.ts',
        side: 'additions',
        startLine: 12,
        endLine: 18,
      })
    ).toBe('added.ts:12-18')
  })

  it('marks deletion-side anchors so the numbers are not ambiguous', () => {
    // `added.ts:12` on either side would otherwise name two different
    // lines with the same text.
    expect(
      formatDiffCommentAnchorLabel({
        filePath: 'added.ts',
        side: 'deletions',
        startLine: 12,
        endLine: 18,
      })
    ).toBe('added.ts:12-18 (original)')
  })

  it('keeps the whole path, so two files with the same name stay apart', () => {
    expect(
      formatDiffCommentAnchorLabel({
        filePath: 'packages/server/src/index.ts',
        side: 'additions',
        startLine: 4,
        endLine: 4,
      })
    ).toBe('packages/server/src/index.ts:4')
  })
})
