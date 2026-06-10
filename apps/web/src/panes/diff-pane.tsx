/**
 * Diff viewer pane component — renders per-file git diffs using @pierre/diffs.
 *
 * Fetches all changed files **with their patches in a single batched
 * `file.diff` RPC** (modeled on opencode's `/instance/vcs/diff` and
 * t3code's review diff preview). Subscribes to the
 * `file.watcher.subscribe` streaming RPC for reactive invalidation —
 * when files change on disk, the batched diff is re-fetched (debounced).
 *
 * ## Batched architecture
 *
 * 1. On mount, `file.diff(workspaceId)` fetches every changed file with
 *    its unified diff patch in one round-trip
 * 2. `file.watcher.subscribe(workspaceId)` streams file change events;
 *    relevant events schedule a debounced refresh of the batched diff
 * 3. Stale-while-revalidate: the previous diff stays visible while a
 *    refresh is in flight — the loading screen only shows when there is
 *    no data at all, and a failure with no data shows an error state
 *    with a retry button (never an infinite spinner)
 * 4. Each fetch attempt has a timeout and bounded retries, so pending
 *    always terminates
 * 5. `useTransition` defers expensive FileDiff re-renders
 * 6. Scroll position is preserved across updates
 *
 * ## Click-to-open file (Issue #112)
 *
 * Each file has a clickable "Open" button in its header that calls the
 * `editor.open` RPC mutation.
 *
 * ## Accept/reject annotations (Issue #88)
 *
 * Each hunk has accept/reject buttons on hover. Uses `diffAcceptRejectHunk`
 * from @pierre/diffs.
 *
 * @see packages/server/src/services/file-service.ts — server-side FileService
 * @see docs/lazy-file-service/PRD.md — Lazy File Service PRD
 */

