/**
 * Diff viewer pane component — renders git diff output using @pierre/diffs.
 *
 * Subscribes to the `diffs` table in LiveStore for the given workspace ID.
 * When the DiffService on the server polls `git diff` and commits a
 * `DiffUpdated` event, the reactive query re-fires and the component
 * re-renders with the new diff content.
 *
 * ## Live update architecture (Issue #89)
 *
 * The diff viewer updates **live** without any manual refresh:
 *
 * 1. Server DiffService polls `git diff` on a 2-second interval (Issue #83)
 * 2. DiffUpdated events are committed to LiveStore only when content changes
 *    (deduplication — Issue #84)
 * 3. Events sync to the client via WebSocket (LiveStore sync — Issue #18)
 * 4. This component reads the materialized `diffs` table row via reactive query
 * 5. `useTransition` defers the re-render of the PatchDiff component so large
 *    diffs don't block the UI thread (keeps the app responsive during updates)
 * 6. Scroll position is preserved across updates via a ref on the container div,
 *    so the user doesn't lose their place when the diff changes
 * 7. A brief "Updated" flash indicator appears in the top-right corner when
 *    new diff content arrives, then fades out after 1.5 seconds
 * 8. The `lastUpdated` timestamp is displayed at the bottom of the diff
 *
 * ## Debounce/throttle for rapid changes (Issue #91)
 *
 * When an agent makes rapid file changes, the DiffService may commit
 * multiple `DiffUpdated` events in quick succession. To prevent excessive
 * re-renders and UI lag, the diff content is debounced via `useDebouncedValue`:
 *
 * - Trailing-edge debounce with 300ms delay: intermediate values are skipped,
 *   only the latest value is rendered after updates settle
 * - Maximum wait of 500ms: even under sustained rapid changes, the viewer
 *   shows recent content within 500ms (meeting the acceptance criteria)
 * - `useTransition` is layered on top: after debounce emits, the expensive
 *   FileDiff re-render is deferred so it doesn't block user interactions
 * - The "debounce pending" and "transition pending" states are combined into
 *   a single "Updating..." indicator for a clean UX
 *
 * Performance pipeline: LiveStore event → reactive query → debounce (300ms)
 * → parsePatchFiles → useTransition (deferred) → FileDiff render
 *
 * ## Click-to-open file (Issue #112)
 *
 * Each file in the diff viewer has a clickable "Open" button in its header.
 * Clicking it calls the `editor.open` RPC mutation with the workspace ID
 * and file path, opening the file in the configured editor (Cursor/VS Code).
 * Uses the `renderHeaderMetadata` prop from @pierre/diffs/react FileDiff.
 *
 * ## Accept/reject annotations (Issue #88)
 *
 * Each hunk in the diff viewer has accept/reject buttons that appear when
 * hovering over any line in the hunk. Clicking accept keeps the additions
 * (new code), clicking reject keeps the deletions (old code). Uses
 * `diffAcceptRejectHunk` from @pierre/diffs which transforms the
 * `FileDiffMetadata` immutably. Annotation state is tracked per-file in
 * component state and resets when the underlying diff content changes.
 * The `enableHoverUtility` option enables the hover interaction, and the
 * `renderHoverUtility` React prop renders the accept/reject buttons.
 *
 * @see packages/server/src/services/diff-service.ts
 * @see packages/shared/src/schema.ts (diffs table, DiffUpdated event)
 * @see Issue #87: Diff viewer pane — render with @pierre/diffs
 * @see Issue #88: Diff viewer — accept/reject annotations
 * @see Issue #89: Diff viewer — live update
 * @see Issue #91: Diff viewer debounce/throttle for rapid changes
 * @see Issue #112: Click-to-open file from diff viewer
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { diffs } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
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
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { toast } from '@/lib/toast'
import { extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'
import { useOnDiffScrollRequest } from '@/panels/diff-scroll-context'

/** Module-level query — shared across all DiffPane instances with the same label. */
const allDiffs$ = queryDb(diffs, { label: 'diffPane' })

/** Module-level mutation atom for opening files in the editor (Issue #112). */
const editorOpenMutation = LaborerClient.mutation('editor.open')

/**
 * FileDiff options for split (side-by-side) diff view.
 * Used when the diff pane has enough width (>= 500px).
 * `enableHoverUtility` enables the hover interaction for accept/reject buttons (Issue #88).
 */
const FILE_DIFF_OPTIONS_SPLIT = {
  diffStyle: 'split' as const,
  theme: { dark: 'pierre-dark' as const, light: 'pierre-light' as const },
  themeType: 'dark' as const,
  diffIndicators: 'bars' as const,
  lineDiffType: 'word-alt' as const,
  overflow: 'scroll' as const,
  enableHoverUtility: true,
}

