/**
 * Which lines the diff viewer is currently painting for one file, once the
 * unchanged context between hunks can be expanded.
 *
 * ## Why this module exists at all
 *
 * A patch says what changed. Everything a patch leaves out — the unchanged
 * lines between hunks — the viewer can fetch and expand into, and after that
 * the set of lines on screen is strictly larger than the set of lines the
 * hunks describe. Two parts of the pane need to agree on that set:
 *
 * - {@link partitionDiffCommentThreads} decides whether a stored review
 *   conversation has a row to sit under, or has to be listed as detached.
 * - The reader, who is looking straight at the line.
 *
 * Before expansion those two could never disagree, because `fileDiff.hunks`
 * was the whole answer. Expansion breaks that: `hydratePartialDiff` replaces
 * `hunks` but leaves every `additionStart`/`additionCount` exactly as it was,
 * and the expansion itself lives in `DiffHunksRenderer.expandedHunks`, which
 * is never written back to the metadata. So a pane that keeps asking the
 * hunks would insist a comment is "not in this diff" while the reader can see
 * its line — worse than the conservative behaviour it replaced.
 *
 * This module is the single place that knows the difference, so the coupling
 * to `@pierre/diffs` sits behind one named seam instead of leaking into the
 * pane and the thread partitioner.
 *
 * ## The supported route
 *
 * There is one, and it is used here rather than reaching into the renderer:
 *
 * - `CodeView.getRenderedItems()` is public and hands back each mounted
 *   item's `VirtualizedFileDiff`.
 * - `FileDiff.isLineRenderable(lineNumber)` is public and answers exactly
 *   "will this line have a row", computed from the same inputs as the
 *   library's own layout pass — hunks, the live expansion map, and any
 *   expansion still queued for the next frame.
 * - `FileDiff.fileDiff` is public, and is the object hydration mutates, so
 *   it is read instead of the controlled item snapshot the pane handed in.
 *
 * Two properties of that oracle are load-bearing and are pinned by
 * `test/diff-expansion.test.ts` against the installed version:
 *
 * 1. It answers `true` for **every** line of a *partial* diff, because a
 *    partial diff has no expansion model at all. That is the opposite of
 *    what this pane means, so a partial file is answered from its hunks and
 *    the oracle is not consulted.
 * 2. It answers `true` for lines past the end of the file, deliberately, so
 *    its callers keep their own missing-row handling. Lines outside the
 *    file's own line count are therefore rejected here first.
 *
 * ## Sides
 *
 * The oracle is addition-side only. A collapsed gap is pure unchanged
 * context, so its two sides advance one-for-one; {@link additionLineTwin}
 * converts a deletion-side line into the addition-side line sharing its row
 * using only hunk boundaries, and the answer for the pair is the same.
 */

import type {
  AnnotationSide,
  CodeView,
  FileDiffMetadata,
  Hunk,
  HunkExpansionRegion,
} from '@pierre/diffs'

// ---------------------------------------------------------------------------
// The answer, as data
// ---------------------------------------------------------------------------

/**
 * Lines rendered for one file that its hunks do not cover, as
 * `side:lineNumber`. Scoped to a file, because that is the unit the
 * partitioner and the viewer both work in.
 */
export type RenderedLineKeys = ReadonlySet<string>

export const renderedLineKey = (
  side: AnnotationSide,
  lineNumber: number
): string => `${side}:${lineNumber}`

/** One line the pane wants an answer about. */
export interface DiffLineProbe {
  readonly lineNumber: number
  readonly side: AnnotationSide
}

const NO_RENDERED_LINES: RenderedLineKeys = new Set<string>()

/**
 * A stable string for a whole answer, so the pane can tell a real change
 * from a re-render that answered the same thing and avoid a render loop.
 */
export const renderedLinesSignature = (
  byFile: ReadonlyMap<string, RenderedLineKeys>
): string =>
  [...byFile]
    .map(([filePath, keys]) => `${filePath}=${[...keys].sort().join(',')}`)
    .sort()
    .join('|')

// ---------------------------------------------------------------------------
// Pairing the two sides of an unchanged gap
// ---------------------------------------------------------------------------

/**
 * The one-based `[start, end)` line range a hunk covers on one side.
 *
 * Mirrors the library's `getHunkSideStartBoundary`: a hunk with no lines on
 * a side is anchored *after* its start line rather than on it.
 */
const sideRange = (start: number, count: number): readonly [number, number] => {
  const first = count === 0 ? start + 1 : start
  return [first, first + count]
}

const additionRange = (hunk: Hunk) =>
  sideRange(hunk.additionStart, hunk.additionCount)

const deletionRange = (hunk: Hunk) =>
  sideRange(hunk.deletionStart, hunk.deletionCount)

/**
 * The addition-side line sharing a row with a deletion-side line of
 * unchanged context, or `null` when there is no such row.
 *
 * A collapsed region is context: both files have those lines, in the same
 * order, so within one gap the two sides differ by a constant offset taken
 * from the hunk that bounds the gap. A deletion line *inside* a hunk is not
 * context and gets `null` — the hunk-based check has already answered it.
 */
