/**
 * Naming a line to comment on without a pointer.
 *
 * The diff viewer's own route to a line is a press-and-drag on the gutter it
 * paints inside its shadow root, and it offers no keyboard equivalent: the
 * scroll container takes `tabIndex = -1`, lines are not focusable, and the
 * gutter affordance only exists for the line the pointer happens to be over.
 * A keyboard-only reader could therefore read every diff in the pane and
 * comment on none of it.
 *
 * So the pane offers a second, app-owned route — pick a file, type a line —
 * and this module is the part of it that can be wrong. Resolving a typed line
 * has exactly the same three failure modes a drag cannot have (no such file,
 * no such number, a line the diff does not show), and each one has to be said
 * out loud rather than swallowed, because there is no gutter highlight to show
 * the person what the app understood.
 *
 * The output is the same {@link DiffCommentAnchor} a drag produces, so
 * everything downstream — composer, storage, annotation — cannot tell the two
 * routes apart.
 */

import type { AnnotationSide, FileDiffMetadata, Hunk } from '@pierre/diffs'
import type { DiffCommentAnchor, DiffCommentSide } from './diff-comment-anchor'
import { formatDiffCommentAnchorLabel } from './diff-comment-anchor'
import { isDiffLineRendered } from './diff-comment-threads'

/** A file the viewer has parsed, and can therefore place a comment in. */
export interface CommentableDiffFile {
  readonly fileDiff: FileDiffMetadata
  readonly path: string
}

export interface DiffCommentLineRequest {
  readonly filePath: string
  /** Exactly as typed, so "12abc" is rejected rather than read as 12. */
  readonly line: string
  readonly side: DiffCommentSide
}

export type DiffCommentLineTarget =
  | { readonly anchor: DiffCommentAnchor; readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** Digits only, so "1e3" and "4.5" are refused rather than silently coerced. */
const WHOLE_NUMBER = /^\d+$/

const annotationSide = (side: DiffCommentSide): AnnotationSide =>
  side === 'deletions' ? 'deletions' : 'additions'

const hunkRange = (
  hunk: Hunk,
  side: DiffCommentSide
): readonly [number, number] | null => {
  const start = side === 'deletions' ? hunk.deletionStart : hunk.additionStart
  const count = side === 'deletions' ? hunk.deletionCount : hunk.additionCount
  return count > 0 ? [start, start + count - 1] : null
}

/**
 * The line numbers this side of the diff actually shows, as reading ranges.
 *
 * This is the hint that replaces the gutter: without it the only way to find a
 * commentable line is to guess, and a diff's line numbers are the file's, not
 * the hunk's, so guessing is hopeless.
 */
export const describeCommentableLines = (
  fileDiff: FileDiffMetadata,
  side: DiffCommentSide
): string => {
  const ranges = fileDiff.hunks
    .flatMap((hunk) => {
      const range = hunkRange(hunk, side)
      return range === null ? [] : [range]
    })
    .sort(([left], [right]) => left - right)

  return ranges
    .map(([start, end]) => (start === end ? `${start}` : `${start}–${end}`))
    .join(', ')
}

/**
 * Resolve a typed file-and-line into the anchor a comment is stored against.
 *
 * A range is deliberately not offered here. A drag expresses one by moving,
 * and asking for two numbers would double the failure modes for a case the
 * keyboard route exists to unblock rather than to match feature for feature;
 * a reply on the anchored line reads the same either way.
 */
export const resolveDiffCommentLineTarget = (
  files: readonly CommentableDiffFile[],
  request: DiffCommentLineRequest
): DiffCommentLineTarget => {
  const file = files.find((candidate) => candidate.path === request.filePath)
  if (file === undefined) {
    return { ok: false, reason: 'Pick a file with a rendered diff.' }
  }

  const trimmed = request.line.trim()
  const line = Number(trimmed)
  if (
    trimmed.length === 0 ||
    !(Number.isInteger(line) && line > 0 && WHOLE_NUMBER.test(trimmed))
  ) {
    return { ok: false, reason: 'Enter a line number.' }
  }

  if (!isDiffLineRendered(file.fileDiff, annotationSide(request.side), line)) {
    const available = describeCommentableLines(file.fileDiff, request.side)
    return {
      ok: false,
      reason:
        available.length === 0
          ? `This file has no ${request.side === 'deletions' ? 'removed' : 'added'} lines to comment on.`
          : `Line ${line} is not shown in this diff. Try ${available}.`,
    }
  }

  return {
    anchor: {
      endLine: line,
      filePath: file.path,
      label: formatDiffCommentAnchorLabel({
        endLine: line,
        filePath: file.path,
        side: request.side,
        startLine: line,
      }),
      side: request.side,
      startLine: line,
    },
    ok: true,
  }
}
