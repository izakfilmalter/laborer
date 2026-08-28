// biome-ignore-all lint/style/noNestedTernary: ported near-verbatim from t3code, which chains presentation ternaries in JSX.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the tab is t3code's, ported whole; splitting it would diverge from the source it mirrors.
/**
 * The pull request's patch, with the review written against it. Ported
 * from t3code's `PullRequestCodeTab.tsx`: conversations already on GitHub
 * sit under the line they were written on, and a new comment joins the
 * review being drafted rather than being posted as it is typed.
 *
 * Laborer adaptations: the diff slices come from `pullRequest.diff`
 * (Effect Atom queries rather than t3's environment queries); the gutter
 * affordance is Laborer's `DiffCommentGutterButton` (the installed
 * `@pierre/diffs` refuses t3's `onGutterUtilityClick` beside a custom
 * node); expanding context maps to `pullRequest.diffContents`; and the
 * agent hand-off buttons are gone.
 */
import {
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from '@effect/atom-react/Hooks'
import type {
  PullRequestDiffSide,
  PullRequestOmittedFileStat,
  PullRequestReviewPosition,
  PullRequestReviewThread,
} from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@laborer/ui/components/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@laborer/ui/components/dropdown-menu'
import { Spinner } from '@laborer/ui/components/spinner'
import { Toggle } from '@laborer/ui/components/toggle'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@laborer/ui/components/toggle-group'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import type {
  CodeViewItem,
  CodeViewLineSelection,
  DiffLineAnnotation,
  FileDiffLoadedFiles,
  FileDiffMetadata,
  SelectedLineRange,
} from '@pierre/diffs'
import { Cause, Effect } from 'effect'
import { AsyncResult as Result } from 'effect/unstable/reactivity'
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  MessageSquare,
  MessageSquareOff,
  Rows3,
  TriangleAlert,
  WrapText,
  X,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { DiffCommentComposer } from '@/components/diff-comment-annotation'
