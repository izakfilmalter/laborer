/**
 * Turning a line selection in the diff viewer into the anchor a comment
 * is stored against.
 *
 * `@pierre/diffs` reports a selection as a {@link SelectedLineRange}: two
 * line numbers plus the side of the diff each end was taken from. That
 * shape is a *view* coordinate — it is ordered by drag direction, its
 * sides are optional, and it says nothing about which file it belongs
 * to. A stored comment needs the opposite: one normalized, file-scoped,
 * human-readable record that still means the same thing after the pane
 * re-renders, the file is collapsed, or the app restarts.
 *
 * {@link DiffCommentAnchor} is that record, and it is the contract the
 * persistence slice writes. Modeled on t3code's `reviewCommentContext`,
 * trimmed to what this app's data actually supports: t3code additionally
 * resolves a flat row index and an excerpt of the patch, both of which
 * need the parsed `FileDiffMetadata` at hand and both of which go stale
 * the moment the underlying file changes. Line numbers plus a side are
 * the part that survives.
 *
 * The vocabulary matches GitHub's review-comment coordinates — `path`,
 * `side`, `start_line`, `line` — so the anchor can be handed to a host
 * later without another translation.
 */

import type { SelectedLineRange, SelectionSide } from '@pierre/diffs'

/**
 * Which side of the diff a line number is counted against.
 *
 * `additions` numbers lines in the file as it is now (the right-hand
 * column of a split diff); `deletions` numbers them in the file as it
 * was. Named after the viewer's own `SelectionSide` so the two never
 * drift apart.
 */
export type DiffCommentSide = SelectionSide

/**
 * Where a comment is attached. Everything here is durable: no DOM node,
 * no parsed patch, no render-pass index.
 *
 * @property filePath - Repository-relative path, the same string the
 *   viewer uses as its item id.
 * @property side - Which numbering `startLine` and `endLine` belong to.
 * @property startLine - First line of the range, 1-based and inclusive.
 * @property endLine - Last line of the range, 1-based and inclusive.
 *   Equal to `startLine` for a single-line comment.
 * @property label - Pre-rendered `path:start-end` text for the composer
 *   and for anywhere a comment is listed. Stored rather than derived so
 *   an anchor stays readable even once its file no longer parses.
 */
export interface DiffCommentAnchor {
  readonly endLine: number
  readonly filePath: string
  readonly label: string
  readonly side: DiffCommentSide
  readonly startLine: number
}

/** The side the viewer numbers a line against when it does not say. */
const DEFAULT_SIDE: DiffCommentSide = 'additions'

const isLineNumber = (value: number): boolean =>
  Number.isInteger(value) && value > 0

/**
 * Render an anchor the way a reader would say it out loud: the path,
 * then the lines. A single-line anchor prints one number.
 *
 * Deletion-side ranges are numbered against the *original* file, so they
 * carry that word — without it, `src/a.ts:12` would name two different
 * lines depending on a side the label never showed.
 */
export const formatDiffCommentAnchorLabel = (
  anchor: Omit<DiffCommentAnchor, 'label'>
): string => {
  const lines =
    anchor.startLine === anchor.endLine
      ? `${anchor.startLine}`
      : `${anchor.startLine}-${anchor.endLine}`
  const location = `${anchor.filePath}:${lines}`
  return anchor.side === 'deletions' ? `${location} (original)` : location
}

/**
 * Resolve a viewer selection into the anchor a comment is stored
 * against, or `null` when the selection cannot name a line.
 *
 * Three things are normalized here:
 *
 * 1. **Direction.** A range dragged upward arrives with `start` after
 *    `end`; the anchor is always ordered low to high.
 * 2. **Side.** `side` is the side of `start` and is omitted when the
 *    viewer has no opinion; `endSide` only appears when it *differs*
 *    from `side`.
 * 3. **Cross-side ranges.** A drag that crosses from a deleted line to
 *    an added one has its two ends numbered against two different files,
 *    so there is no honest single pair of line numbers to store. Rather
 *    than invent one, the anchor keeps the end the drag finished on — the
 *    line the viewer itself anchors its gutter affordance to — as a
 *    single-line anchor. Widening this to a two-sided anchor is a
 *    deliberate later decision, not an accident of this function.
 */
export const resolveDiffCommentAnchor = (
  filePath: string,
  range: SelectedLineRange
): DiffCommentAnchor | null => {
  if (filePath.length === 0) {
    return null
  }
  if (!(isLineNumber(range.start) && isLineNumber(range.end))) {
    return null
  }

  const startSide = range.side ?? DEFAULT_SIDE
  const endSide = range.endSide ?? startSide
  const crossesSides = startSide !== endSide

  const side = endSide
  const startLine = crossesSides ? range.end : Math.min(range.start, range.end)
  const endLine = crossesSides ? range.end : Math.max(range.start, range.end)

  return {
    filePath,
    side,
    startLine,
    endLine,
    label: formatDiffCommentAnchorLabel({ filePath, side, startLine, endLine }),
  }
}
