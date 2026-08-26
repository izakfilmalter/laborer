/**
 * The diff pane's review conversations: reading them live, and writing to
 * them.
 *
 * Reads come from the shared collection the `state.subscribe` stream feeds —
 * the same path tasks, labels, and projects take — so a reply the coding agent
 * writes over MCP lands here without the pane asking for it. Nothing polls
 * `reviewComment.list`.
 *
 * ## Optimistic writes, and what a failure costs
 *
 * Every write is optimistic, matching every other shared write in the app.
 * The `reviewComment.create` contract hands the client the thread and reply
 * ids precisely so the optimistic row and the stored row are the same row,
 * and `operationId` is what ends the optimism — an authoritative delta, not a
 * timer. See `@/db/shared-mutations`.
 *
 * The one thing optimism must never do is lose words. The composer's text is
 * held here, cleared only when the write is dispatched, and put back exactly
 * as typed if the write is rejected — with the failure named in a toast, since
 * an annotation quietly disappearing would otherwise be the only report.
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import type {
  ReviewCommentStatus,
  ReviewCommentThread,
} from '@laborer/shared/rpc'
import { createTaskUlid } from '@laborer/task-db/ulid'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  createReviewComment,
  deleteReviewComment,
  replyToReviewComment,
  setReviewCommentStatus,
} from '@/db/shared-mutations'
import { reviewCommentCollection } from '@/db/shared-state'
import type { DiffCommentAnchor } from '@/lib/diff-comment-anchor'
import { formatDiffCommentAnchorLabel } from '@/lib/diff-comment-anchor'
import { selectDiffCommentThreads } from '@/lib/diff-comment-threads'
import { extractErrorCode, extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'

const createMutation = LaborerClient.mutation('reviewComment.create')
const replyMutation = LaborerClient.mutation('reviewComment.reply')
const setStatusMutation = LaborerClient.mutation('reviewComment.setStatus')
const deleteMutation = LaborerClient.mutation('reviewComment.delete')

/**
 * The one open composer. A single draft at a time is deliberate: the viewer
 * pins its gutter affordance to one selection, and two composers competing for
 * that line would be indistinguishable to a reader.
 */
export type DiffCommentDraft =
  | {
      readonly anchor: DiffCommentAnchor
      readonly body: string
      readonly kind: 'create'
    }
  | {
      readonly anchor: DiffCommentAnchor
      readonly body: string
      readonly kind: 'reply'
      readonly threadId: string
    }

/** The anchor a stored thread reads as, for the composer's spoken label. */
const anchorOfThread = (thread: ReviewCommentThread): DiffCommentAnchor => ({
  endLine: thread.endLine,
  filePath: thread.filePath,
  label: formatDiffCommentAnchorLabel({
    endLine: thread.endLine,
    filePath: thread.filePath,
    side: thread.side,
    startLine: thread.startLine,
  }),
  side: thread.side,
  startLine: thread.startLine,
})

const writeFailureMessage = (error: unknown): string =>
  extractErrorCode(error) === 'CAS_CONFLICT'
    ? 'This comment changed elsewhere. It is shown as stored — try again.'
    : extractErrorMessage(error)

export interface DiffReviewComments {
  /** True while one of this pane's writes is in flight. */
  readonly busy: boolean
  readonly cancelDraft: () => void
  readonly changeDraft: (body: string) => void
  readonly deleteThread: (thread: ReviewCommentThread) => void
  readonly draft: DiffCommentDraft | null
  readonly includeResolved: boolean
  /** Resolved conversations in this workspace, however they are filtered. */
  readonly resolvedCount: number
  readonly setIncludeResolved: (includeResolved: boolean) => void
  readonly setStatus: (
    thread: ReviewCommentThread,
    status: ReviewCommentStatus
  ) => void
  readonly startComment: (anchor: DiffCommentAnchor) => void
  readonly startReply: (thread: ReviewCommentThread) => void
  readonly submitDraft: () => void
  /** Visible threads for this workspace, keyed by the file they anchor to. */
  readonly threadsByFile: ReadonlyMap<string, readonly ReviewCommentThread[]>
}

