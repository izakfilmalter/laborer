/**
 * Diff viewer pane component — renders per-file git diffs using @pierre/diffs.
 *
 * Fetches the list of changed files via the `file.status` RPC and renders
 * per-file diffs fetched on-demand via `file.read`. Subscribes to the
 * `file.watcher.subscribe` streaming RPC for reactive invalidation —
 * when files change on disk, the affected file diff or status list is
 * re-fetched automatically.
 *
 * ## On-demand architecture (Issue 7)
 *
 * The diff viewer updates **live** without polling or LiveStore:
 *
 * 1. On mount, `file.status(workspaceId)` fetches the list of changed files
 * 2. For each changed file, `file.read(workspaceId, filePath)` fetches
 *    per-file content + diff against HEAD
 * 3. `file.watcher.subscribe(workspaceId)` streams file change events
 * 4. When a watcher event indicates a file change, the affected file's
 *    diff is re-fetched via `file.read`; when files are added/removed,
 *    `file.status` is re-fetched to update the sidebar
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
 * @see Issue 7: Client diff pane — On-demand per-file diffs
 */

import { Result } from '@effect-atom/atom'
import {
  useAtomMount,
  useAtomSet,
  useAtomValue,
} from '@effect-atom/atom-react/Hooks'
import type { FileInfo } from '@laborer/shared/rpc'
import type { AnnotationSide, FileDiffMetadata, Hunk } from '@pierre/diffs'
import { diffAcceptRejectHunk, parsePatchFiles } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import { Check, ExternalLink, FileCode2, RefreshCw, X } from 'lucide-react'
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
import { toast } from '@/lib/toast'
import { extractErrorMessage } from '@/lib/utils'
import { useOnDiffScrollRequest } from '@/panels/diff-scroll-context'

// ---------------------------------------------------------------------------
// Module-level atoms — shared across all DiffPane instances.
// ---------------------------------------------------------------------------

/** Mutation atom for opening files in the editor. */
const editorOpenMutation = LaborerClient.mutation('editor.open')

/** Mutation atom for fetching workspace-level changed file summary. */
const fileStatusMutation = LaborerClient.mutation('file.status')

/** Mutation atom for reading a single file's content + diff. */
const fileReadMutation = LaborerClient.mutation('file.read')

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

// ---------------------------------------------------------------------------
// Watcher event processing (pure function for testability)
// ---------------------------------------------------------------------------

interface WatcherEventAction {
  readonly filesToRefresh: ReadonlySet<string>
  readonly statusChanged: boolean
}

/**
 * Process a batch of watcher events and determine what actions to take.
 * Returns which individual files need diff re-fetch and whether the
 * status list needs re-fetching.
 */
const processWatcherEvents = (
  events: readonly { file: string; event: string }[],
  displayedPaths: readonly string[]
): WatcherEventAction => {
  let statusChanged = false
  const filesToRefresh = new Set<string>()

  for (const event of events) {
    const { file: path, event: kind } = event
    if (path.startsWith('.git/') || path === '.git') {
      continue
    }
    if (kind === 'add' || kind === 'unlink') {
      statusChanged = true
    }
    if (kind === 'change') {
      if (displayedPaths.includes(path)) {
        filesToRefresh.add(path)
      }
      statusChanged = true
    }
  }

  return { filesToRefresh, statusChanged }
}

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