import { Atom, Result } from '@effect-atom/atom'
import {
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from '@effect-atom/atom-react/Hooks'
import type { FileDiffEntry } from '@laborer/shared/rpc'
import { RpcError } from '@laborer/shared/rpc'
import type { AnnotationSide, FileDiffMetadata, Hunk } from '@pierre/diffs'
import { diffAcceptRejectHunk } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import { Cause, Effect, Option, Schedule } from 'effect'
import {
  Check,
  ExternalLink,
  FileCode2,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { parseFileDiffEntry } from '@/lib/file-diff'
import { toast } from '@/lib/toast'
import { extractErrorMessage } from '@/lib/utils'
import { useOnDiffScrollRequest } from '@/panels/diff-scroll-context'

// ---------------------------------------------------------------------------
// Module-level atoms — shared across all DiffPane instances.
// ---------------------------------------------------------------------------

/** Mutation atom for opening files in the editor. */
const editorOpenMutation = LaborerClient.mutation('editor.open')

/** Per-attempt timeout so a dead connection can never hang the pane. */
const DIFF_FETCH_TIMEOUT = '30 seconds'

/**
 * Bounded retry policy: 2 retries with exponential backoff. Combined
 * with the per-attempt timeout, a fetch always terminates — either with
 * data or with an error the UI can render (with a manual retry button).
 */
const diffRetrySchedule = Schedule.intersect(
  Schedule.exponential('1 second'),
  Schedule.recurs(2)
)

/**
 * Per-workspace query atom for the batched workspace diff.
 *
 * Keyed by workspaceId so concurrent panes never share (and interrupt)
 * each other's in-flight requests — the failure mode that previously
 * left the pane stuck on "Computing diff...".
 */
const fileDiffQuery = Atom.family((workspaceId: string) =>
  LaborerClient.runtime.atom(
    Effect.flatMap(LaborerClient, (client) =>
      client('file.diff', { workspaceId })
    ).pipe(
      Effect.timeoutFail({
        duration: DIFF_FETCH_TIMEOUT,
        onTimeout: () =>
          new RpcError({
            message: 'Timed out computing the workspace diff',
            code: 'TIMEOUT',
          }),
      }),
      Effect.retry(diffRetrySchedule)
    )
  )
)

// ---------------------------------------------------------------------------
// Watcher subscription atom cache
// ---------------------------------------------------------------------------

const watcherAtomCache = new Map<
  string,
  ReturnType<typeof LaborerClient.query>
>()

const getWatcherAtom = (workspaceId: string) => {
  let atom = watcherAtomCache.get(workspaceId)
  if (!atom) {
    atom = LaborerClient.query('file.watcher.subscribe', { workspaceId })
    watcherAtomCache.set(workspaceId, atom)
  }
  return atom
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_DIFF_OPTIONS_SPLIT = {
  diffStyle: 'split' as const,
  theme: { dark: 'pierre-dark' as const, light: 'pierre-light' as const },
  themeType: 'dark' as const,
  diffIndicators: 'bars' as const,
  lineDiffType: 'word-alt' as const,
  overflow: 'scroll' as const,
  enableHoverUtility: true,
}

const FILE_DIFF_OPTIONS_UNIFIED = {
  diffStyle: 'unified' as const,
  theme: { dark: 'pierre-dark' as const, light: 'pierre-light' as const },
  themeType: 'dark' as const,
  diffIndicators: 'bars' as const,
  lineDiffType: 'word-alt' as const,
  overflow: 'scroll' as const,
  enableHoverUtility: true,
}

const UNIFIED_DIFF_THRESHOLD = 500
const UPDATE_FLASH_DURATION = 1500

/** Debounce window for watcher-driven refreshes — agents write in bursts. */
const WATCHER_REFRESH_DEBOUNCE_MS = 300

// ---------------------------------------------------------------------------
// Watcher event processing (pure function for testability)
// ---------------------------------------------------------------------------

/**
 * Determine whether a batch of watcher events should trigger a refresh
 * of the batched diff. Events under `.git/` are internal bookkeeping
 * (index locks, FETCH_HEAD, etc.) and are ignored.
 */
const hasRelevantWatcherEvent = (
  events: readonly { file: string; event: string }[]
): boolean =>
  events.some(
    (event) => !(event.file === '.git' || event.file.startsWith('.git/'))
  )

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function findHunkIndexForLine(
  hunks: readonly Hunk[],
  lineNumber: number,
  side: AnnotationSide
): number {
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]
    if (!hunk) {
      continue
    }
    if (side === 'additions') {
      if (
        lineNumber >= hunk.additionStart &&
        lineNumber < hunk.additionStart + hunk.additionCount
      ) {
        return i
      }
    } else if (
      lineNumber >= hunk.deletionStart &&
      lineNumber < hunk.deletionStart + hunk.deletionCount
    ) {
      return i
    }
  }
  return -1
}

function hunkHasChanges(hunk: Hunk): boolean {
  return hunk.additionLines > 0 || hunk.deletionLines > 0
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiffPaneProps {
  readonly onClose?: (() => void) | undefined
  readonly workspaceId: string
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DiffPaneHeader({
  onClose,
}: {
  readonly onClose?: (() => void) | undefined
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b bg-muted/30 px-3">
      <FileCode2 className="size-3.5 text-muted-foreground" />
      <span className="font-medium text-muted-foreground text-xs">Diff</span>
      {onClose && (
        <div className="ml-auto">
          <Button
            aria-label="Close diff viewer"
            className="size-6"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X className="size-3" />
          </Button>
        </div>
      )}
    </div>
  )
}

function DiffPaneLoading({
  onClose,
}: {
  readonly onClose?: (() => void) | undefined
}) {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <DiffPaneHeader onClose={onClose} />
      <div className="flex flex-1 items-center justify-center gap-3">
        <Spinner className="size-6 text-muted-foreground" />
        <div className="flex flex-col items-center gap-1">
          <p className="font-medium text-muted-foreground text-sm">
            Computing diff...
          </p>
          <p className="text-muted-foreground/70 text-xs">
            Fetching changed files and building patches
          </p>
        </div>
      </div>
    </div>
  )
}

function DiffPaneError({
  message,
  onClose,
  onRetry,
}: {
  readonly message: string
  readonly onClose?: (() => void) | undefined
  readonly onRetry: () => void
}) {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <DiffPaneHeader onClose={onClose} />
      <div className="flex flex-1 items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlert />
            </EmptyMedia>
            <EmptyTitle>Failed to compute diff</EmptyTitle>
            <EmptyDescription>{message}</EmptyDescription>
          </EmptyHeader>
          <Button onClick={onRetry} size="sm" variant="outline">
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        </Empty>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Custom hook: useDiffStore — manages fetching + invalidation of diffs
// ---------------------------------------------------------------------------

interface DiffStoreResult {
  readonly changedFiles: readonly FileDiffEntry[]
  /** Non-null only when there is no data at all to render. */
  readonly errorMessage: string | null
  /** True only when there is no data and no terminal error yet. */
  readonly loading: boolean
  readonly orderedFileDiffs: readonly FileDiffMetadata[]
  readonly refresh: () => void
}

const EMPTY_ENTRIES: readonly FileDiffEntry[] = []

/**
 * Hook that manages the diff data lifecycle:
 * 1. Fetches the batched `file.diff` on mount (one RPC for all files)
 * 2. Subscribes to file.watcher.subscribe for reactive invalidation,
 *    re-fetching the batch (debounced) when relevant files change
 * 3. Keeps the previous diff visible while a refresh is in flight
 *    (stale-while-revalidate) so the pane never regresses to a spinner
 * 4. Returns the ordered list of FileDiffMetadata for rendering
 */
function useDiffStore(workspaceId: string): DiffStoreResult {
  const diffAtom = useMemo(() => fileDiffQuery(workspaceId), [workspaceId])
  const diffResult = useAtomValue(diffAtom)
  const refresh = useAtomRefresh(diffAtom)

  // Stale-while-revalidate: a waiting/failed Result keeps its previous
  // success value, so the previous diff stays visible during refreshes.
  const entriesOption = Result.value(diffResult)
  const changedFiles = Option.getOrElse(entriesOption, () => EMPTY_ENTRIES)
  const hasData = Option.isSome(entriesOption)

  const loading = !(hasData || Result.isFailure(diffResult))
  const errorMessage =
    !hasData && Result.isFailure(diffResult)
      ? extractErrorMessage(Cause.squash(diffResult.cause))
      : null

  // --- Watcher subscription for invalidation (debounced refresh) ---
  const watcherAtom = useMemo(() => getWatcherAtom(workspaceId), [workspaceId])
  useAtomMount(watcherAtom)
  const watcherResult = useAtomValue(watcherAtom)

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current)
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      refreshRef.current()
    }, WATCHER_REFRESH_DEBOUNCE_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
      }
    }
  }, [])

  const lastProcessedIndexRef = useRef(0)

  useEffect(() => {
    if (!Result.isSuccess(watcherResult)) {
      return
    }
    const { items } = watcherResult.value
    const startIndex = lastProcessedIndexRef.current

    if (items.length <= startIndex) {
      return
    }

    const newEvents = items.slice(startIndex).filter(Boolean)
    lastProcessedIndexRef.current = items.length

    if (hasRelevantWatcherEvent(newEvents)) {
      scheduleRefresh()
    }
  }, [watcherResult, scheduleRefresh])

  // --- Build ordered list ---
  const orderedFileDiffs = useMemo(() => {
    const parsed: FileDiffMetadata[] = []
    for (const entry of changedFiles) {
      const fileDiff = parseFileDiffEntry(entry)
      if (fileDiff) {
        parsed.push(fileDiff)
      }
    }
    return parsed
  }, [changedFiles])

  return {
    changedFiles,
    errorMessage,
    loading,
    orderedFileDiffs,
    refresh,
  }
}

