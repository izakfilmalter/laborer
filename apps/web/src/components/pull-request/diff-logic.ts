/**
 * Pure diff placement logic for the Code tab, ported from t3code's
 * `pullRequestDiff.logic.ts`, plus the review-position resolver Laborer
 * needs to turn a selected viewer line into the coordinates
 * `pullRequest.submitReview` takes.
 */

import type {
  PullRequestDiffSide,
  PullRequestReviewPosition,
} from '@laborer/shared/rpc'
import type { FileDiffMetadata, SelectionSide } from '@pierre/diffs'

/**
 * Whether a conversation's line is really in this file's hunks. A thread
 * naming a file is not the same as a thread the diff can show: its line
 * may have moved out of the change, or sit in a hunk GitHub withheld.
 */
export function isLineInFileDiff(
  file: FileDiffMetadata,
  side: PullRequestDiffSide,
  line: number
): boolean {
  return file.hunks.some((hunk) =>
    side === 'left'
      ? line >= hunk.deletionStart &&
        line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart &&
        line < hunk.additionStart + hunk.additionCount
  )
}

/** What the toolbar last asked of every file at once; null is nothing yet. */
export type DiffFoldOverride = 'expanded' | 'folded' | null

/**
 * Whether a file is drawn folded. The reader's own choices are kept as the
 * difference from what the toolbar last said, so a file that has not
 * loaded yet cannot land expanded moments after the reader folded
 * everything. Folded is the starting point whatever the change's size.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>
): boolean {
  const foldedByDefault = foldOverride !== 'expanded'
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault
}

/** The line and side a review position pins to in the viewer. */
export function getReviewPositionAnchor(position: PullRequestReviewPosition): {
  line: number
  side: PullRequestDiffSide
} {
  switch (position.kind) {
    case 'added':
      return { line: position.newLine, side: 'right' }
    case 'deleted':
      return { line: position.oldLine, side: 'left' }
    case 'context':
      return {
        line: position.side === 'left' ? position.oldLine : position.newLine,
        side: position.side,
      }
    default:
      return position satisfies never
  }
}

/**
 * Resolve the host-facing coordinates of a line selected in the diff
 * viewer: which kind of line it is (added, deleted, or unchanged) and its
 * numbers on both sides where both exist. Null for a line outside every
 * rendered hunk — there is no row there to comment on.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one walk over the hunk segments, ported from t3code's position resolver.
export function resolvePullRequestReviewPosition(
  file: FileDiffMetadata,
  lineNumber: number,
  side: SelectionSide | undefined
): PullRequestReviewPosition | null {
  const wantsLeft = side === 'deletions'
  for (const hunk of file.hunks) {
    let oldLine = hunk.deletionStart
    let newLine = hunk.additionStart
    for (const segment of hunk.hunkContent) {
      if (segment.type === 'context') {
        const offset = wantsLeft ? lineNumber - oldLine : lineNumber - newLine
        if (offset >= 0 && offset < segment.lines) {
          return {
            kind: 'context',
            oldLine: oldLine + offset,
            newLine: newLine + offset,
            side: wantsLeft ? 'left' : 'right',
          }
        }
        oldLine += segment.lines
        newLine += segment.lines
        continue
      }
      if (
        wantsLeft &&
        lineNumber >= oldLine &&
        lineNumber < oldLine + segment.deletions
      ) {
        return { kind: 'deleted', oldLine: lineNumber }
      }
      oldLine += segment.deletions
      if (
        !wantsLeft &&
        lineNumber >= newLine &&
        lineNumber < newLine + segment.additions
      ) {
        return { kind: 'added', newLine: lineNumber }
      }
      newLine += segment.additions
    }
  }
  return null
}