/**
 * FileDiff options for unified (single-column) diff view.
 * Used when the diff pane is narrow (< 500px) to improve readability.
 * `enableHoverUtility` enables the hover interaction for accept/reject buttons (Issue #88).
 *
 * @see Issue #81: Panel responsive layout
 */
const FILE_DIFF_OPTIONS_UNIFIED = {
  diffStyle: 'unified' as const,
  theme: { dark: 'pierre-dark' as const, light: 'pierre-light' as const },
  themeType: 'dark' as const,
  diffIndicators: 'bars' as const,
  lineDiffType: 'word-alt' as const,
  overflow: 'scroll' as const,
  enableHoverUtility: true,
}

/** Width threshold (px) below which diff view switches to unified. */
const UNIFIED_DIFF_THRESHOLD = 500

/** Duration (ms) to show the "Updated" flash indicator. */
const UPDATE_FLASH_DURATION = 1500

interface DiffPaneProps {
  /** Optional close action for the diff side panel header. */
  readonly onClose?: (() => void) | undefined
  /** The workspace ID to display diffs for. */
  readonly workspaceId: string
}

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

/**
 * Formats an ISO timestamp to a locale-appropriate relative time string.
 * Returns "just now" for timestamps within 10 seconds, otherwise a
 * human-readable time string (e.g., "2:34:56 PM").
 */
function formatLastUpdated(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  const now = Date.now()
  const diffMs = now - date.getTime()
  if (diffMs < 10_000) {
    return 'just now'
  }
  return date.toLocaleTimeString()
}

/**
 * Finds the 0-based hunk index that contains a given line number on a given side.
 * Used to determine which hunk the user is hovering over for accept/reject actions.
 *
 * For "additions" side: checks if lineNumber falls within [additionStart, additionStart + additionCount).
 * For "deletions" side: checks if lineNumber falls within [deletionStart, deletionStart + deletionCount).
 *
 * Returns -1 if no hunk contains the given line number (e.g., context lines outside any hunk).
 */
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

/**
 * Checks whether a hunk has any actual changes (additions or deletions).
 * After accept/reject, a hunk is converted to all-context lines (additionLines=0, deletionLines=0).
 * This function returns false for already-resolved hunks to avoid showing accept/reject buttons.
 */
function hunkHasChanges(hunk: Hunk): boolean {
  return hunk.additionLines > 0 || hunk.deletionLines > 0
}

/**
 * DiffPane renders a live diff viewer for a given workspace.
 *
 * It subscribes to the LiveStore `diffs` table and filters by workspace ID.
 * When the server's DiffService detects file changes (via `git diff` polling),
 * it commits DiffUpdated events which sync to the client and trigger a
 * re-render with the new diff content.
 *
 * The raw git diff is parsed via `parsePatchFiles` into per-file metadata,
 * then each file is rendered with `FileDiff` from @pierre/diffs. This
 * supports multi-file diffs (PatchDiff only handles single-file patches).
 *
 * Live updates are smooth: `useTransition` prevents UI blocking during
 * large diff re-renders, scroll position is preserved across updates,
 * and a brief flash indicator shows when new content arrives.
 */
