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
 * 1. **Virtualization** — every file is an item of a single Pierre
 *    `CodeView`, which owns the scroll container and windows both the
 *    file list and the lines within a file
 * 2. **Worker pool** — `DiffWorkerPoolProvider` moves shiki syntax
 *    highlighting off the main thread
 * 3. **Gates** — files with more than {@link MAX_DIFF_CHANGED_LINES}
 *    changed lines start collapsed, so the header is there to expand
 *    but the body costs nothing; a total patch payload beyond
 *    {@link LARGE_PATCH_BYTES} drops intra-line word diffs, which are
 *    O(n*m) per changed line pair; server-truncated entries render an
 *    inert notice instead of being silently dropped
 *
 * ## Click-to-open file (Issue #112)
 *
 * Each file has a clickable "Open" button in its header that calls the
 * `editor.open` RPC mutation. The header chevron collapses the file.
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
import { Button } from '@laborer/ui/components/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@laborer/ui/components/empty'
import { Spinner } from '@laborer/ui/components/spinner'
import type { CodeViewItem, FileDiffMetadata } from '@pierre/diffs'
import type { CodeViewHandle } from '@pierre/diffs/react'
import { Cause, Effect, Option } from 'effect'
import { Atom, AsyncResult as Result } from 'effect/unstable/reactivity'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode2,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import type { MouseEvent as ReactMouseEvent } from 'react'
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
import { StyledDiffCodeView } from '@/components/styled-diff-code-view'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { extractErrorMessage } from '@/lib/errors'
import { parseFileDiffEntry } from '@/lib/file-diff'
import { fnv1a32 } from '@/lib/fnv1a32'
import { toast } from '@/lib/toast'
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

/**
 * Options shared by both diff styles. `stickyHeaders` keeps the current
 * file's header pinned while scrolling its body, which is what the 32px
 * header in the injected stylesheet is sized for.
 */
const DIFF_OPTIONS_BASE = {
  theme: { dark: 'pierre-dark' as const, light: 'pierre-light' as const },
  diffIndicators: 'bars' as const,
  lineDiffType: 'word-alt' as const,
  overflow: 'wrap' as const,
  hunkSeparators: 'line-info' as const,
  stickyHeaders: true,
}

/**
 * Files with more changed lines than this start collapsed: the header
 * is still there to expand from, but nothing is parsed or highlighted
 * until it is. Same threshold opencode uses
 * (`MAX_DIFF_CHANGED_LINES = 500` in session-review.tsx).
 */
const MAX_DIFF_CHANGED_LINES = 500

/**
 * Once the whole payload passes this, intra-line word diffs are dropped
 * for the view. Word diffing is O(n*m) per changed line pair and
 * dominates render cost. Matches opencode's 500KB threshold — the
 * viewer takes one set of options for every item, so the degradation is
 * view-wide rather than per file.
 */