/** Parsed diff data for a single file, fetched via file.read. */
interface FileDiffData {
  readonly error: string | null
  readonly fileDiff: FileDiffMetadata | null
  readonly loading: boolean
  readonly path: string
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
            Fetching changed files from the workspace
          </p>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Custom hook: useDiffStore — manages fetching + invalidation of diffs
// ---------------------------------------------------------------------------

interface DiffStoreResult {
  readonly changedFiles: readonly FileInfo[]
  readonly fetchFileDiff: (path: string) => Promise<void>
  readonly orderedFileDiffs: readonly FileDiffMetadata[]
  readonly statusLoading: boolean
}

/**
 * Hook that manages the diff data lifecycle:
 * 1. Fetches file.status on mount to get the changed file list
 * 2. Fetches file.read for each changed file to get per-file diffs
 * 3. Subscribes to file.watcher.subscribe for reactive invalidation
 * 4. Returns the ordered list of FileDiffMetadata for rendering
 */
function useDiffStore(workspaceId: string): DiffStoreResult {
  const fetchFileStatus = useAtomSet(fileStatusMutation, { mode: 'promise' })
  const fetchFileRead = useAtomSet(fileReadMutation, { mode: 'promise' })

  const [statusLoading, setStatusLoading] = useState(true)
  const [changedFiles, setChangedFiles] = useState<readonly FileInfo[]>([])
  const [fileDiffs, setFileDiffs] = useState<Map<string, FileDiffData>>(
    new Map()
  )

  // --- Fetch file status ---
  const refreshFileStatus = useCallback(async (): Promise<
    readonly FileInfo[]
  > => {
    try {
      const result = await fetchFileStatus({
        payload: { workspaceId },
      })
      const files = result as readonly FileInfo[]
      setChangedFiles(files)
      setStatusLoading(false)
      return files
    } catch {
      setChangedFiles([])
      setStatusLoading(false)
      return []
    }
  }, [fetchFileStatus, workspaceId])

  // --- Fetch a single file's diff ---
  const fetchFileDiff = useCallback(
    async (filePath: string) => {
      setFileDiffs((prev) => {
        const next = new Map(prev)
        next.set(filePath, {
          path: filePath,
          fileDiff: prev.get(filePath)?.fileDiff ?? null,
          loading: true,
          error: null,
        })
        return next
      })

      try {
        const result = (await fetchFileRead({
          payload: { workspaceId, filePath },
        })) as { type: string; content: string; diff?: string }

        let parsedFileDiff: FileDiffMetadata | null = null
        if (result.diff) {
          const parsed = parsePatchFiles(result.diff)
          const allFiles = parsed.flatMap((p) => p.files)
          parsedFileDiff = allFiles[0] ?? null
        }

        setFileDiffs((prev) => {
          const next = new Map(prev)
          next.set(filePath, {
            path: filePath,
            fileDiff: parsedFileDiff,
            loading: false,
            error: null,
          })
          return next
        })
      } catch (error: unknown) {
        setFileDiffs((prev) => {
          const next = new Map(prev)
          next.set(filePath, {
            path: filePath,
            fileDiff: null,
            loading: false,
            error: extractErrorMessage(error),
          })
          return next
        })
      }
    },
    [fetchFileRead, workspaceId]
  )

  const fetchFileDiffRef = useRef(fetchFileDiff)
  fetchFileDiffRef.current = fetchFileDiff
  const refreshFileStatusRef = useRef(refreshFileStatus)
  refreshFileStatusRef.current = refreshFileStatus

  // --- Initial load ---
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const files = await refreshFileStatus()
      if (cancelled) {
        return
      }
      await Promise.all(files.map((f) => fetchFileDiff(f.path)))
    }
    load()
    return () => {
      cancelled = true
    }
  }, [refreshFileStatus, fetchFileDiff])

  // --- Watcher subscription for invalidation ---
  const watcherAtom = useMemo(() => getWatcherAtom(workspaceId), [workspaceId])
  useAtomMount(watcherAtom)
  const watcherResult = useAtomValue(watcherAtom)

  const lastProcessedIndexRef = useRef(0)
  const changedFilesRef = useRef(changedFiles)
  changedFilesRef.current = changedFiles

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

    const displayedPaths = changedFilesRef.current.map((f) => f.path)
    const actions = processWatcherEvents(newEvents, displayedPaths)

    for (const path of actions.filesToRefresh) {
      fetchFileDiffRef.current(path)
    }

    if (actions.statusChanged) {
      refreshFileStatusRef.current().then((newFiles) => {
        const currentPaths = new Set(displayedPaths)
        for (const f of newFiles) {
          if (!currentPaths.has(f.path)) {
            fetchFileDiffRef.current(f.path)
          }
        }
      })
    }
  }, [watcherResult])

  // --- Build ordered list ---
  const orderedFileDiffs = useMemo(() => {
    const result: FileDiffMetadata[] = []
    for (const file of changedFiles) {
      const data = fileDiffs.get(file.path)
      if (data?.fileDiff) {
        result.push(data.fileDiff)
      }
    }
    return result
  }, [changedFiles, fileDiffs])

  return { changedFiles, fetchFileDiff, orderedFileDiffs, statusLoading }
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

  const { changedFiles, orderedFileDiffs, statusLoading } =
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
    (props: { fileDiff?: FileDiffMetadata }) => {
      const fileName = props.fileDiff?.name
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

  // --- Loading state ---
  if (statusLoading) {
    return <DiffPaneLoading onClose={onClose} />
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
        className="min-h-0 flex-1 overflow-auto"
        onScroll={handleScroll}
        ref={scrollContainerRef}
      >
        {deferredFileDiffs.map((fileDiffMeta, index) => (
          <FileDiff
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