function DiffPane({ onClose, workspaceId }: DiffPaneProps) {
  const store = useLaborerStore()
  const diffRows = store.useQuery(allDiffs$)
  const openEditor = useAtomSet(editorOpenMutation, { mode: 'promise' })

  // --- Responsive diff style: split vs unified based on pane width ---
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

  // --- Derive diff content and metadata from the reactive query ---
  const diffRow = useMemo(() => {
    const row =
      diffRows.find(
        (r: { workspaceId: string }) => r.workspaceId === workspaceId
      ) ?? null

    // Diagnostic logging: helps identify whether the issue is on the
    // server side (no DiffUpdated event committed) or the sync layer
    // (event not reaching the client's LiveStore).
    console.debug(
      `[DiffPane] workspaceId=${workspaceId} diffRows.length=${diffRows.length} matchingRow=${row !== null ? `found (diffLen=${row.diffContent.length}, lastUpdated=${row.lastUpdated})` : 'NULL — no diff row for this workspace'}`,
      row === null
        ? `Available workspaceIds in diffs table: ${diffRows.map((r: { workspaceId: string }) => r.workspaceId.slice(0, 8)).join(', ') || 'none'}`
        : ''
    )

    return row
  }, [diffRows, workspaceId])

  const rawDiffContent = diffRow?.diffContent ?? ''
  const lastUpdated = diffRow?.lastUpdated ?? ''

  // --- Debounce diff content for rapid changes (Issue #91) ---
  // When the DiffService commits multiple DiffUpdated events in quick
  // succession (agent making rapid file changes between 2-second polls),
  // debounce the raw diff content to prevent excessive parsePatchFiles
  // calls and FileDiff re-renders. Trailing-edge debounce with 300ms
  // delay and 500ms max wait ensures the viewer shows recent content
  // within the acceptance criteria threshold.
  const [diffContent, isDebouncePending] = useDebouncedValue(
    rawDiffContent,
    300
  )

  // --- Parse the raw git diff into per-file diff metadata ---
  // parsePatchFiles handles multi-file diffs correctly, returning an array
  // of ParsedPatch objects, each with a .files array of FileDiffMetadata.
  // PatchDiff only supports single-file patches and throws on multi-file input.
  // Parsing runs on the debounced content, so rapid intermediate values
  // are skipped entirely — parsePatchFiles is never called on values that
  // will be superseded within 300ms.
  const fileDiffs = useMemo(() => {
    if (!diffContent) {
      return []
    }
    const parsed = parsePatchFiles(diffContent)
    return parsed.flatMap((p) => p.files)
  }, [diffContent])

  // --- Accept/reject annotation state (Issue #88) ---
  // Tracks per-file accept/reject overrides. When a user accepts or rejects
  // a hunk, the transformed FileDiffMetadata is stored here keyed by file name.
  // Resets when the underlying diff content changes (agent makes more changes).
  const [annotatedDiffs, setAnnotatedDiffs] = useState<
    Map<string, FileDiffMetadata>
  >(new Map())

  // Reset annotation state when the base diff content changes
  const prevDiffContentRef = useRef(diffContent)
  useEffect(() => {
    if (diffContent !== prevDiffContentRef.current) {
      prevDiffContentRef.current = diffContent
      setAnnotatedDiffs(new Map())
    }
  }, [diffContent])

  // Merge base parsed diffs with annotation overrides
  const effectiveFileDiffs = useMemo(() => {
    if (annotatedDiffs.size === 0) {
      return fileDiffs
    }
    return fileDiffs.map((fd) => annotatedDiffs.get(fd.name) ?? fd)
  }, [fileDiffs, annotatedDiffs])

  /**
   * Handles accept/reject action on a specific hunk of a specific file.
   * Uses `diffAcceptRejectHunk` from @pierre/diffs to produce a new
   * FileDiffMetadata with the hunk resolved, then stores it in annotatedDiffs.
   */
  const handleHunkAction = useCallback(
    (fileName: string, hunkIndex: number, action: 'accept' | 'reject') => {
      setAnnotatedDiffs((prev) => {
        const currentDiff =
          prev.get(fileName) ?? fileDiffs.find((fd) => fd.name === fileName)
        if (!currentDiff) {
          return prev
        }
        const updated = diffAcceptRejectHunk(currentDiff, hunkIndex, action)
        const next = new Map(prev)
        next.set(fileName, updated)
        return next
      })
    },
    [fileDiffs]
  )

  // Ref to avoid stale closure in renderHoverUtility callback
  const handleHunkActionRef = useRef(handleHunkAction)
  handleHunkActionRef.current = handleHunkAction

  // --- Deferred rendering via useTransition ---
  // FileDiff can be expensive to re-render for large diffs (shiki highlighting,
  // hunk parsing, DOM diffing). useTransition marks the re-render as non-urgent
  // so it doesn't block user interactions (scrolling, typing in terminals, etc.).
  // This is layered on top of the debounce: debounce prevents redundant parsing,
  // useTransition prevents the retained render from blocking the UI thread.
  const [isTransitionPending, startTransition] = useTransition()
  const [deferredFileDiffs, setDeferredFileDiffs] = useState(effectiveFileDiffs)

  // Combined pending state: either debounce hasn't settled or transition
  // hasn't committed. Shown as a single "Updating..." indicator.
  const isPending = isDebouncePending || isTransitionPending

  useEffect(() => {
    startTransition(() => {
      setDeferredFileDiffs(effectiveFileDiffs)
    })
  }, [effectiveFileDiffs])

  // --- Scroll position preservation ---
  // The onScroll handler (below) continuously saves the current scroll position
  // to savedScrollRef. After PatchDiff re-renders with new content, we use a
  // MutationObserver on the scroll container to detect DOM changes and restore
  // the scroll position. This prevents the user from losing their place when
  // the diff content changes underneath them.
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const savedScrollRef = useRef({ top: 0, left: 0 })

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    const observer = new MutationObserver(() => {
      // Restore scroll position after PatchDiff mutates the DOM
      container.scrollTop = savedScrollRef.current.top
      container.scrollLeft = savedScrollRef.current.left
    })

    observer.observe(container, { childList: true, subtree: true })

    return () => observer.disconnect()
  }, [])

  // --- "Updated" flash indicator ---
  // Shows a brief flash when new diff content arrives, then fades out.
  // Tracks the previous content to detect actual changes (not initial mount).
  const [showUpdateFlash, setShowUpdateFlash] = useState(false)
  const prevContentRef = useRef(diffContent)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Only flash on content *changes* (not initial mount or same content)
    if (
      prevContentRef.current !== '' &&
      diffContent !== prevContentRef.current &&
      diffContent !== ''
    ) {
      setShowUpdateFlash(true)
      // Clear any existing timer before setting a new one
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current)
      }
      flashTimerRef.current = setTimeout(() => {
        setShowUpdateFlash(false)
      }, UPDATE_FLASH_DURATION)
    }
    prevContentRef.current = diffContent
  }, [diffContent])

  // Cleanup flash timer on unmount
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current)
      }
    }
  }, [])

  // --- Click-to-open file in editor (Issue #112) ---
  // The openEditorRef avoids stale closures in the renderHeaderMetadata callback,
  // which is created per-render but captures the latest openEditor function.
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
   * Renders a clickable "Open" button in each file's diff header.
   * Uses the `renderHeaderMetadata` prop from @pierre/diffs/react FileDiff.
   * The button calls `editor.open` RPC to open the file in Cursor/VS Code.
   */
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

  /**
   * Creates a renderHoverUtility callback for a specific file.
   * When the user hovers over a line, this renders accept/reject buttons
   * if the hovered line belongs to a hunk that has changes (not yet resolved).
   *
   * @see Issue #88: Diff viewer — accept/reject annotations
   */
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

  // --- Scroll event handler to keep savedScrollRef in sync ---
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (container) {
      savedScrollRef.current = {
        top: container.scrollTop,
        left: container.scrollLeft,
      }
    }
  }, [])

  // --- Cross-pane diff scroll (Issue #11) ---
  // When the review pane dispatches a "scroll to file:line" event for this
  // workspace, find the matching <diffs-container> element in the scroll
  // container and scroll it into view smoothly.
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

      // Each child of the scroll container corresponds to a diffs-container
      // element for one file, rendered in the same order as deferredFileDiffs.
      const fileElement = container.children[fileIndex]
      if (fileElement) {
        fileElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }, [])
  )

  // --- Loading state ---
  // When diffRow is null, the DiffService hasn't polled yet for this workspace.
  // Show a loading spinner instead of the "No changes" empty state so the user
  // knows the diff is being computed rather than that there are genuinely no changes.
  if (diffRow === null) {
    console.warn(
      `[DiffPane] LOADING STATE — workspaceId=${workspaceId} has NO row in diffs table. ` +
        'This means the server DiffService has not committed a DiffUpdated event for this workspace, ' +
        'OR the LiveStore sync has not delivered it to the client yet. ' +
        'Check server logs for [DiffService.getDiff] and [DiffService.startPolling] entries for this workspace.'
    )
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
              Waiting for the first diff computation to complete
            </p>
          </div>
        </div>
      </div>
    )
  }

  // --- Empty state ---
  // When diffRow exists but rawDiffContent is empty, the DiffService polled
  // and found no changes — genuinely no file modifications in this workspace.
  // Uses rawDiffContent (not debounced diffContent) to avoid briefly showing
  // the empty state while the debounce timer settles after new content arrives.
  if (!rawDiffContent) {
    console.debug(
      `[DiffPane] EMPTY STATE — workspaceId=${workspaceId} has a diffs row but diffContent is empty. ` +
        'This means DiffService polled successfully but git diff returned no changes. ' +
        `lastUpdated=${lastUpdated}`
    )
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

      {/* Update flash indicator — fades in/out when new diff content arrives */}
      {showUpdateFlash && (
        <div className="fade-in absolute top-10 right-2 z-10 flex animate-in items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-primary text-xs duration-200">
          <RefreshCw className="h-3 w-3" />
          Updated
        </div>
      )}

      {/* Pending indicator — shows when a large diff is being processed */}
      {isPending && (
        <div className="absolute top-10 left-2 z-10 flex items-center gap-1.5 rounded-md bg-muted/90 px-2 py-1 text-muted-foreground text-xs backdrop-blur-sm">
          <RefreshCw className="h-3 w-3 animate-spin" />
          Updating...
        </div>
      )}

      {/* Scrollable diff content — ref preserves scroll position across updates */}
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

      {/* Last updated timestamp footer */}
      {lastUpdated && (
        <div className="flex-none border-border border-t bg-muted/50 px-3 py-1 text-muted-foreground text-xs">
          Last updated: {formatLastUpdated(lastUpdated)}
        </div>
      )}
    </div>
  )
}

export { DiffPane }
