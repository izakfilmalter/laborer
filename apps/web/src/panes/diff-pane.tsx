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
 * 2. `file['watcher.subscribe'](workspaceId)` streams file change events;
 *    relevant events schedule a debounced refresh of the batched diff
 * 3. Stale-while-revalidate: the previous diff stays visible while a
 *    refresh is in flight — the loading screen only shows when there is
 *    no data at all, and a failure with no data shows an error state
 *    with a retry button (never an infinite spinner)
 * 4. Each fetch attempt has a timeout and bounded retries, so pending
 *    always terminates
 * 5. `useTransition` defers expensive FileDiff re-renders
 *
 * ## Huge-diff safety (modeled on opencode + t3code)
 *
 * Large diffs used to crash the pane: every line of every file was
 * rendered to the DOM and highlighted on the main thread. Three layers
 * now bound the work:
 *
 * 1. **Virtualization** — the file list is wrapped in Pierre's
 *    `Virtualizer`, which switches every `FileDiff` to
 *    `VirtualizedFileDiff` (IntersectionObserver windowing; off-screen
 *    content becomes sized buffer placeholders)
 * 2. **Worker pool** — `DiffWorkerPoolProvider` moves shiki syntax
 *    highlighting off the main thread
 * 3. **Per-file gates** — files with more than
 *    {@link MAX_DIFF_CHANGED_LINES} changed lines render a placeholder
 *    with a "Render anyway" button (opencode-style); files whose patch
 *    exceeds {@link LARGE_PATCH_BYTES} render without intra-line word
 *    diffs; server-truncated entries render an inert notice instead of
 *    being silently dropped
 *
 * ## Click-to-open file (Issue #112)
 *
 * Each file has a clickable "Open" button in its header that calls the
 * `editor.open` RPC mutation.
 *
 * The pane is purely visual: it never modifies the diff or the worktree.
 * The only interactive affordances are navigational (open-in-editor,
 * close, retry, cross-pane scroll-to-line).
 *
 * @see packages/server/src/services/file-service.ts — server-side FileService
 * @see docs/lazy-file-service/PRD.md — Lazy File Service PRD
 */

import {
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from '@effect/atom-react/Hooks'
import type { FileDiffEntry, FileWatcherEvent } from '@laborer/shared/rpc'
import { RpcError } from '@laborer/shared/rpc'
import type { FileDiffMetadata } from '@pierre/diffs'
import { FileDiff, Virtualizer } from '@pierre/diffs/react'
import { Cause, Effect, Option } from 'effect'
import { Atom, AsyncResult as Result } from 'effect/unstable/reactivity'
import {
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
import { fileWatcherEventsAtom } from '@/atoms/file-watcher'
import { LaborerClient } from '@/atoms/laborer-client'
import { DiffWorkerPoolProvider } from '@/components/diff-worker-pool-provider'
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
      Effect.timeoutOrElse({
        duration: DIFF_FETCH_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new RpcError({
              message: 'Timed out computing the workspace diff',
              code: 'TIMEOUT',
            })
          ),
      })
    )
  )
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_DIFF_OPTIONS_SPLIT = {
  diffStyle: 'split' as const,
  theme: { dark: 'pierre-dark' as const, light: 'pierre-light' as const },
  themeType: 'dark' as const,
  diffIndicators: 'bars' as const,
  lineDiffType: 'word-alt' as const,
  overflow: 'wrap' as const,
}

const FILE_DIFF_OPTIONS_UNIFIED = {
  diffStyle: 'unified' as const,
  theme: { dark: 'pierre-dark' as const, light: 'pierre-light' as const },
  themeType: 'dark' as const,
  diffIndicators: 'bars' as const,
  lineDiffType: 'word-alt' as const,
  overflow: 'wrap' as const,
}

/**
 * Degraded options for huge patches: intra-line word diffing is O(n*m)
 * per changed line pair and dominates render cost on large files.
 * Mirrors opencode's `largeOptions` (`lineDiffType: "none"`).
 */
const FILE_DIFF_OPTIONS_SPLIT_PLAIN = {
  ...FILE_DIFF_OPTIONS_SPLIT,
  lineDiffType: 'none' as const,
}

const FILE_DIFF_OPTIONS_UNIFIED_PLAIN = {
  ...FILE_DIFF_OPTIONS_UNIFIED,
  lineDiffType: 'none' as const,
}