// ---------------------------------------------------------------------------
// Custom hook: useAnnotatedDiffs — manages accept/reject overlay state
// ---------------------------------------------------------------------------

interface AnnotatedDiffsResult {
  readonly annotatedDiffs: Map<string, FileDiffMetadata>
  readonly effectiveFileDiffs: readonly FileDiffMetadata[]
  readonly handleHunkAction: (
    fileName: string,
    hunkIndex: number,
    action: 'accept' | 'reject'
  ) => void
}

function useAnnotatedDiffs(
  orderedFileDiffs: readonly FileDiffMetadata[]
): AnnotatedDiffsResult {
  const [annotatedDiffs, setAnnotatedDiffs] = useState<
    Map<string, FileDiffMetadata>
  >(new Map())

  // Reset when base diffs change
  const prevOrderedRef = useRef(orderedFileDiffs)
  useEffect(() => {
    if (orderedFileDiffs !== prevOrderedRef.current) {
      prevOrderedRef.current = orderedFileDiffs
      setAnnotatedDiffs(new Map())
    }
  }, [orderedFileDiffs])

  const effectiveFileDiffs = useMemo(() => {
    if (annotatedDiffs.size === 0) {
      return orderedFileDiffs
    }
    return orderedFileDiffs.map((fd) => annotatedDiffs.get(fd.name) ?? fd)
  }, [orderedFileDiffs, annotatedDiffs])

  const handleHunkAction = useCallback(
    (fileName: string, hunkIndex: number, action: 'accept' | 'reject') => {
      setAnnotatedDiffs((prev) => {
        const currentDiff =
          prev.get(fileName) ??
          orderedFileDiffs.find((fd) => fd.name === fileName)
        if (!currentDiff) {
          return prev
        }
        const updated = diffAcceptRejectHunk(currentDiff, hunkIndex, action)
        const next = new Map(prev)
        next.set(fileName, updated)
        return next
      })
    },
    [orderedFileDiffs]
  )

  return { annotatedDiffs, effectiveFileDiffs, handleHunkAction }
}