export function useDiffReviewComments(workspaceId: string): DiffReviewComments {
  const { data: rows } = useLiveQuery((query) =>
    query.from({ reviewComments: reviewCommentCollection })
  )
  const create = useAtomSet(createMutation, { mode: 'promise' })
  const reply = useAtomSet(replyMutation, { mode: 'promise' })
  const setStatusWrite = useAtomSet(setStatusMutation, { mode: 'promise' })
  const remove = useAtomSet(deleteMutation, { mode: 'promise' })

  const [includeResolved, setIncludeResolved] = useState(false)
  const [draft, setDraft] = useState<DiffCommentDraft | null>(null)
  const [busy, setBusy] = useState(false)

  const visible = useMemo(
    () => selectDiffCommentThreads(rows, { includeResolved, workspaceId }),
    [includeResolved, rows, workspaceId]
  )

  const resolvedCount = useMemo(
    () =>
      rows.filter(
        (row) => row.workspaceId === workspaceId && row.status === 'resolved'
      ).length,
    [rows, workspaceId]
  )

  const threadsByFile = useMemo(() => {
    const byFile = new Map<string, ReviewCommentThread[]>()
    for (const thread of visible) {
      const existing = byFile.get(thread.filePath)
      if (existing) {
        existing.push(thread)
      } else {
        byFile.set(thread.filePath, [thread])
      }
    }
    return byFile as ReadonlyMap<string, readonly ReviewCommentThread[]>
  }, [visible])

  const run = useCallback(
    (write: () => Promise<unknown>, onReject?: () => void) => {
      setBusy(true)
      write()
        .catch((error: unknown) => {
          toast.error(writeFailureMessage(error))
          onReject?.()
        })
        .finally(() => setBusy(false))
    },
    []
  )

  const submitDraft = useCallback(() => {
    const current = draft
    if (current === null || busy) {
      return
    }
    const body = current.body.trim()
    if (body.length === 0) {
      return
    }
    // The composer closes now and the thread appears now; a rejection below
    // puts the words back, and only a draft the human has not replaced.
    setDraft(null)
    const restore = () => setDraft((live) => live ?? current)

    if (current.kind === 'reply') {
      run(
        () =>
          replyToReviewComment({
            body,
            id: createTaskUlid(),
            now: Date.now(),
            operationId: crypto.randomUUID(),
            send: (payload) => reply({ payload }),
            threadId: current.threadId,
          }),
        restore
      )
      return
    }

    run(
      () =>
        createReviewComment({
          body,
          endLine: current.anchor.endLine,
          filePath: current.anchor.filePath,
          id: createTaskUlid(),
          now: Date.now(),
          operationId: crypto.randomUUID(),
          replyId: createTaskUlid(),
          send: (payload) => create({ payload }),
          side: current.anchor.side,
          startLine: current.anchor.startLine,
          workspaceId,
        }),
      restore
    )
  }, [busy, create, draft, reply, run, workspaceId])

  return {
    busy,
    cancelDraft: useCallback(() => setDraft(null), []),
    changeDraft: useCallback(
      (body: string) =>
        setDraft((current) => (current ? { ...current, body } : current)),
      []
    ),
    deleteThread: useCallback(
      (thread: ReviewCommentThread) => {
        setDraft((current) =>
          current?.kind === 'reply' && current.threadId === thread.id
            ? null
            : current
        )
        run(() =>
          deleteReviewComment({
            operationId: crypto.randomUUID(),
            send: (payload) => remove({ payload }),
            threadId: thread.id,
          })
        )
      },
      [remove, run]
    ),
    draft,
    includeResolved,
    resolvedCount,
    setIncludeResolved,
    setStatus: useCallback(
      (thread: ReviewCommentThread, status: ReviewCommentStatus) => {
        run(() =>
          setReviewCommentStatus({
            operationId: crypto.randomUUID(),
            send: (payload) => setStatusWrite({ payload }),
            status,
            threadId: thread.id,
          })
        )
      },
      [run, setStatusWrite]
    ),
    startComment: useCallback(
      (anchor: DiffCommentAnchor) =>
        setDraft({ anchor, body: '', kind: 'create' }),
      []
    ),
    startReply: useCallback(
      (thread: ReviewCommentThread) =>
        setDraft({
          anchor: anchorOfThread(thread),
          body: '',
          kind: 'reply',
          threadId: thread.id,
        }),
      []
    ),
    submitDraft,
    threadsByFile,
  }
}