const LARGE_PATCH_BYTES = 500_000

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

  // --- Theme ---
  // The viewer picks its syntax palette from `themeType`; the surrounding
  // chrome follows the app's tokens through `unsafeCSS`. Both have to
  // track the active theme or the code body fights the pane around it.
  const { resolvedTheme } = useTheme()
  const themeType =
    resolvedTheme === 'light' ? ('light' as const) : ('dark' as const)

  // --- Deferred rendering ---
  const [isTransitionPending, startTransition] = useTransition()
  const [deferredFileDiffs, setDeferredFileDiffs] = useState(orderedFileDiffs)

  useEffect(() => {
    startTransition(() => {
      setDeferredFileDiffs(orderedFileDiffs)
    })
  }, [orderedFileDiffs])

  const totalPatchBytes = deferredFileDiffs.reduce(
    (total, { entry }) => total + (entry.patch?.length ?? 0),
    0
  )

  const diffOptions = useMemo(
    () => ({
      ...DIFF_OPTIONS_BASE,
      diffStyle: useUnified ? ('unified' as const) : ('split' as const),
      lineDiffType:
        totalPatchBytes > LARGE_PATCH_BYTES
          ? ('none' as const)
          : DIFF_OPTIONS_BASE.lineDiffType,
      themeType,
    }),
    [useUnified, themeType, totalPatchBytes]
  )

  // --- Per-file collapse ---
  // Large files start collapsed and expanding one is the "render anyway"
  // opt-in; every file can also be collapsed from its header chevron.
  const [collapseOverrides, setCollapseOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map())

  const isCollapsed = useCallback(
    (entry: FileDiffEntry) =>
      collapseOverrides.get(entry.path) ??
      entry.added + entry.removed > MAX_DIFF_CHANGED_LINES,
    [collapseOverrides]
  )

  const toggleCollapsed = useCallback((path: string, collapsed: boolean) => {
    setCollapseOverrides((previous) => {
      const next = new Map(previous)
      next.set(path, !collapsed)
      return next
    })
  }, [])

  // --- Viewer items ---
  // The viewer only re-reads an item whose `version` changed, so the
  // version has to cover everything the item carries: the patch itself
  // and whether it is collapsed.
  const items = useMemo<CodeViewItem[]>(
    () =>
      deferredFileDiffs.flatMap(({ entry, fileDiff }) => {
        if (fileDiff === null) {
          return []
        }
        const collapsed = isCollapsed(entry)
        return [
          {
            id: entry.path,
            type: 'diff' as const,
            fileDiff,
            collapsed,
            version: fnv1a32(`${collapsed ? '1' : '0'}:${entry.patch ?? ''}`),
          },
        ]
      }),
    [deferredFileDiffs, isCollapsed]
  )

  /** Files whose patch never left the server — nothing to render. */
  const truncatedEntries = useMemo(
    () =>
      deferredFileDiffs.flatMap(({ entry, fileDiff }) =>
        fileDiff === null ? [entry] : []
      ),
    [deferredFileDiffs]
  )

  const viewerRef = useRef<CodeViewHandle<undefined>>(null)

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

  /**
   * Clicking a file's name opens it, the way t3code's diff panel does.
   * The name is painted by the viewer inside its shadow root, so the
   * click is caught on the way down and resolved through the composed
   * path; the header's own controls keep their actions.
   */
  const handleHeaderClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const composedPath = event.nativeEvent.composedPath()
      for (const node of composedPath) {
        if (
          node instanceof HTMLButtonElement ||
          node instanceof HTMLAnchorElement
        ) {
          return
        }
      }
      const title = composedPath.find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.hasAttribute('data-title')
      )
      const filePath = title?.textContent?.trim()
      if (filePath) {
        handleOpenFile(filePath)
      }
    },
    [handleOpenFile]
  )

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem) => {
      const filePath = item.id
      return (
        <button
          aria-label={`Open ${filePath} in editor`}
          className="ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
          data-diff-file-path={filePath}
          onClick={(event) => {
            event.stopPropagation()
            handleOpenFile(filePath)
          }}
          title={`Open ${filePath} in editor`}
          type="button"
        >
          <ExternalLink className="h-3 w-3" />
          Open
        </button>
      )
    },
    [handleOpenFile]
  )

  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem) => {
      const collapsed = item.collapsed === true
      const Chevron = collapsed ? ChevronRight : ChevronDown
      return (
        <button
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${item.id}`}
          className="-ms-0.5 mr-0.5 inline-flex items-center rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation()
            toggleCollapsed(item.id, collapsed)
          }}
          type="button"
        >
          <Chevron className="size-3.5" />
        </button>
      )
    },
    [toggleCollapsed]
  )

  // --- Cross-pane diff scroll ---
  // The viewer owns the scroll container and virtualizes items, so the
  // target line usually has no DOM node yet; its handle resolves the
  // position from the item's measured layout instead.
  useOnDiffScrollRequest(
    workspaceId,
    useCallback((target: { file: string; line: number }) => {
      viewerRef.current?.scrollTo({
        type: 'line',
        id: target.file,
        lineNumber: target.line,
        align: 'center',
        behavior: 'smooth',
      })
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
          <span className="inline-flex h-3 w-3 animate-spin">
            <RefreshCw className="size-full" />
          </span>
          Updating...
        </div>
      )}

      {/* The click target is the viewer's own filename node inside its
          shadow root; every header's Open button is the keyboard path to
          the same action. */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-pane-text-selectable
        onClickCapture={handleHeaderClickCapture}
      >
        {truncatedEntries.length > 0 && (
          <div className="shrink-0">
            {truncatedEntries.map((entry) => (
              <TruncatedDiffPlaceholder entry={entry} key={entry.path} />
            ))}
          </div>
        )}
        <StyledDiffCodeView
          className="min-h-0 flex-1 select-text overflow-auto"
          items={items}
          options={diffOptions}
          renderHeaderMetadata={renderHeaderMetadata}
          renderHeaderPrefix={renderHeaderPrefix}
          viewerRef={viewerRef}
        />
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

  return (
    <DiffWorkerPoolProvider>
      <DiffPaneContent onClose={onClose} workspaceId={workspaceId} />
    </DiffWorkerPoolProvider>
  )
}

export { DiffPane }