export const additionLineTwin = (
  fileDiff: FileDiffMetadata,
  deletionLine: number
): number | null => {
  for (const hunk of fileDiff.hunks) {
    const [deletionStart, deletionEnd] = deletionRange(hunk)
    if (deletionLine < deletionStart) {
      const [additionStart] = additionRange(hunk)
      return deletionLine + (additionStart - deletionStart)
    }
    if (deletionLine < deletionEnd) {
      return null
    }
  }

  const lastHunk = fileDiff.hunks.at(-1)
  if (lastHunk === undefined) {
    return null
  }
  const [, deletionEnd] = deletionRange(lastHunk)
  const [, additionEnd] = additionRange(lastHunk)
  return deletionLine + (additionEnd - deletionEnd)
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

/**
 * The narrow view this module takes of a mounted file: the library's public
 * "will this line have a row" question, plus the metadata object hydration
 * mutates in place.
 */
export interface DiffLineRenderOracle {
  readonly fileDiff?: FileDiffMetadata | undefined
  isLineRenderable(lineNumber: number): boolean
}

/** A line number the file actually has on the given side. */
const isWithinFile = (
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  lineNumber: number
): boolean => {
  const total =
    side === 'deletions'
      ? fileDiff.deletionLines.length
      : fileDiff.additionLines.length
  return lineNumber >= 1 && lineNumber <= total
}

/**
 * Ask the viewer which of these lines it is painting, given the expansion
 * the reader has performed.
 *
 * Returns nothing for a partial diff: the oracle has no expansion model
 * there and would say yes to everything, which the pane would read as "every
 * comment is attached". A partial file keeps being answered by its hunks.
 */
export const probeExpandedLines = (
  fileDiff: FileDiffMetadata,
  oracle: DiffLineRenderOracle,
  probes: readonly DiffLineProbe[]
): RenderedLineKeys => {
  if (fileDiff.isPartial || probes.length === 0) {
    return NO_RENDERED_LINES
  }

  const rendered = new Set<string>()
  for (const probe of probes) {
    if (!isWithinFile(fileDiff, probe.side, probe.lineNumber)) {
      continue
    }
    const additionLine =
      probe.side === 'deletions'
        ? additionLineTwin(fileDiff, probe.lineNumber)
        : probe.lineNumber
    if (additionLine === null) {
      continue
    }
    if (oracle.isLineRenderable(additionLine)) {
      rendered.add(renderedLineKey(probe.side, probe.lineNumber))
    }
  }
  return rendered
}

/**
 * Read the answer for every mounted file the pane asked about.
 *
 * Only mounted items can answer: the viewer virtualizes, and a file scrolled
 * far out of the window has no live instance. That is the honest reading —
 * expansion state belongs to the instance, so a file with no instance has no
 * expansion — and it degrades to the hunk-only answer rather than guessing.
 */
export const readExpandedRenderedLines = <LAnnotation>(
  viewer: CodeView<LAnnotation> | undefined,
  probesByFile: ReadonlyMap<string, readonly DiffLineProbe[]>
): ReadonlyMap<string, RenderedLineKeys> => {
  const byFile = new Map<string, RenderedLineKeys>()
  if (viewer === undefined || probesByFile.size === 0) {
    return byFile
  }

  for (const item of viewer.getRenderedItems()) {
    if (item.type !== 'diff') {
      continue
    }
    const probes = probesByFile.get(item.id)
    // `instance.fileDiff` rather than `item.item.fileDiff`: hydration swaps
    // the instance's metadata object, and the controlled snapshot the pane
    // handed in stays partial forever.
    const fileDiff = item.instance.fileDiff
    if (probes === undefined || probes.length === 0 || fileDiff === undefined) {
      continue
    }
    const rendered = probeExpandedLines(fileDiff, item.instance, probes)
    if (rendered.size > 0) {
      byFile.set(item.id, rendered)
    }
  }

  return byFile
}

// ---------------------------------------------------------------------------
// Pinning the library behaviour this module rests on
// ---------------------------------------------------------------------------

/**
 * Stand in for a mounted `FileDiff` so the contract test can exercise the
 * library's own visibility oracle against a chosen expansion state without a
 * DOM, a worker, or a highlighter.
 *
 * This is the one place that knows `FileDiff.isLineRenderable` reads
 * `fileDiffCache`, `options`, and `hunksRenderer.getExpandedHunksMap()`.
 * Nothing in the running app uses it — it exists so a version bump that
 * moves any of that fails one named test with a sentence saying so, instead
 * of quietly misplacing review comments.
 *
 * @param fileDiffPrototype `FileDiff.prototype` from `@pierre/diffs`.
 */
export const asDiffLineRenderOracle = (
  fileDiffPrototype: object,
  fileDiff: FileDiffMetadata,
  expandedHunks: ReadonlyMap<number, HunkExpansionRegion>
): DiffLineRenderOracle => {
  const stub = Object.create(fileDiffPrototype) as Record<string, unknown> &
    DiffLineRenderOracle
  Object.assign(stub, {
    fileDiff,
    hunksRenderer: {
      diffCache: fileDiff,
      getExpandedHunksMap: () => expandedHunks,
    },
    options: {},
  })
  return stub
}
