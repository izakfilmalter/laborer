/**
 * Turning stored review conversations into the annotations the diff viewer
 * paints under a line.
 *
 * `@pierre/diffs` takes annotations per file item as
 * {@link DiffLineAnnotation}s: a side, a line number, and whatever metadata the
 * app wants to render there. It renders at most one node per (side, line), so
 * several conversations anchored to the same line have to arrive as one
 * annotation carrying a group — hence {@link DiffCommentAnnotationGroup}.
 *
 * A thread is anchored to a *range*; the annotation is placed under its last
 * line, which is where the viewer already parks the gutter affordance a
 * comment is started from, so a comment appears where the reader last looked.
 *
 * ## Line drift
 *
 * Nothing here re-anchors a thread when the file changes under it. A thread's
 * line numbers are exactly what was stored, so once the diff is refetched and
 * that line no longer exists in any hunk, the viewer has no slot to paint into
 * and the annotation would silently vanish. {@link partitionDiffCommentThreads}
 * exists so it cannot: it separates threads whose anchor is still rendered
 * from threads whose anchor is not, and the pane lists the second group
 * separately rather than dropping it. Server-side re-anchoring is a later
 * decision; this is what honesty costs until then.
 *
 * ## Expanded context
 *
 * A hunk is not the whole of what the viewer paints once the reader expands
 * the unchanged context between hunks, and expansion does not touch
 * `hunks[].additionStart`/`additionCount` — so the hunks alone would keep
 * calling a thread detached while its line is on screen. Every function here
 * that asks "is this line rendered" therefore takes an optional set of extra
 * rendered lines, supplied by `@/lib/diff-expansion`, which owns the one
 * coupling to the viewer's live expansion state. Omitting it is the
 * conservative hunks-only answer, which is correct for a file nobody has
 * expanded.
 */

import type { ReviewCommentThread } from '@laborer/shared/rpc'
import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileDiffMetadata,
  Hunk,
} from '@pierre/diffs'
import type { DiffCommentAnchor } from './diff-comment-anchor'
import { formatDiffCommentAnchorLabel } from './diff-comment-anchor'
import type { DiffLineProbe, RenderedLineKeys } from './diff-expansion'
import { renderedLineKey } from './diff-expansion'

/** Several conversations can share one line; the viewer gets one node. */
export interface DiffCommentAnnotationGroup {
  /** Pre-rendered `path:start-end` text for the whole group's anchor. */
  readonly label: string
  readonly threads: readonly ReviewCommentThread[]
}

export type DiffCommentAnnotation =
  DiffLineAnnotation<DiffCommentAnnotationGroup>

/**
 * Threads oldest first, tie-broken by id so two threads written in the same
 * millisecond keep a stable order across renders.
 */
export const orderDiffCommentThreads = (
  threads: readonly ReviewCommentThread[]
): readonly ReviewCommentThread[] =>
  [...threads].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )

export interface DiffCommentThreadFilter {
  readonly includeResolved: boolean
  readonly workspaceId: string
}

/**
 * The threads this pane is responsible for. The shared stream carries every
 * workspace's conversations, so the workspace filter is not optional; the
 * resolved filter is the user's choice.
 *
 * A resolved thread is evidence of what was asked, so hiding it is a view
 * setting rather than a deletion.
 */
export const selectDiffCommentThreads = (
  threads: readonly ReviewCommentThread[],
  filter: DiffCommentThreadFilter
): readonly ReviewCommentThread[] =>
  orderDiffCommentThreads(
    threads.filter(
      (thread) =>
        thread.workspaceId === filter.workspaceId &&
        (filter.includeResolved || thread.status === 'open')
    )
  )

/** Line numbers a hunk actually paints for one side of the diff. */
const hunkCoversLine = (
  hunk: Hunk,
  side: AnnotationSide,
  lineNumber: number
): boolean => {
  const start = side === 'deletions' ? hunk.deletionStart : hunk.additionStart
  const count = side === 'deletions' ? hunk.deletionCount : hunk.additionCount
  return lineNumber >= start && lineNumber < start + count
}

