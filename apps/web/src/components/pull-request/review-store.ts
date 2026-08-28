/**
 * A review being written, held until it is sent. Ported from t3code's
 * `pullRequestReviewStore.ts`.
 *
 * Nothing here reaches GitHub: a review is one request carrying every line
 * comment and the verdict together, so a half-written one is invisible to
 * everyone else. A draft lives only as long as the tab does, which is why
 * this is deliberately not persisted.
 *
 * Laborer adaptation: a draft is keyed by workspace id — a workspace has
 * at most one pull request, so the workspace is the identity t3 spelled as
 * `projectId/repository#number`.
 */
import type { PullRequestReviewCommentDraft } from '@laborer/shared/rpc'
import { create } from 'zustand'

export type PendingReviewComment = PullRequestReviewCommentDraft & {
  readonly id: string
}

/**
 * A counter rather than anything derived from the comment: an id built
 * from the draft's own contents would collide with a comment that was
 * already removed, and discarding one card would delete both.
 */
let pendingCommentSequence = 0

export function nextPendingReviewCommentId(): string {
  pendingCommentSequence += 1
  return `pending-review-comment-${pendingCommentSequence}`
}

interface PullRequestReviewStoreState {
  readonly addComment: (key: string, comment: PendingReviewComment) => void
  readonly clear: (key: string) => void
  readonly clearSummary: (key: string, submittedBody: string) => void
  readonly drafts: Readonly<Record<string, readonly PendingReviewComment[]>>
  readonly removeComment: (key: string, commentId: string) => void
  readonly removeComments: (key: string, commentIds: readonly string[]) => void
  readonly setSummary: (key: string, body: string) => void
  readonly summaries: Readonly<Record<string, string>>
}

const EMPTY: readonly PendingReviewComment[] = []

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()(
  (set) => ({
    drafts: {},
    summaries: {},
    addComment: (key, comment) =>
      set((state) => ({
        drafts: {
          ...state.drafts,
          [key]: [...(state.drafts[key] ?? EMPTY), comment],
        },
      })),
    removeComment: (key, commentId) =>
      set((state) => {
        const remaining = (state.drafts[key] ?? EMPTY).filter(
          (entry) => entry.id !== commentId
        )
        if (remaining.length > 0) {
          return { drafts: { ...state.drafts, [key]: remaining } }
        }
        const { [key]: _removed, ...rest } = state.drafts
        return { drafts: rest }
      }),
    removeComments: (key, commentIds) =>
      set((state) => {
        const submitted = new Set(commentIds)
        const remaining = (state.drafts[key] ?? EMPTY).filter(
          (entry) => !submitted.has(entry.id)
        )
        if (remaining.length > 0) {
          return { drafts: { ...state.drafts, [key]: remaining } }
        }
        const { [key]: _removed, ...rest } = state.drafts
        return { drafts: rest }
      }),
    clear: (key) =>
      set((state) => {
        const { [key]: _removed, ...rest } = state.drafts
        return { drafts: rest }
      }),
    setSummary: (key, body) =>
      set((state) => ({ summaries: { ...state.summaries, [key]: body } })),
    clearSummary: (key, submittedBody) =>
      set((state) => {
        // The textarea stays editable while the request is in flight. Only
        // remove the exact draft GitHub accepted; a revised summary for the
        // same pull request is new work.
        if (state.summaries[key] !== submittedBody) {
          return state
        }
        const { [key]: _removed, ...rest } = state.summaries
        return { summaries: rest }
      }),
  })
)

/** The comments a workspace's draft holds, stable across renders while empty. */
export function usePendingReviewComments(
  workspaceId: string
): readonly PendingReviewComment[] {
  return usePullRequestReviewStore(
    (store) => store.drafts[workspaceId] ?? EMPTY
  )
}
