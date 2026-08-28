import type { ReviewCommentThread } from '@laborer/shared/rpc'
import type { LineAnnotation } from '@pierre/diffs'
import type { DiffCommentDraft } from '@/hooks/use-diff-review-comments'
import { formatDiffCommentAnchorLabel } from '@/lib/diff-comment-anchor'
import type { DiffCommentAnnotationGroup } from '@/lib/diff-comment-threads'

export function fileCommentAnnotations(
  relativePath: string,
  threads: readonly ReviewCommentThread[],
  draft: DiffCommentDraft | null
): LineAnnotation<DiffCommentAnnotationGroup>[] {
  const grouped = new Map<number, ReviewCommentThread[]>()
  for (const thread of threads) {
    const entries = grouped.get(thread.endLine)
    if (entries) {
      entries.push(thread)
    } else {
      grouped.set(thread.endLine, [thread])
    }
  }
  if (draft && !grouped.has(draft.anchor.endLine)) {
    grouped.set(draft.anchor.endLine, [])
  }
  return [...grouped].map(([lineNumber, entries]) => ({
    lineNumber,
    metadata: {
      label: entries[0]
        ? formatDiffCommentAnchorLabel(entries[0])
        : (draft?.anchor.label ?? `${relativePath}:${lineNumber}`),
      threads: entries,
    },
  }))
}