/**
 * Whether the viewer will have a row — and therefore an annotation slot — for
 * this line. Lines outside every hunk are collapsed context the viewer does
 * not render *until the reader expands it*, which is what `expandedLines`
 * carries: the lines the live viewer reports it is painting beyond its hunks.
 */
export const isDiffLineRendered = (
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  lineNumber: number,
  expandedLines?: RenderedLineKeys | undefined
): boolean =>
  fileDiff.hunks.some((hunk) => hunkCoversLine(hunk, side, lineNumber)) ||
  expandedLines?.has(renderedLineKey(side, lineNumber)) === true

const annotationSide = (thread: ReviewCommentThread): AnnotationSide =>
  thread.side === 'deletions' ? 'deletions' : 'additions'

/**
 * Group threads for one file into viewer annotations, one per (side, line).
 *
 * Groups come back ordered by line then side so the array is stable, which
 * matters because {@link diffCommentAnnotationsVersion} hashes it to decide
 * whether the viewer needs to re-read the item.
 */
export const groupDiffCommentThreads = (
  threads: readonly ReviewCommentThread[]
): readonly DiffCommentAnnotation[] => {
  const groups = new Map<string, ReviewCommentThread[]>()
  for (const thread of orderDiffCommentThreads(threads)) {
    const key = `${annotationSide(thread)}:${thread.endLine}`
    const existing = groups.get(key)
    if (existing) {
      existing.push(thread)
    } else {
      groups.set(key, [thread])
    }
  }

  return [...groups.values()]
    .map((grouped) => {
      // Every thread in a group shares the anchoring line; the label names the
      // widest range they cover, so a group reads as one place in the file.
      const first = grouped[0] as ReviewCommentThread
      const side = annotationSide(first)
      return {
        lineNumber: first.endLine,
        metadata: {
          label: formatDiffCommentAnchorLabel({
            endLine: first.endLine,
            filePath: first.filePath,
            side: first.side,
            startLine: grouped.reduce(
              (lowest, thread) => Math.min(lowest, thread.startLine),
              first.startLine
            ),
          }),
          threads: grouped,
        },
        side,
      } satisfies DiffCommentAnnotation
    })
    .sort(
      (left, right) =>
        left.lineNumber - right.lineNumber ||
        left.side.localeCompare(right.side)
    )
}

export interface PartitionedDiffCommentThreads {
  /** Annotations the viewer has a line to paint under. */
  readonly annotations: readonly DiffCommentAnnotation[]
  /**
   * Threads whose anchor line is not in the current diff — the file stopped
   * changing there, or the change moved. Listed by the pane rather than
   * dropped, because a comment nobody can see is worse than one out of place.
   */
  readonly detached: readonly ReviewCommentThread[]
}

/**
 * Split a file's threads into the ones the viewer can place and the ones it
 * cannot, given the diff as it currently parses and whatever unchanged
 * context the reader has expanded into view.
 *
 * Expansion moves threads the other way for once: a thread that was detached
 * because its line sat in a collapsed region re-attaches the moment that
 * region is painted, and leaves the detached list on the same pass.
 */
export const partitionDiffCommentThreads = (
  fileDiff: FileDiffMetadata,
  threads: readonly ReviewCommentThread[],
  expandedLines?: RenderedLineKeys | undefined
): PartitionedDiffCommentThreads => {
  const placeable: ReviewCommentThread[] = []
  const detached: ReviewCommentThread[] = []
  for (const thread of orderDiffCommentThreads(threads)) {
    if (
      isDiffLineRendered(
        fileDiff,
        annotationSide(thread),
        thread.endLine,
        expandedLines
      )
    ) {
      placeable.push(thread)
    } else {
      detached.push(thread)
    }
  }
  return { annotations: groupDiffCommentThreads(placeable), detached }
}