import { DiffCommentGutterButton } from '@/components/diff-comment-gutter-button'
import { DiffWorkerPoolProvider } from '@/components/diff-worker-pool-provider'
import { StyledDiffCodeView } from '@/components/styled-diff-code-view'
import { areAllDiffFilesCollapsed } from '@/lib/diff-toolbar'
import { extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import type { PullRequestDetailView } from './detail-logic'
import {
  type DiffFoldOverride,
  getReviewPositionAnchor,
  isFileDiffCollapsed,
  isLineInFileDiff,
  resolvePullRequestReviewPosition,
} from './diff-logic'
import {
  buildFileDiffRenderKey,
  fnv1a32,
  getDiffLineStat,
  getRenderablePatch,
  type RenderablePatch,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from './diff-rendering-logic'
import { orderDiffFiles } from './file-order-logic'
import { PullRequestDiffStat, PullRequestMetaLine } from './presentation'
import {
  pullRequestDiffQuery,
  pullRequestDiffRequestKey,
  pullRequestReplyToThreadMutation,
  pullRequestSetThreadResolutionMutation,
} from './queries'
import { PendingReviewCommentCard, ReviewThreadCard } from './review-annotation'
import { PullRequestReviewBar } from './review-bar'
import {
  nextPendingReviewCommentId,
  type PendingReviewComment,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from './review-store'

/** Everything pinned to one line of one file: what is there, and what is being added. */
interface ReviewAnnotationGroup {
  readonly draft: boolean
  readonly pending: readonly PendingReviewComment[]
  readonly threads: readonly PullRequestReviewThread[]
}

type ReviewAnnotation = DiffLineAnnotation<ReviewAnnotationGroup>

/** Commits per press of "Show more" in the scope menu. */
const COMMIT_PAGE_SIZE = 10

/** One answer from GitHub: a whole number of files, and where the next carries on. */
interface DiffSlice {
  /** What was asked for, null being the first slice. */
  readonly cursor: string | null
  readonly nextCursor: string | null
  readonly omittedFileStats: readonly PullRequestOmittedFileStat[]
  readonly patch: string
  readonly truncated: boolean
}

/**
 * The viewer's own per-file counts are hidden and drawn from this side of
 * its shadow root instead: its counts are hunk sums, and a file whose
 * hunks GitHub withheld would read as an empty change.
 */
const REPLACE_FILE_COUNTS_CSS = `
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}`

/** Nothing loaded yet, as one identity for the memos below. */
const NO_SLICES: readonly DiffSlice[] = []

/** A group while it is still gathering what belongs on its line. */
interface MutableAnnotationGroup {
  draft: boolean
  readonly line: number
  readonly pending: PendingReviewComment[]
  readonly side: PullRequestDiffSide
  readonly threads: PullRequestReviewThread[]
}

interface DraftAnchor {
  readonly fileKey: string
  /** What the file was called before the change, for renames. */
  readonly oldPath: string | null
  readonly path: string
  readonly position: PullRequestReviewPosition
  readonly range: SelectedLineRange
}

/** The contract's sides named the way the diff viewer names them. */
function toViewerSide(side: PullRequestDiffSide) {
  return side === 'left' ? ('deletions' as const) : ('additions' as const)
}

function DiffLoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-3">
      <Spinner className="size-5 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">{label}</p>
    </div>
  )
}

export function PullRequestCodeTab({
  workspaceId,
  detail,
  selectedCommitOid,
  onSelectedCommitChange,
  onRefresh,
  refreshToken = 0,
  now,
}: {
  workspaceId: string
  detail: PullRequestDetailView
  /** Commit whose diff is open. Null keeps the whole pull-request diff. */
  selectedCommitOid: string | null
  onSelectedCommitChange: (oid: string | null) => void
  onRefresh: () => void
  /** Bumped by the panel's refresh: drop the accumulated pages and re-read. */
  refreshToken?: number
  /** Rendering clock for thread timestamps. */
  now: number
}) {
  const { resolvedTheme } = useTheme()
  const themeType =
    resolvedTheme === 'light' ? ('light' as const) : ('dark' as const)
  const [toggledFiles, setToggledFiles] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // A change of any size can carry hundreds of commits; the rest arrive
  // ten at a time, on request.
  const [visibleCommitCount, setVisibleCommitCount] = useState(COMMIT_PAGE_SIZE)
  /** Set once the reader has asked for every file at once. */
  const [foldOverride, setFoldOverride] = useState<DiffFoldOverride>(null)
  const [diffRenderMode, setDiffRenderMode] = useState<'stacked' | 'split'>(
    'stacked'
  )
  const [wordWrap, setWordWrap] = useState(true)
  const [selectedLines, setSelectedLines] =
    useState<CodeViewLineSelection | null>(null)
  const [draft, setDraft] = useState<DraftAnchor | null>(null)
  const [draftBody, setDraftBody] = useState('')
  const [threadPending, setThreadPending] = useState(false)
  const [orphansOpen, setOrphansOpen] = useState(false)
  // Closed by default so the review form does not permanently eat vertical
  // space below the diff; opened on demand as a floating overlay.
  const [reviewOpen, setReviewOpen] = useState(false)
  // Which scope the slices belong to travels with them, so a render taken
  // before the reset below cannot read the previous scope's slices.
  const [sliceState, setSliceState] = useState<{
    readonly key: string
    readonly cursor: string | null
    readonly slices: readonly DiffSlice[]
  }>({ key: '', cursor: null, slices: NO_SLICES })
  const parseCache = useRef(new Map<string, RenderablePatch>())

  const commit = selectedCommitOid
  // One commit's own changes and the whole change are two different diffs,
  // paged separately, so everything below is keyed by both.
  const scopeKey = commit === null ? workspaceId : `${workspaceId}@${commit}`
  // The panel keeps this mounted across pull requests, so an open composer
  // would otherwise survive the switch.
  useEffect(() => {
    setDraft(null)
    setDraftBody('')
    setSelectedLines(null)
    setToggledFiles(new Set())
    setFoldOverride(null)
    setVisibleCommitCount(COMMIT_PAGE_SIZE)
    setOrphansOpen(false)
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES })
    parseCache.current.clear()
  }, [scopeKey])

  const loadedSlices =
    sliceState.key === scopeKey ? sliceState.slices : NO_SLICES
  const cursor = sliceState.key === scopeKey ? sliceState.cursor : null
  const diffAtom = useMemo(
    () =>
      pullRequestDiffQuery(
        pullRequestDiffRequestKey({ workspaceId, cursor, commit })
      ),
    [workspaceId, cursor, commit]
  )
  const diffResult = useAtomValue(diffAtom)
  const refreshDiffSlice = useAtomRefresh(diffAtom)
  const diffData = Result.isSuccess(diffResult) ? diffResult.value : null
  const diffError = Result.isFailure(diffResult)
    ? extractErrorMessage(Cause.squash(diffResult.cause))
    : null
  const diffPending = diffResult.waiting || diffResult._tag === 'Initial'

  // Each answer is kept as its own slice. Concatenating the patches and
  // re-parsing the growing text would cost more with every slice.
  useEffect(() => {
    if (diffData === null) {
      return
    }
    setSliceState((previous) => {
      const slices = previous.key === scopeKey ? previous.slices : NO_SLICES
      const next: DiffSlice = {
        cursor,
        patch: diffData.patch,
        truncated: diffData.truncated,
        nextCursor: diffData.nextCursor,
        omittedFileStats: diffData.omittedFileStats,
      }
      const index = slices.findIndex((slice) => slice.cursor === cursor)
      if (index === -1) {
        return { key: scopeKey, cursor, slices: [...slices, next] }
      }
      const existing = slices[index]
      if (
        existing !== undefined &&
        existing.patch === next.patch &&
        existing.truncated === next.truncated &&
        existing.nextCursor === next.nextCursor &&
        existing.omittedFileStats.length === next.omittedFileStats.length &&
        existing.omittedFileStats.every((file, statIndex) => {
          const refreshed = next.omittedFileStats[statIndex]
          return (
            refreshed !== undefined &&
            refreshed.path === file.path &&
            refreshed.additions === file.additions &&
            refreshed.deletions === file.deletions
          )
        })
      ) {
        return previous
      }
      // A page that came back different means the diff moved under the
      // review. The slices after it go with the replacement.
      return {
        key: scopeKey,
        cursor,
        slices: [...slices.slice(0, index), next],
      }
    })
  }, [cursor, diffData, scopeKey])

  // The refresh button rereads from the first page: pages are positions in
  // one snapshot of the diff, and a fresh snapshot starts over.
  const refreshFirstDiffPage = useAtomRefresh(
    pullRequestDiffQuery(
      pullRequestDiffRequestKey({ workspaceId, cursor: null, commit })
    )
  )
  const appliedRefreshToken = useRef(refreshToken)
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) {
      return
    }
    appliedRefreshToken.current = refreshToken
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES })
    refreshFirstDiffPage()
  }, [refreshToken, scopeKey, refreshFirstDiffPage])

  const pendingComments = usePendingReviewComments(workspaceId)
  const addComment = usePullRequestReviewStore((store) => store.addComment)
  const removeComment = usePullRequestReviewStore(
    (store) => store.removeComment
  )
  const replyToThread = useAtomSet(pullRequestReplyToThreadMutation, {
    mode: 'promise',
  })
  const setThreadResolution = useAtomSet(
    pullRequestSetThreadResolutionMutation,
    { mode: 'promise' }
  )

  // --- Expanding context: pullRequest.diffContents as Pierre's loader ---
  useAtomMount(LaborerClient.runtime)
  const runtimeResult = useAtomValue(LaborerClient.runtime)
  const runtimeRef = useRef(runtimeResult)
  runtimeRef.current = runtimeResult
  const contentsCache = useRef(new Map<string, Promise<FileDiffLoadedFiles>>())
  useEffect(() => {
    contentsCache.current = new Map()
  }, [])
  const commitRef = useRef(commit)
  commitRef.current = commit
  const loadDiffFiles = useCallback(
    async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      const changeType = fileDiff.type
      if (
        changeType !== 'change' &&
        changeType !== 'rename-pure' &&
        changeType !== 'rename-changed' &&
        changeType !== 'new' &&
        changeType !== 'deleted'
      ) {
        throw new Error(`No context to expand for ${fileDiff.name}`)
      }
      const newPath = resolveFileDiffPath(fileDiff)
      const oldPath = resolveFileDiffPreviousPath(fileDiff)
      const scopedCommit = commitRef.current
      const cacheKey = `pr-contents:${workspaceId}:${detail.updatedAt}:${scopedCommit ?? 'all'}:${oldPath}:${newPath}`
      const cached = contentsCache.current.get(cacheKey)
      if (cached) {
        return await cached
      }
      const runtime = runtimeRef.current
      if (runtime._tag !== 'Success') {
        throw new Error('Not connected yet')
      }
      const pending = Effect.runPromiseWith(runtime.value)(
        Effect.flatMap(LaborerClient, (client) =>
          client('pullRequest.diffContents', {
            workspaceId,
            changeType,
            oldPath,
            newPath,
            ...(scopedCommit === null ? {} : { commit: scopedCommit }),
          })
        )
      ).then(
        (contents): FileDiffLoadedFiles => {
          const newFile = {
            name: newPath,
            contents: contents.newContents,
            cacheKey: `${cacheKey}:new`,
          }
          if (changeType === 'rename-pure') {
            return { oldFile: null, newFile }
          }
          return {
            oldFile: {
              name: oldPath,
              contents: contents.oldContents,
              cacheKey: `${cacheKey}:old`,
            },
            newFile,
          }
        },
        (error: unknown) => {
          const message = extractErrorMessage(error)
          toast.warning(message)
          throw new Error(message)
        }
      )
      contentsCache.current.set(cacheKey, pending)
      return await pending
    },
    [workspaceId, detail.updatedAt]
  )

  // A comment is posted against the pull request's head diff, so a line
  // number taken from one commit's own diff would land somewhere else.
  const canCommentOnLines = commit === null
  // Every slice is parsed on its own, so a slice arriving costs one parse.
  const parsedSlices = useMemo(
    () =>
      loadedSlices.map((slice) => {
        const cacheKey = `pull-request:${scopeKey}:${resolvedTheme}:${slice.cursor ?? 'first'}:${fnv1a32(slice.patch)}`
        const cached = parseCache.current.get(cacheKey)
        if (cached) {
          return cached
        }
        const parsed = getRenderablePatch(slice.patch, cacheKey)
        if (parsed) {
          parseCache.current.set(cacheKey, parsed)
        }
        return parsed
      }),
    [loadedSlices, resolvedTheme, scopeKey]
  )
  // Ordered within a slice rather than across them: ordering the
  // accumulated set would let a late slice push a file the reader is part
  // way through further down the page.
  const files = useMemo(
    () =>
      parsedSlices.flatMap((parsed) =>
        parsed?.kind === 'files' ? orderDiffFiles(parsed.files) : []
      ),
    [parsedSlices]
  )
  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null
  // What a slice withheld: a binary file, or a patch the viewer could not
  // structure. Neither says anything about there being more to fetch.
  const withheldContent =
    loadedSlices.some((slice) => slice.truncated) ||
    parsedSlices.some((parsed) => parsed?.kind === 'raw')

  // Placing a conversation takes more than its file being in the diff: its
  // line has to fall inside a hunk that was rendered.
  const placedThreadIds = useMemo(() => {
    const placed = new Set<string>()
    // A commit's diff counts lines within that commit; a review comment is
    // anchored to the pull request's head diff. While a commit is on
    // screen every conversation is listed rather than placed.
    if (commit !== null) {
      return placed
    }
    for (const file of files) {
      const path = resolveFileDiffPath(file)
      for (const thread of detail.reviewThreads) {
        if (
          thread.path === path &&
          thread.line !== null &&
          isLineInFileDiff(file, thread.side, thread.line)
        ) {
          placed.add(thread.id)
        }
      }
    }
    return placed
  }, [commit, detail.reviewThreads, files])

  const items = useMemo(
    () =>
      files.map((fileDiff) => {
        const fileKey = buildFileDiffRenderKey(fileDiff)
        const path = resolveFileDiffPath(fileDiff)
        // One annotation per line, so a line that already carries a
        // conversation shows a new comment underneath rather than instead.
        const groups = new Map<string, MutableAnnotationGroup>()
        const groupAt = (side: PullRequestDiffSide, line: number) => {
          const key = `${side}:${line}`
          const existing = groups.get(key)
          if (existing) {
            return existing
          }
          const created: MutableAnnotationGroup = {
            side,
            line,
            threads: [],
            pending: [],
            draft: false,
          }
          groups.set(key, created)
          return created
        }

        for (const thread of detail.reviewThreads) {
          if (thread.path !== path || thread.line === null) {
            continue
          }
          if (!placedThreadIds.has(thread.id)) {
            continue
          }
          groupAt(thread.side, thread.line).threads.push(thread)
        }
        // Pending comments anchor to the head diff exactly like host
        // threads do, so a commit's diff must not place them either.
        if (commit === null) {
          for (const comment of pendingComments) {
            if (comment.path !== path) {
              continue
            }
            const anchor = getReviewPositionAnchor(comment.position)
            groupAt(anchor.side, anchor.line).pending.push(comment)
          }
        }
        if (draft?.fileKey === fileKey) {
          const anchor = getReviewPositionAnchor(draft.position)
          groupAt(anchor.side, anchor.line).draft = true
        }

        const collapsed = isFileDiffCollapsed(
          fileKey,
          foldOverride,
          toggledFiles
        )

        const annotations: ReviewAnnotation[] = [...groups.values()].map(
          (group) => ({
            side: toViewerSide(group.side),
            lineNumber: group.line,
            metadata: {
              threads: group.threads,
              pending: group.pending,
              draft: group.draft,
            },
          })
        )
        return {
          id: fileKey,
          type: 'diff' as const,
          fileDiff,
          annotations,
          collapsed,
          // The viewer re-renders an item only when its version changes, so
          // everything the annotations show has to be part of it.
          version: fnv1a32(
            `${collapsed ? '1' : '0'}:${annotations
              .map(
                ({ side, lineNumber, metadata }) =>
                  `${side}:${lineNumber}:${metadata.draft ? 'd' : ''}:${metadata.pending
                    .map((comment) => `${comment.id}:${comment.body}`)
                    .join(',')}:${metadata.threads
                    .map(
                      (thread) =>
                        `${thread.id}:${thread.isResolved ? 'r' : ''}:${
                          thread.isOutdated ? 'o' : ''
                        }:${thread.comments
                          .map(
                            (comment) =>
                              `${comment.id}:${comment.author?.login ?? ''}:${comment.createdAt}:${comment.body}:${comment.reactions
                                .map(
                                  (reaction) =>
                                    `${reaction.content}:${reaction.count}:${reaction.viewerHasReacted ? 'v' : ''}`
                                )
                                .join(',')}`
                          )
                          .join(';')}`
                    )
                    .join(',')}`
              )
              .join('|')}`
          ),
        }
      }),
    [
      commit,
      detail.reviewThreads,
      draft,
      files,
      foldOverride,
      pendingComments,
      placedThreadIds,
      toggledFiles,
    ]
  )
  const lineStat = useMemo(() => getDiffLineStat(files), [files])
  const omittedFileStats = useMemo(
    () =>
      new Map(
        loadedSlices.flatMap((slice) =>
          slice.omittedFileStats.map((file) => [file.path, file] as const)
        )
      ),
    [loadedSlices]
  )
  const fileKeys = useMemo(() => items.map((item) => item.id), [items])
  const collapsedFileKeys = useMemo(
    () =>
      new Set(
        items.filter((item) => item.collapsed === true).map((item) => item.id)
      ),
    [items]
  )
  const allFilesCollapsed = areAllDiffFilesCollapsed(fileKeys, (key) =>
    collapsedFileKeys.has(key)
  )

  // The sentinel is held as state rather than a ref because the viewer
  // mounts its own footer.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    // A failed slice must stop the observer, or it would ask for the same
    // slice again, forever.
    if (
      sentinel === null ||
      nextCursor === null ||
      nextCursor === cursor ||
      diffPending ||
      diffError !== null
    ) {
      return
    }
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) {
          setSliceState((previous) => ({ ...previous, cursor: nextCursor }))
        }
      },
      // Start the next slice slightly before the sentinel is on screen.
      { rootMargin: '240px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [cursor, diffError, diffPending, nextCursor, sentinel])

  const toggleFile = useCallback(
    (fileKey: string) =>
      setToggledFiles((current) => {
        const next = new Set(current)
        if (next.has(fileKey)) {
          next.delete(fileKey)
        } else {
          next.add(fileKey)
        }
        return next
      }),
    []
  )

  const toggleAllFiles = () => {
    // Held as an override of the default rather than as the file keys on
    // screen: a diff that is still paging would otherwise bring its next
    // slice in folded moments after the reader asked for everything open.
    setFoldOverride(
      areAllDiffFilesCollapsed(fileKeys, (key) => collapsedFileKeys.has(key))
        ? 'expanded'
        : 'folded'
    )
    setToggledFiles(new Set())
  }

  // Newest first: the last commit is the one a returning reader looks for.
  const orderedCommits = useMemo(
    () =>
      detail.commits.toSorted(
        (left, right) =>
          Date.parse(right.committedDate) - Date.parse(left.committedDate)
      ),
    [detail.commits]
  )

  const beginComment = useCallback(
    (fileKey: string, range: SelectedLineRange) => {
      if (!canCommentOnLines) {
        return
      }
      const file = files.find(
        (candidate) => buildFileDiffRenderKey(candidate) === fileKey
      )
      if (!file) {
        return
      }
      // A range collapses to its last line: GitHub carries multi-line
      // comments, but a range that silently lost its first line elsewhere
      // would be worse than one line.
      const path = resolveFileDiffPath(file)
      const previousPath = resolveFileDiffPreviousPath(file)
      const position = resolvePullRequestReviewPosition(
        file,
        range.end,
        range.endSide ?? range.side
      )
      if (position === null) {
        return
      }
      setDraftBody('')
      setDraft({
        fileKey,
        path,
        oldPath: previousPath === path ? null : previousPath,
        position,
        range,
      })
    },
    [canCommentOnLines, files]
  )

  const runThreadCommand = useCallback(
    async (label: string, run: () => Promise<unknown>): Promise<boolean> => {
      if (threadPending) {
        return false
      }
      setThreadPending(true)
      try {
        await run()
      } catch {
        setThreadPending(false)
        toast.error(label)
        return false
      }
      setThreadPending(false)
      onRefresh()
      return true
    },
    [onRefresh, threadPending]
  )

  // A conversation is the same card wired to the same commands whether it
  // sits on its line or was stranded off the diff.
  const renderThreadCard = useCallback(
    (thread: PullRequestReviewThread) => (
      <ReviewThreadCard
        baseHref={detail.url}
        canReply={true}
        canResolve={true}
        key={`${workspaceId}:${thread.id}`}
        now={now}
        onReacted={onRefresh}
        onReply={(body) =>
          runThreadCommand('Reply could not be posted', () =>
            replyToThread({
              payload: { workspaceId, threadId: thread.id, body },
            })
          )
        }
        onToggleResolved={() =>
          runThreadCommand('The conversation could not be updated', () =>
            setThreadResolution({
              payload: {
                workspaceId,
                threadId: thread.id,
                resolved: !thread.isResolved,
              },
            })
          )
        }
        pending={threadPending}
        thread={thread}
        workspaceId={workspaceId}
      />
    ),
    [
      detail.url,
      now,
      onRefresh,
      replyToThread,
      runThreadCommand,
      setThreadResolution,
      threadPending,
      workspaceId,
    ]
  )

  const renderAnnotation = useCallback(
    (annotation: ReviewAnnotation) => (
      <div className="py-1 font-sans text-foreground">
        {annotation.metadata.threads.map(renderThreadCard)}
        {annotation.metadata.pending.map((comment) => (
          <PendingReviewCommentCard
            comment={comment}
            key={comment.id}
            onRemove={() => removeComment(workspaceId, comment.id)}
          />
        ))}
        {annotation.metadata.draft && draft ? (
          <DiffCommentComposer
            anchorLabel={`${draft.path}:${getReviewPositionAnchor(draft.position).line}`}
            busy={false}
            onCancel={() => {
              setDraft(null)
              setDraftBody('')
              setSelectedLines(null)
            }}
            onChange={setDraftBody}
            onSubmit={(body) => {
              if (body.length === 0) {
                return
              }
              addComment(workspaceId, {
                id: nextPendingReviewCommentId(),
                path: draft.path,
                position: draft.position,
                body,
              })
              setDraft(null)
              setDraftBody('')
              setSelectedLines(null)
            }}
            placeholder="Leave a review comment…"
            submitLabel="Add to review"
            value={draftBody}
          />
        ) : null}
      </div>
    ),
    [addComment, draft, draftBody, removeComment, renderThreadCard, workspaceId]
  )

  const renderCodeViewFooter = useCallback(
    () =>
      // Only while something is still owed.
      nextCursor === null ? null : (
        <div
          className="flex items-center justify-center gap-2 py-2 text-muted-foreground text-xs"
          ref={setSentinel}
        >
          {diffError !== null ? (
            <>
              <span>The rest of this diff could not be loaded.</span>
              <Button
                onClick={() => refreshDiffSlice()}
                size="xs"
                variant="outline"
              >
                Retry
              </Button>
            </>
          ) : diffPending ? (
            'Loading more files...'
          ) : null}
        </div>
      ),
    [nextCursor, diffError, diffPending, refreshDiffSlice]
  )

  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem<ReviewAnnotationGroup>) => {
      const collapsed = item.collapsed === true
      return (
        <Button
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand diff' : 'Collapse diff'}
          className="mr-1 size-5 rounded hover:bg-transparent"
          onClick={(event) => {
            event.stopPropagation()
            toggleFile(item.id)
          }}
          size="icon-xs"
          variant="ghost"
        >
          {collapsed ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </Button>
      )
    },
    [toggleFile]
  )

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<ReviewAnnotationGroup>) => {
      if (item.type !== 'diff') {
        return null
      }
      let additions = 0
      let deletions = 0
      for (const hunk of item.fileDiff.hunks) {
        additions += hunk.additionLines
        deletions += hunk.deletionLines
      }
      if (additions === 0 && deletions === 0) {
        const withheld = omittedFileStats.get(
          resolveFileDiffPath(item.fileDiff)
        )
        if (withheld) {
          ;({ additions, deletions } = withheld)
        }
      }
      return (
        <PullRequestDiffStat
          additions={additions}
          className="font-mono text-[11px]"
          deletions={deletions}
        />
      )
    },
    [omittedFileStats]
  )

  const renderGutterUtility = useCallback(
    (
      getHoveredLine: () =>
        | { lineNumber: number; side?: 'additions' | 'deletions' }
        | undefined,
      item: CodeViewItem<ReviewAnnotationGroup>
    ) => {
      if (!canCommentOnLines) {
        return null
      }
      const selectedRange =
        selectedLines?.id === item.id ? selectedLines.range : null
      return (
        <DiffCommentGutterButton
          label={
            selectedRange
              ? 'Comment on the selected lines'
              : 'Comment on this line'
          }
          onStartComment={(range) => beginComment(item.id, range)}
          resolveRange={() => {
            if (selectedRange) {
              return selectedRange
            }
            const hovered = getHoveredLine()
            if (!hovered) {
              return null
            }
            return {
              start: hovered.lineNumber,
              end: hovered.lineNumber,
              ...(hovered.side ? { side: hovered.side } : {}),
            }
          }}
        />
      )
    },
    [beginComment, canCommentOnLines, selectedLines]
  )

  const diffViewOptions = useMemo(
    () => ({
      diffStyle:
        diffRenderMode === 'split' ? ('split' as const) : ('unified' as const),
      lineDiffType: 'none' as const,
      overflow: wordWrap ? ('wrap' as const) : ('scroll' as const),
      theme: { dark: 'pierre-dark' as const, light: 'pierre-light' as const },
      themeType,
      stickyHeaders: true,
      loadDiffFiles,
      enableGutterUtility: canCommentOnLines && draft === null,
      enableLineSelection: canCommentOnLines && draft === null,
    }),
    [
      diffRenderMode,
      wordWrap,
      themeType,
      loadDiffFiles,
      canCommentOnLines,
      draft,
    ]
  )

  /**
   * The review overlay belongs to the pull request, not to the patch: a
   * change whose diff cannot be read is still one a reviewer can approve
   * or reject, so it survives every branch below. It floats over the
   * scroll area rather than sitting in the layout flow.
   */
  const reviewOverlay = (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
      {reviewOpen ? (
        <div className="pointer-events-auto absolute inset-x-3 bottom-3 rounded-xl border border-border/60 bg-background/95 shadow-lg backdrop-blur">
          <Button
            aria-label="Close review"
            className="absolute top-2 right-2"
            onClick={() => setReviewOpen(false)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <X className="size-3.5" />
          </Button>
          <PullRequestReviewBar
            onSubmitted={() => {
              onRefresh()
              setReviewOpen(false)
            }}
            workspaceId={workspaceId}
          />
        </div>
      ) : (
        // Bottom-right, clear of the vertical scrollbar the diff view
        // keeps to its own right edge.
        <Button
          className="pointer-events-auto absolute right-4 bottom-3 rounded-full shadow-lg"
          onClick={() => setReviewOpen(true)}
          size="sm"
          variant="outline"
        >
          <MessageSquare className="size-3.5" />
          Review
          {pendingComments.length > 0 ? (
            <span className="flex size-4 items-center justify-center rounded-full bg-accent text-[10px] text-accent-foreground tabular-nums">
              {pendingComments.length}
            </span>
          ) : null}
        </Button>
      )}
    </div>
  )

  // A rebase or force-push can take the scoped commit out of the change:
  // the scope goes back to the whole change rather than sitting under a
  // name nothing matches.
  const selectedCommit = orderedCommits.find((entry) => entry.oid === commit)
  useEffect(() => {
    if (commit !== null && selectedCommit === undefined) {
      onSelectedCommitChange(null)
    }
  }, [commit, onSelectedCommitChange, selectedCommit])
  const scopeLabel = selectedCommit
    ? selectedCommit.messageHeadline
    : 'All commits'
  const toolbar = (
    <div className="flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-border/60 border-b bg-background px-4 text-muted-foreground text-xs">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* A change that reports no commits has nothing to scope by. */}
        {orderedCommits.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Diff scope: ${scopeLabel}`}
              className="inline-flex h-6 max-w-64 items-center gap-1 rounded-md bg-accent px-2 font-medium text-accent-foreground text-xs outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{scopeLabel}</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              <DropdownMenuItem
                className={commit === null ? 'bg-foreground/[0.08]' : undefined}
                onClick={() => onSelectedCommitChange(null)}
              >
                <span>All commits</span>
              </DropdownMenuItem>
              {orderedCommits.slice(0, visibleCommitCount).map((entry) => (
                <DropdownMenuItem
                  className={
                    entry.oid === commit ? 'bg-foreground/[0.08]' : undefined
                  }
                  key={entry.oid}
                  onClick={() => onSelectedCommitChange(entry.oid)}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="min-w-0 truncate">
                          {entry.messageHeadline}
                        </span>
                      }
                    />
                    <TooltipContent side="top">
                      {entry.messageHeadline}
                    </TooltipContent>
                  </Tooltip>
                  <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
                    {entry.oid.slice(0, 7)}
                  </span>
                </DropdownMenuItem>
              ))}
              {orderedCommits.length > visibleCommitCount ? (
                <DropdownMenuItem
                  onClick={() =>
                    setVisibleCommitCount((count) => count + COMMIT_PAGE_SIZE)
                  }
                >
                  <span className="text-muted-foreground">
                    Show more ({orderedCommits.length - visibleCommitCount}{' '}
                    left)
                  </span>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {/* One count, and the caveats as icons that carry their own words. */}
        <PullRequestMetaLine>
          <span className="shrink-0 tabular-nums">
            {files.length} {files.length === 1 ? 'file' : 'files'}
            {nextCursor === null ? '' : '+'}
          </span>
          {withheldContent ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className="flex shrink-0 items-center" />}
              >
                <TriangleAlert
                  aria-label="Some of this diff was not shown"
                  className="size-3.5 text-amber-600 dark:text-amber-500"
                />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                GitHub withheld part of this diff — a binary file, or a change
                too large to inline.
              </TooltipContent>
            </Tooltip>
          ) : null}
          {commit !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className="flex shrink-0 items-center" />}
              >
                <MessageSquareOff
                  aria-label="Line comments are written from the whole change"
                  className="size-3.5"
                />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                A comment is anchored to the whole change, so switch to All
                commits to write one.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </PullRequestMetaLine>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <PullRequestDiffStat
          additions={lineStat.additions}
          className="mr-1"
          deletions={lineStat.deletions}
        />
        {fileKeys.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={
                    allFilesCollapsed
                      ? 'Expand all files'
                      : 'Collapse all files'
                  }
                  onClick={toggleAllFiles}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                />
              }
            >
              {allFilesCollapsed ? (
                <ChevronsUpDown className="size-3.5" />
              ) : (
                <ChevronsDownUp className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent side="top">
              {allFilesCollapsed ? 'Expand all files' : 'Collapse all files'}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <ToggleGroup
          className="shrink-0 gap-1"
          size="sm"
          value={[diffRenderMode]}
        >
          <ToggleGroupItem
            aria-label="Stacked diff view"
            onClick={() => setDiffRenderMode('stacked')}
            value="stacked"
          >
            <Rows3 className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem
            aria-label="Split diff view"
            onClick={() => setDiffRenderMode('split')}
            value="split"
          >
            <Columns2 className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  wordWrap
                    ? 'Disable diff line wrapping'
                    : 'Enable diff line wrapping'
                }
                onPressedChange={(pressed) => setWordWrap(Boolean(pressed))}
                pressed={wordWrap}
                size="sm"
                variant="default"
              />
            }
          >
            <WrapText className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="top">
            {wordWrap ? 'Disable line wrapping' : 'Enable line wrapping'}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )

  // The toolbar rides above every branch below, not just the one with a
  // patch in it: a commit whose diff is empty still needs the scope
  // dropdown that got the reader there.
  const withReviewBar = (body: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-auto">{body}</div>
        {reviewOverlay}
      </div>
    </div>
  )

  if (diffPending && loadedSlices.length === 0) {
    return withReviewBar(
      <DiffLoadingState label="Loading pull request diff..." />
    )
  }

  // A slice that fails once there are files on screen is reported at the
  // end of them instead.
  if (diffError && loadedSlices.length === 0) {
    return withReviewBar(
      <p className="px-4 py-5 text-muted-foreground text-sm">{diffError}</p>
    )
  }

  // A patch the viewer cannot structure still has to be readable. Only
  // once the diff is whole: returning here while a cursor is outstanding
  // would take the sentinel off screen and end the walk.
  const rawSlices =
    nextCursor === null
      ? parsedSlices.flatMap((parsed) =>
          parsed?.kind === 'raw' ? [parsed] : []
        )
      : []
  if (files.length === 0 && rawSlices.length > 0) {
    return withReviewBar(
      <div className="space-y-4 px-4 py-5">
        {rawSlices.map((slice) => (
          <div
            className="space-y-2"
            key={`${slice.reason}:${slice.text.slice(0, 64)}`}
          >
            <p className="text-muted-foreground text-xs">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">
              {slice.text}
            </pre>
          </div>
        ))}
      </div>
    )
  }

  if (items.length === 0 && nextCursor === null) {
    return withReviewBar(
      <p className="px-4 py-5 text-muted-foreground text-sm">
        {commit === null
          ? 'This pull request has no file changes.'
          : 'This commit has no file changes.'}
      </p>
    )
  }

  const orphanThreads = detail.reviewThreads.filter(
    (thread) => !placedThreadIds.has(thread.id)
  )
  // A file carrying five stranded conversations should read as that file
  // once rather than as five copies of its path.
  const orphanFiles = new Map<string, PullRequestReviewThread[]>()
  for (const thread of orphanThreads) {
    const existing = orphanFiles.get(thread.path)
    if (existing) {
      existing.push(thread)
    } else {
      orphanFiles.set(thread.path, [thread])
    }
  }

  const unstructured =
    rawSlices.length === 0 ? null : (
      // A slice the viewer cannot structure is still part of the change.
      <div className="space-y-4 border-border/60 border-t px-4 py-5">
        {rawSlices.map((slice) => (
          <div
            className="space-y-2"
            key={`${slice.reason}:${slice.text.slice(0, 64)}`}
          >
            <p className="text-muted-foreground text-xs">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">
              {slice.text}
            </pre>
          </div>
        ))}
      </div>
    )

  return (
    <DiffWorkerPoolProvider>
      <div className="flex h-full min-h-0 flex-col">
        {toolbar}
        {/* Above the code, closed, and counted: these belong to the change
            rather than to any line of it. */}
        {orphanFiles.size > 0 ? (
          <Collapsible
            className="shrink-0 border-border/60 border-b"
            onOpenChange={setOrphansOpen}
            open={orphansOpen}
          >
            <h2>
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-muted-foreground text-xs">
                <span>
                  {nextCursor === null
                    ? 'Conversations not on the current diff'
                    : 'Conversations not on the diff loaded so far'}
                </span>
                <ChevronRight
                  aria-hidden
                  className={cn(
                    'size-3.5 transition-transform',
                    orphansOpen && 'rotate-90'
                  )}
                />
                <span aria-hidden className="tabular-nums">
                  {orphanThreads.length}
                </span>
                <span className="sr-only">
                  {orphanThreads.length === 1
                    ? '1 conversation'
                    : `${orphanThreads.length} conversations`}
                </span>
              </CollapsibleTrigger>
            </h2>
            <CollapsibleContent>
              {/* Capped: opened on a change with dozens of them, this would
                  otherwise leave no room for the diff it sits above. */}
              <div className="max-h-64 space-y-3 overflow-auto px-4 pb-3">
                {[...orphanFiles].map(([path, threads]) => (
                  <div key={path}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <p className="truncate px-3 text-muted-foreground text-xs">
                            {path}
                          </p>
                        }
                      />
                      <TooltipContent side="top">{path}</TooltipContent>
                    </Tooltip>
                    <div className="mt-1 space-y-2">
                      {threads.map((thread) => (
                        <div key={thread.id}>
                          {thread.line === null ? null : (
                            <p className="px-3 text-muted-foreground text-xs">
                              Line {thread.line}
                            </p>
                          )}
                          {renderThreadCard(thread)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {/* Relative wrapper so the review overlay floats over the diff; the
            viewer inside still owns its own scrolling. */}
        <div
          className="relative min-h-0 flex-1"
          // The whole header row is the collapse target a reader aims for.
          // The header lives in the viewer's shadow tree, so the capture
          // listener walks `composedPath`.
          onClickCapture={(event) => {
            const composedPath = event.nativeEvent.composedPath?.() ?? []
            for (const node of composedPath) {
              if (!(node instanceof HTMLElement)) {
                continue
              }
              // A control inside the header — the collapse chevron —
              // handles itself.
              if (
                node instanceof HTMLButtonElement ||
                node instanceof HTMLAnchorElement
              ) {
                return
              }
              if (node.hasAttribute('data-diffs-header')) {
                const filePath = node
                  .querySelector('[data-title]')
                  ?.textContent?.trim()
                if (filePath === undefined || filePath === '') {
                  return
                }
                const item = items.find(
                  (candidate) =>
                    resolveFileDiffPath(candidate.fileDiff) === filePath
                )
                if (item !== undefined) {
                  toggleFile(item.id)
                }
                return
              }
            }
          }}
        >
          {/* The viewer virtualizes against the element it is told is
              scrolling, so it has to own that element. */}
          <StyledDiffCodeView<ReviewAnnotationGroup>
            className="h-full overflow-auto [scrollbar-gutter:stable]"
            items={items}
            onSelectedLinesChange={setSelectedLines}
            options={diffViewOptions}
            renderAnnotation={renderAnnotation}
            renderCodeViewFooter={renderCodeViewFooter}
            renderGutterUtility={renderGutterUtility}
            renderHeaderMetadata={renderHeaderMetadata}
            renderHeaderPrefix={renderHeaderPrefix}
            selectedLines={selectedLines}
            unsafeCSSExtra={REPLACE_FILE_COUNTS_CSS}
          />
          {reviewOverlay}
        </div>
        {unstructured}
      </div>
    </DiffWorkerPoolProvider>
  )
}

export default PullRequestCodeTab