// ---------------------------------------------------------------------------
// DiffPaneContent — mounted only after Phase 4 (Eventually)
// ---------------------------------------------------------------------------

function DiffPaneContent({ onClose, workspaceId }: DiffPaneProps) {
  const openEditor = useAtomSet(editorOpenMutation, { mode: 'promise' })

  const { changedFiles, errorMessage, loading, orderedFileDiffs, refresh } =
    useDiffStore(workspaceId)

  const { annotatedDiffs, effectiveFileDiffs, handleHunkAction } =
    useAnnotatedDiffs(orderedFileDiffs)

  const handleHunkActionRef = useRef(handleHunkAction)
  handleHunkActionRef.current = handleHunkAction

  // --- Responsive diff style ---
  const containerRef = useRef<HTMLDivElement>(null)
  const [useUnified, setUseUnified] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setUseUnified(entry.contentRect.width < UNIFIED_DIFF_THRESHOLD)
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const diffOptions = useUnified
    ? FILE_DIFF_OPTIONS_UNIFIED
    : FILE_DIFF_OPTIONS_SPLIT

  // --- Deferred rendering ---
  const [isTransitionPending, startTransition] = useTransition()
  const [deferredFileDiffs, setDeferredFileDiffs] = useState(effectiveFileDiffs)

  useEffect(() => {
    startTransition(() => {
      setDeferredFileDiffs(effectiveFileDiffs)
    })
  }, [effectiveFileDiffs])

  // --- Scroll position preservation ---
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const savedScrollRef = useRef({ top: 0, left: 0 })

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }
    const observer = new MutationObserver(() => {
      container.scrollTop = savedScrollRef.current.top
      container.scrollLeft = savedScrollRef.current.left
    })
    observer.observe(container, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  // --- "Updated" flash indicator ---
  const [showUpdateFlash, setShowUpdateFlash] = useState(false)
  const prevFileDiffsCountRef = useRef(0)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const currentCount = orderedFileDiffs.length
    if (prevFileDiffsCountRef.current > 0 && currentCount > 0) {
      setShowUpdateFlash(true)
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current)
      }
      flashTimerRef.current = setTimeout(() => {
        setShowUpdateFlash(false)
      }, UPDATE_FLASH_DURATION)
    }
    prevFileDiffsCountRef.current = currentCount
  }, [orderedFileDiffs])

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current)
      }
    }
  }, [])

  // --- Click-to-open file in editor ---
  const openEditorRef = useRef(openEditor)
  openEditorRef.current = openEditor

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      try {
        await openEditorRef.current({
          payload: { workspaceId, filePath },
        })
        toast.success(`Opened ${filePath} in editor`)
      } catch (error: unknown) {
        toast.error(`Failed to open file: ${extractErrorMessage(error)}`)
      }
    },
    [workspaceId]
  )

  const renderHeaderMetadata = useCallback(
    (fileDiff: FileDiffMetadata) => {
      const fileName = fileDiff.name
      if (!fileName) {
        return null
      }
      return (
        <button
          className="ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            handleOpenFile(fileName)
          }}
          title={`Open ${fileName} in editor`}
          type="button"
        >
          <ExternalLink className="h-3 w-3" />
          Open
        </button>
      )
    },
    [handleOpenFile]
  )

  const createRenderHoverUtility = useCallback(
    (fileDiffMeta: FileDiffMetadata) => {
      return (
        getHoveredLine: () =>
          | { lineNumber: number; side: AnnotationSide }
          | undefined
      ) => {
        const hovered = getHoveredLine()
        if (!hovered) {
          return null
        }
        const currentDiff =
          annotatedDiffs.get(fileDiffMeta.name) ?? fileDiffMeta
        const hunkIndex = findHunkIndexForLine(
          currentDiff.hunks,
          hovered.lineNumber,
          hovered.side
        )
        if (hunkIndex === -1) {
          return null
        }
        const hunk = currentDiff.hunks[hunkIndex]
        if (!(hunk && hunkHasChanges(hunk))) {
          return null
        }
        return (
          <div className="flex items-center gap-0.5">
            <button
              className="inline-flex items-center gap-0.5 rounded bg-success/15 px-1.5 py-0.5 text-success text-xs transition-colors hover:bg-success/30"
              onClick={(e) => {
                e.stopPropagation()
                handleHunkActionRef.current(
                  fileDiffMeta.name,
                  hunkIndex,
                  'accept'
                )
              }}
              title="Accept this change (keep additions)"
              type="button"
            >
              <Check className="h-3 w-3" />
              Accept
            </button>
            <button
              className="inline-flex items-center gap-0.5 rounded bg-destructive/15 px-1.5 py-0.5 text-destructive text-xs transition-colors hover:bg-destructive/30"
              onClick={(e) => {
                e.stopPropagation()
                handleHunkActionRef.current(
                  fileDiffMeta.name,
                  hunkIndex,
                  'reject'
                )
              }}
              title="Reject this change (keep deletions)"
              type="button"
            >
              <X className="h-3 w-3" />
              Reject
            </button>
          </div>
        )
      }
    },
    [annotatedDiffs]
  )

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (container) {
      savedScrollRef.current = {
        top: container.scrollTop,
        left: container.scrollLeft,
      }
    }
  }, [])

  // --- Cross-pane diff scroll ---
  const deferredFileDiffsRef = useRef(deferredFileDiffs)
  deferredFileDiffsRef.current = deferredFileDiffs

  useOnDiffScrollRequest(
    workspaceId,
    useCallback((target: { file: string; line: number }) => {
      const container = scrollContainerRef.current
      if (!container) {
        return
      }
      const fileDiffsList = deferredFileDiffsRef.current
      const fileIndex = fileDiffsList.findIndex((fd) => fd.name === target.file)
      if (fileIndex === -1) {
        return
      }
      const fileElement = container.children[fileIndex]
      if (fileElement) {
        fileElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }, [])
  )

  // --- Loading state (no data at all yet) ---
  if (loading) {
    return <DiffPaneLoading onClose={onClose} />
  }

  // --- Error state (fetch exhausted retries and there is no data) ---
  if (errorMessage !== null) {
    return (
      <DiffPaneError
        message={errorMessage}
        onClose={onClose}
        onRetry={refresh}
      />
    )
  }

  // --- Empty state ---
  if (changedFiles.length === 0) {
    return (
      <div className="flex h-full w-full flex-col bg-background">
        <DiffPaneHeader onClose={onClose} />
        <div className="flex flex-1 items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileCode2 />
              </EmptyMedia>
              <EmptyTitle>No changes</EmptyTitle>
              <EmptyDescription>
                No file changes detected in this workspace. Changes will appear
                here automatically as the agent modifies files.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </div>
    )
  }

  if (orderedFileDiffs.length === 0) {
    return (
      <div className="flex h-full w-full flex-col bg-background">
        <DiffPaneHeader onClose={onClose} />
        <div className="flex flex-1 items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileCode2 />
              </EmptyMedia>
              <EmptyTitle>No renderable text diffs</EmptyTitle>
              <EmptyDescription>
                The workspace has changes, but none produced a text diff
                preview.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full w-full flex-col bg-background"
      ref={containerRef}
    >
      <DiffPaneHeader onClose={onClose} />

      {showUpdateFlash && (
        <div className="fade-in absolute top-10 right-2 z-10 flex animate-in items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-primary text-xs duration-200">
          <RefreshCw className="h-3 w-3" />
          Updated
        </div>
      )}

      {isTransitionPending && (
        <div className="absolute top-10 left-2 z-10 flex items-center gap-1.5 rounded-md bg-muted/90 px-2 py-1 text-muted-foreground text-xs backdrop-blur-sm">
          <RefreshCw className="h-3 w-3 animate-spin" />
          Updating...
        </div>
      )}

      <div
        className="min-h-0 flex-1 select-text overflow-auto"
        data-pane-text-selectable
        onScroll={handleScroll}
        ref={scrollContainerRef}
      >
        {deferredFileDiffs.map((fileDiffMeta, index) => (
          <FileDiff
            className="select-text"
            fileDiff={fileDiffMeta}
            key={fileDiffMeta.name ?? index}
            options={diffOptions}
            renderHeaderMetadata={renderHeaderMetadata}
            renderHoverUtility={createRenderHoverUtility(fileDiffMeta)}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DiffPane — outer wrapper with lifecycle phase gating
// ---------------------------------------------------------------------------

function DiffPane({ onClose, workspaceId }: DiffPaneProps) {
  const isEventually = useWhenPhase(LifecyclePhase.Eventually)

  if (!isEventually) {
    return <DiffPaneLoading onClose={onClose} />
  }

  return <DiffPaneContent onClose={onClose} workspaceId={workspaceId} />
}

export { DiffPane }