/**
 * The lines worth asking the viewer about for one file.
 *
 * Only threads the hunks cannot place can be changed by expansion, so this is
 * the whole of what the pane has to probe each time a file re-renders —
 * usually nothing, which is what keeps the probe off the render hot path.
 */
export const detachedLineProbes = (
  fileDiff: FileDiffMetadata,
  threads: readonly ReviewCommentThread[]
): readonly DiffLineProbe[] => {
  const seen = new Set<string>()
  const probes: DiffLineProbe[] = []
  for (const thread of threads) {
    const side = annotationSide(thread)
    const key = renderedLineKey(side, thread.endLine)
    if (seen.has(key) || isDiffLineRendered(fileDiff, side, thread.endLine)) {
      continue
    }
    seen.add(key)
    probes.push({ lineNumber: thread.endLine, side })
  }
  return probes
}

/**
 * Threads whose *file* is not in this diff at all.
 *
 * {@link partitionDiffCommentThreads} answers "is there a line for this?"
 * and can only be asked about a file the diff contains. A thread on a file
 * the diff does not mention never reaches it, which used to mean it simply
 * disappeared — and that is no longer a rare edge now that the pane can
 * change what "this diff" means: a comment left on a committed file is
 * invisible in the working-tree diff, and vice versa. These are collected
 * so the detached list can carry them too.
 *
 * Ordered by path, then by the usual thread order, so the list is stable
 * across renders.
 */
export const threadsOutsideDiff = (
  threadsByFile: ReadonlyMap<string, readonly ReviewCommentThread[]>,
  filesInDiff: ReadonlySet<string>
): readonly ReviewCommentThread[] =>
  [...threadsByFile.keys()]
    .filter((filePath) => !filesInDiff.has(filePath))
    .sort((left, right) => left.localeCompare(right))
    .flatMap((filePath) =>
      orderDiffCommentThreads(threadsByFile.get(filePath) ?? [])
    )

/**
 * Make room for a composer that has nothing stored behind it yet.
 *
 * A brand-new comment has no thread, so the viewer would have no annotation
 * slot on that line to paint the composer into. This adds an empty group at
 * the anchor when one is not already there, and leaves an existing group
 * alone so the composer opens underneath the conversation it is joining.
 */
export const withDraftDiffCommentAnnotation = (
  annotations: readonly DiffCommentAnnotation[],
  anchor: DiffCommentAnchor
): readonly DiffCommentAnnotation[] => {
  const side: AnnotationSide =
    anchor.side === 'deletions' ? 'deletions' : 'additions'
  const exists = annotations.some(
    (annotation) =>
      annotation.side === side && annotation.lineNumber === anchor.endLine
  )
  if (exists) {
    return annotations
  }
  return [
    ...annotations,
    {
      lineNumber: anchor.endLine,
      metadata: { label: anchor.label, threads: [] },
      side,
    },
  ].sort(
    (left, right) =>
      left.lineNumber - right.lineNumber || left.side.localeCompare(right.side)
  )
}

/**
 * A content key for the viewer's `version` field.
 *
 * The viewer only re-reads an item whose version changed, so this has to cover
 * everything an annotation renders: which threads, in which order, with which
 * replies and status. An agent reply arriving over the shared stream changes
 * nothing else about the item.
 */
export const diffCommentAnnotationsVersion = (
  annotations: readonly DiffCommentAnnotation[]
): string =>
  annotations
    .map((annotation) => {
      // The placement is part of the key even with no threads behind it, so
      // opening a composer on an untouched line still changes the version.
      const threads = annotation.metadata.threads
        .map(
          (thread) =>
            `${thread.id}~${thread.status}~${thread.revision}~${thread.replies
              .map(
                (reply) => `${reply.id}.${reply.author}.${reply.body.length}`
              )
              .join(',')}`
        )
        .join(';')
      return `${annotation.side}:${annotation.lineNumber}=${threads}`
    })
    .join('|')