/**
 * Files with more changed lines than this render a placeholder with a
 * "Render anyway" button instead of the diff. Same threshold opencode
 * uses (`MAX_DIFF_CHANGED_LINES = 500` in session-review.tsx).
 */
const MAX_DIFF_CHANGED_LINES = 500

/**
 * Patches larger than this render without intra-line word diffs.
 * Matches opencode's 500KB degradation threshold.
 */
const LARGE_PATCH_BYTES = 500_000

/**
 * Virtualizer windowing config, borrowed from t3code's DiffPanel:
 * observe 1200px beyond the viewport and keep 600px of overscroll
 * rendered so fast scrolling doesn't flash empty buffers.
 */
const VIRTUALIZER_CONFIG = {
  overscrollSize: 600,
  intersectionObserverMargin: 1200,
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
// Types
// ---------------------------------------------------------------------------

interface DiffPaneProps {
  readonly onClose?: (() => void) | undefined
  readonly workspaceId: string
}

/**
 * A changed file ready for rendering. `fileDiff` is `null` when the
 * server omitted the patch because it exceeded the size budget
 * (`entry.truncated`) — those render an inert placeholder.
 */
interface RenderableFileDiff {
  readonly entry: FileDiffEntry
  readonly fileDiff: FileDiffMetadata | null
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

/**
 * Shared stats line for diff placeholders: path plus +added/−removed.
 */
function DiffPlaceholderStats({ entry }: { readonly entry: FileDiffEntry }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate font-mono text-foreground text-xs">
        {entry.path}
      </span>
      <span className="shrink-0 text-xs">
        <span className="text-green-500">+{entry.added}</span>{' '}
        <span className="text-red-500">-{entry.removed}</span>
      </span>
    </div>
  )
}

/**
 * Rendered instead of a FileDiff when the file has more than
 * {@link MAX_DIFF_CHANGED_LINES} changed lines. Opting in via "Render
 * anyway" is per-file and survives watcher-driven refreshes.
 */
function LargeDiffPlaceholder({
  entry,
  onRender,
}: {
  readonly entry: FileDiffEntry
  readonly onRender: () => void
}) {
  return (
    <div className="m-2 flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <DiffPlaceholderStats entry={entry} />
        <span className="text-muted-foreground text-xs">
          Large diff — skipped to keep the app responsive.
        </span>
      </div>
      <Button onClick={onRender} size="sm" variant="outline">
        Render anyway
      </Button>
    </div>
  )
}

/**
 * Rendered when the server omitted the patch entirely because it
 * exceeded the per-file or total byte budget (`entry.truncated`).
 * There is nothing to render anyway — the patch never left the server.
 */
function TruncatedDiffPlaceholder({
  entry,
}: {
  readonly entry: FileDiffEntry
}) {
  return (
    <div className="m-2 flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <DiffPlaceholderStats entry={entry} />
        <span className="text-muted-foreground text-xs">
          Diff exceeds the size budget and was not loaded. Open the file in the
          editor to inspect it.
        </span>
      </div>
      <TriangleAlert className="size-4 shrink-0 text-muted-foreground" />
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
  readonly orderedFileDiffs: readonly RenderableFileDiff[]
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
  const watcherAtom = fileWatcherEventsAtom(workspaceId)
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
    const { items } = watcherResult.value as {
      readonly items: readonly (FileWatcherEvent | undefined)[]
    }
    const startIndex = lastProcessedIndexRef.current

    if (items.length <= startIndex) {
      return
    }

    const newEvents = items
      .slice(startIndex)
      .filter((event): event is FileWatcherEvent => event !== undefined)
    lastProcessedIndexRef.current = items.length

    if (hasRelevantWatcherEvent(newEvents)) {
      scheduleRefresh()
    }
  }, [watcherResult, scheduleRefresh])

  // --- Build ordered list ---
  const orderedFileDiffs = useMemo(() => {
    const parsed: RenderableFileDiff[] = []
    for (const entry of changedFiles) {
      const fileDiff = parseFileDiffEntry(entry)
      if (fileDiff) {
        parsed.push({ entry, fileDiff })
      } else if (entry.truncated) {
        // Patch omitted by the server-side size budget — keep the
        // entry so the user sees why the file is missing instead of
        // it silently disappearing.
        parsed.push({ entry, fileDiff: null })
      }
      // Entries with no patch and truncated=false are binary files —
      // skipped, matching previous behavior.
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
// DiffPaneContent — mounted only after Phase 4 (Eventually)
// ---------------------------------------------------------------------------

function DiffPaneContent({ onClose, workspaceId }: DiffPaneProps) {
  const openEditor = useAtomSet(editorOpenMutation, { mode: 'promise' })

  const { changedFiles, errorMessage, loading, orderedFileDiffs, refresh } =
    useDiffStore(workspaceId)

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
  const plainDiffOptions = useUnified
    ? FILE_DIFF_OPTIONS_UNIFIED_PLAIN
    : FILE_DIFF_OPTIONS_SPLIT_PLAIN

  // --- Deferred rendering ---
  const [isTransitionPending, startTransition] = useTransition()
  const [deferredFileDiffs, setDeferredFileDiffs] = useState(orderedFileDiffs)

  useEffect(() => {
    startTransition(() => {
      setDeferredFileDiffs(orderedFileDiffs)
    })
  }, [orderedFileDiffs])

  // --- Per-file "Render anyway" opt-ins for large diffs ---
  const [forcedPaths, setForcedPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  )

  const forceRenderPath = useCallback((path: string) => {
    setForcedPaths((prev) => {
      const next = new Set(prev)
      next.add(path)
      return next
    })
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

  // --- Cross-pane diff scroll ---
  // File wrappers carry `data-diff-file-path`; resolve by attribute
  // comparison instead of child index because the Virtualizer inserts
  // its own content wrapper between the scroll root and the files.
  useOnDiffScrollRequest(
    workspaceId,
    useCallback((target: { file: string; line: number }) => {
      const container = containerRef.current
      if (!container) {
        return
      }
      const fileElements = container.querySelectorAll('[data-diff-file-path]')
      for (const fileElement of fileElements) {
        if (fileElement.getAttribute('data-diff-file-path') === target.file) {
          fileElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
          return
        }
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

      <div className="min-h-0 flex-1" data-pane-text-selectable>
        <Virtualizer
          className="h-full select-text overflow-y-auto overflow-x-hidden"
          config={VIRTUALIZER_CONFIG}
        >
          {deferredFileDiffs.map(({ entry, fileDiff }) => {
            if (fileDiff === null) {
              return (
                <div
                  data-diff-file-path={entry.path}
                  data-file-path={entry.path}
                  data-testid="diff-file"
                  key={entry.path}
                >
                  <TruncatedDiffPlaceholder entry={entry} />
                </div>
              )
            }

            const changedLines = entry.added + entry.removed
            const tooLarge =
              changedLines > MAX_DIFF_CHANGED_LINES &&
              !forcedPaths.has(entry.path)
            if (tooLarge) {
              return (
                <div
                  data-diff-file-path={entry.path}
                  data-file-path={entry.path}
                  data-testid="diff-file"
                  key={entry.path}
                >
                  <LargeDiffPlaceholder
                    entry={entry}
                    onRender={() => forceRenderPath(entry.path)}
                  />
                </div>
              )
            }

            const hugePatch = (entry.patch?.length ?? 0) > LARGE_PATCH_BYTES
            return (
              <div
                data-diff-file-path={entry.path}
                data-file-path={entry.path}
                data-testid="diff-file"
                key={entry.path}
              >
                <FileDiff
                  className="select-text"
                  fileDiff={fileDiff}
                  options={hugePatch ? plainDiffOptions : diffOptions}
                  renderHeaderMetadata={renderHeaderMetadata}
                />
              </div>
            )
          })}
        </Virtualizer>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DiffPane — outer wrapper with lifecycle phase gating
// ---------------------------------------------------------------------------

function DiffPane({ onClose, workspaceId }: DiffPaneProps) {
  const isEventually = useWhenPhase(LifecyclePhase.Eventually)

  return (
    <div
      className="h-full"
      data-testid="diff-pane"
      data-workspace-id={workspaceId}
    >
      {isEventually ? (
        <DiffWorkerPoolProvider>
          <DiffPaneContent onClose={onClose} workspaceId={workspaceId} />
        </DiffWorkerPoolProvider>
      ) : (
        <DiffPaneLoading onClose={onClose} />
      )}
    </div>
  )
}

export { DiffPane }
