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
 * `editor.open` RPC mutation, and its filename does the same. The rest
 * of the header row — and the chevron, which is coloured by the file's
 * change type — collapses the file. See `@/lib/diff-header-click` for
 * how a click is resolved through the viewer's shadow boundary.
 *
 * ## What the diff compares against
 *
 * `file.diff` takes a target: the worktree against `HEAD` (uncommitted
 * work only), everything the branch changed since it forked, or the same
 * treatment against a named ref. Once a coding agent commits as it works,
 * the first of those shows almost nothing, so the target is a control in
 * the toolbar rather than a property of the server — see
 * `diff-target-control.tsx`, and `@/lib/diff-target` for the vocabulary.
 * The choice, and the whitespace flag beside it, are persisted per
 * workspace in the same local preference collection the sidebar and panel
 * layouts use (`@/hooks/use-diff-view-preference`).
 *
 * Each target is a different question, so each gets its own query atom
 * keyed by the whole request rather than invalidating the current one. A
 * repository that cannot resolve the target answers with
 * `DiffTargetUnresolved` — no recorded base branch, an unfetched ref, an
 * unrelated history — which is an ordinary answer and gets its own state
 * with the target menu still in the header, not the generic failure
 * banner.
 *
 * ## Toolbar
 *
 * The pane header carries the view controls, ported from t3code's diff
 * panel: total +added/−removed, the target control, collapse-all/expand-all
 * over the same `collapseOverrides` map the per-file chevrons write to, a
 * split/unified toggle, ignore-whitespace, and word wrap. Their pure state
 * derivations live in `@/lib/diff-toolbar` and `@/lib/diff-target`.
 *
 * Diff style has two sources: the ResizeObserver below, which flips a
 * pane narrower than {@link UNIFIED_DIFF_THRESHOLD} to unified, and the
 * toolbar. The observer is the default and never stops measuring; an
 * explicit choice overrides it until the user picks the style the
 * current width already implies, which clears the override and hands
 * the decision back.
 *
 * ## Line selection and comments
 *
 * Dragging the line-number column selects a run of lines, and the viewer
 * parks a "comment on these lines" button in the gutter of the hovered —
 * or last selected — line. Activating it resolves the range into a
 * {@link DiffCommentAnchor} and opens a composer inline under that line.
 * Submitting persists a review conversation through `reviewComment.create`;
 * the stored threads come back on the shared `state.subscribe` stream and
 * render as annotations under the lines they anchor to, which is how an
 * agent's reply — written over MCP, never through this pane — appears here
 * on its own while the human is watching.
 *
 * Both the selection drag and the gutter button are pointer-only: the
 * viewer paints the gutter inside its shadow root, gives its scroll
 * container `tabIndex = -1`, and never makes a line focusable, so there
 * is nothing there for the app to route a key to. The toolbar therefore
 * carries a second, app-owned way in — name a file and a line — which
 * produces the same anchor and opens the same composer; see
 * `diff-comment-line-picker.tsx`. Everything downstream of the anchor
 * (composer, reply, resolve, delete) is ordinary keyboard-reachable app
 * UI. See `@/lib/diff-comment-anchor` for the anchor shape and
 * `@/lib/diff-comment-threads` for how threads become annotations.
 *
 * ## Expanding the unchanged context
 *
 * A patch is a summary: it carries the changed lines and a few either side,
 * and every other line of the file is a gap the separator names but does not
 * paint. `@pierre/diffs` will expand those gaps, but only for a viewer that
 * gives it a `loadDiffFiles` loader, because expanding needs the whole file
 * and a patch does not contain one. `useDiffHunkExpansion` supplies that
 * loader over `file.diffContents`, scoped to the same target the patch was
 * cut under, and owns the words for a round trip that is in flight or came
 * back refused.
 *
 * Expansion also moves the detached-comment line. A comment sitting in a
 * collapsed gap is genuinely unplaceable until that gap is painted — and
 * expanding paints it without touching a single hunk, so nothing in the
 * parsed metadata changes to say so. `@/lib/diff-expansion` asks the live
 * viewer instead, and the partition below re-runs against its answer, so a
 * comment re-attaches to its line and leaves the detached list on the same
 * pass that reveals it.
 *
 * The pane never modifies the diff or the worktree. Its other interactive
 * affordances are navigational (open-in-editor, close, retry, cross-pane
 * scroll-to-line, expand-context).
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
import type {
  DiffTarget,
  FileDiffEntry,
  FileWatcherEvent,
  ReviewCommentThread,
} from '@laborer/shared/rpc'
import { RpcError } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@laborer/ui/components/empty'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
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
import type {
  CodeViewItem,
  CodeViewLineSelection,
  DiffLineAnnotation,
  GetHoveredLineResult,
  LineAnnotation,
  SelectedLineRange,
} from '@pierre/diffs'
import type { CodeViewHandle } from '@pierre/diffs/react'
import { Cause, Effect, Option } from 'effect'
import { Atom, AsyncResult as Result } from 'effect/unstable/reactivity'
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  ExternalLink,
  FileCode2,
  GitCompareArrows,
  MessageSquare,
  RefreshCw,
  Rows3,
  Space,
  TriangleAlert,
  WrapText,
  X,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import type {
  ReactElement,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react'
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
import {
  DiffCommentAnnotation,
  DiffCommentComposer,
  DiffCommentThreadCard,
} from '@/components/diff-comment-annotation'
import { DiffCommentGutterButton } from '@/components/diff-comment-gutter-button'
import { DiffCommentLinePicker } from '@/components/diff-comment-line-picker'
import { DiffTargetControl } from '@/components/diff-target-control'
import { DiffWorkerPoolProvider } from '@/components/diff-worker-pool-provider'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { StyledDiffCodeView } from '@/components/styled-diff-code-view'
import type { ExpandableDiffFile } from '@/hooks/use-diff-hunk-expansion'
import {
  DIFF_EXPANSION_LINE_COUNT,
  useDiffHunkExpansion,
} from '@/hooks/use-diff-hunk-expansion'
import { useDiffReviewComments } from '@/hooks/use-diff-review-comments'
import { useDiffViewPreference } from '@/hooks/use-diff-view-preference'
import { useWhenPhase } from '@/hooks/use-when-phase'
import {
  diffChangeTypeIconClassName,
  diffChangeTypeLabel,
} from '@/lib/diff-change-type'
import type { DiffCommentAnchor } from '@/lib/diff-comment-anchor'
import { resolveDiffCommentAnchor } from '@/lib/diff-comment-anchor'
import type { CommentableDiffFile } from '@/lib/diff-comment-line-target'
import type { DiffCommentAnnotationGroup } from '@/lib/diff-comment-threads'
import {
  detachedLineProbes,
  diffCommentAnnotationsVersion,
  partitionDiffCommentThreads,
  threadsOutsideDiff,
  withDraftDiffCommentAnnotation,
} from '@/lib/diff-comment-threads'
import type { DiffLineProbe } from '@/lib/diff-expansion'
import { resolveDiffHeaderClick } from '@/lib/diff-header-click'
import type { DiffTargetFailure } from '@/lib/diff-target'
import {
  asDiffTargetFailure,
  describeDiffTargetFailure,
  diffTargetLabel,
  fileDiffPayload,
  fileDiffRequestKey,
  parseFileDiffRequestKey,
} from '@/lib/diff-target'
import type { DiffStyle, DiffStyleOverride } from '@/lib/diff-toolbar'
import {
  areAllDiffFilesCollapsed,
  nextDiffStyleOverride,
  resolveDiffStyle,
  responsiveDiffStyle,
  sumDiffStats,
  withCollapseAll,
} from '@/lib/diff-toolbar'
import { extractErrorMessage } from '@/lib/errors'
import type { RenderableFilePatch } from '@/lib/file-diff'
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
 * Keyed by the whole request — workspace, target, whitespace — rather
 * than by workspace alone, so concurrent panes never share (and
 * interrupt) each other's in-flight requests, which is the failure mode
 * that previously left the pane stuck on "Computing diff...", and so
 * switching target is a different question rather than an invalidation
 * of the current one. `Atom.family` keys by identity, hence the string.
 */
const fileDiffQuery = Atom.family((requestKey: string) =>
  LaborerClient.runtime.atom(
    Effect.flatMap(LaborerClient, (client) => {
      const request = parseFileDiffRequestKey(requestKey)
      if (request === null) {
        return Effect.fail(
          new RpcError({
            message: 'Could not read what this diff should compare against',
            code: 'INVALID_DIFF_REQUEST',
          })
        )
      }
      return client('file.diff', fileDiffPayload(request))
    }).pipe(
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
  hunkSeparators: 'line-info' as const,
  stickyHeaders: true,
  /**
   * Dragging the line-number column selects a run of lines, and the
   * viewer parks the app's gutter affordance on the hovered line — or on
   * the last selected one. Both are pointer-only in the viewer; the pane
   * supplies the button through `renderGutterUtility`.
   *
   * Note the installed library refuses `renderGutterUtility` together
   * with the `onGutterUtilityClick` callback t3code uses
   * (`resolveEnableGutterUtilityOption` throws), so the button owns its
   * own activation. See `diff-comment-gutter-button.tsx`.
   */
  enableLineSelection: true,
  enableGutterUtility: true,
  /**
   * How much of a collapsed gap one press of the separator's expand control
   * reveals, and how small a gap is simply painted rather than collapsed.
   * Both are stated rather than left at the library's defaults, because the
   * virtualizer's height estimates are computed from them.
   */
  expansionLineCount: DIFF_EXPANSION_LINE_COUNT,
  collapsedContextThreshold: 1,
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
 * A changed file ready for rendering, paired with what could be made of
 * its patch: parsed metadata for the viewer, the raw text when parsing
 * failed, or nothing at all when the server omitted it.
 */
interface RenderableFileDiff {
  readonly entry: FileDiffEntry
  readonly patch: RenderableFilePatch
}

/**
 * What the viewer hands `renderGutterUtility` so the button can ask,
 * at activation time, which line it is currently parked on. The library
 * declares this union inline and does not export a name for it.
 */
type DiffGutterHoverGetter =
  | (() => GetHoveredLineResult<'file'> | undefined)
  | (() => GetHoveredLineResult<'diff'> | undefined)

/**
 * The hovered line as a one-line range, so a hover and a drag-selection
 * reach the anchor helper through the same shape.
 */
const hoveredLineRange = (
  hovered:
    | GetHoveredLineResult<'file'>
    | GetHoveredLineResult<'diff'>
    | undefined
): SelectedLineRange | null => {
  if (!hovered) {
    return null
  }
  const side = 'side' in hovered ? hovered.side : undefined
  return {
    start: hovered.lineNumber,
    end: hovered.lineNumber,
    ...(side ? { side } : {}),
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DiffPaneHeader({
  onClose,
  toolbar,
}: {
  readonly onClose?: (() => void) | undefined
  /** View controls, rendered between the title and the close button. */
  readonly toolbar?: ReactNode
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b bg-muted/30 px-2 ps-3">
      <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium text-muted-foreground text-xs">
        Diff
      </span>
      <div className="ml-auto flex min-w-0 items-center gap-0.5">
        {toolbar}
        {onClose && (
          <Button
            aria-label="Close diff viewer"
            className="size-6 shrink-0"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
}

/** Ghost icon control sized to the 32px pane header. */
const TOOLBAR_CONTROL_CLASS =
  'size-6 shrink-0 rounded-md p-0 text-muted-foreground hover:text-foreground'

function DiffToolbarTooltip({
  control,
  label,
}: {
  readonly control: ReactElement
  readonly label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={control} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Total +added/−removed across the changed files, styled like the
 * per-file counts the viewer paints into each file header (mono,
 * tabular, 11px) so the two read as the same kind of number.
 */
function DiffTotalStats({
  added,
  removed,
}: {
  readonly added: number
  readonly removed: number
}) {
  return (
    <span
      className="shrink-0 whitespace-nowrap px-1 font-mono text-[11px] tabular-nums"
      data-testid="diff-total-stats"
    >
      <span className="sr-only">
        {added} lines added, {removed} lines removed across all changed files
      </span>
      <span aria-hidden="true" className="text-green-500">
        +{added}
      </span>
      <span aria-hidden="true"> </span>
      <span aria-hidden="true" className="text-red-500">
        -{removed}
      </span>
    </span>
  )
}

interface DiffPaneToolbarProps {
  readonly added: number
  readonly allCollapsed: boolean
  /** Parsed files, so the keyboard route has somewhere to point. */
  readonly commentableFiles: readonly CommentableDiffFile[]
  readonly diffStyle: DiffStyle
  readonly ignoreWhitespace: boolean
  readonly onSelectDiffStyle: (style: DiffStyle) => void
  readonly onStartComment: (anchor: DiffCommentAnchor) => void
  readonly onToggleCollapseAll: () => void
  readonly onToggleIgnoreWhitespace: (ignore: boolean) => void
  readonly onToggleShowResolved: (show: boolean) => void
  readonly onToggleWordWrap: (wrap: boolean) => void
  readonly removed: number
  /** Resolved conversations in this workspace; no toggle when there are none. */
  readonly resolvedCount: number
  readonly showResolved: boolean
  /** The target control, so every pane state can carry the same one. */
  readonly targetControl: ReactNode
  readonly wordWrap: boolean
}

/**
 * View controls for the diff: the target, totals, collapse-all,
 * split/unified, whitespace, and word wrap. Everything is icon-sized and
 * `shrink-0` so the row survives a pane narrow enough to have already
 * flipped itself to unified.
 */
function DiffPaneToolbar({
  added,
  allCollapsed,
  commentableFiles,
  diffStyle,
  ignoreWhitespace,
  onSelectDiffStyle,
  onStartComment,
  onToggleCollapseAll,
  onToggleIgnoreWhitespace,
  onToggleShowResolved,
  onToggleWordWrap,
  removed,
  resolvedCount,
  showResolved,
  targetControl,
  wordWrap,
}: DiffPaneToolbarProps) {
  const collapseLabel = allCollapsed ? 'Expand all files' : 'Collapse all files'
  const CollapseIcon = allCollapsed ? ChevronsUpDown : ChevronsDownUp
  const wrapLabel = wordWrap ? 'Disable line wrapping' : 'Enable line wrapping'
  const resolvedLabel = showResolved
    ? `Hide ${resolvedCount} resolved comment${resolvedCount === 1 ? '' : 's'}`
    : `Show ${resolvedCount} resolved comment${resolvedCount === 1 ? '' : 's'}`
  const whitespaceLabel = ignoreWhitespace
    ? 'Include whitespace-only changes'
    : 'Ignore whitespace-only changes'

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <DiffTotalStats added={added} removed={removed} />

      {targetControl}

      {/* The viewer's gutter affordance needs a pointer and lives in a shadow
          root the app cannot make tabbable, so this is the keyboard route to
          the same composer. It is a tooltip-less plain control because it is
          the fallback that has to work when nothing else does. */}
      {commentableFiles.length > 0 && (
        <DiffCommentLinePicker
          files={commentableFiles}
          onStartComment={onStartComment}
          triggerClassName={TOOLBAR_CONTROL_CLASS}
        />
      )}

      {/* A resolved conversation is evidence of what was asked, so it is
          hidden by default rather than discarded — and the control only
          exists once there is something behind it. */}
      {resolvedCount > 0 && (
        <DiffToolbarTooltip
          control={
            <Toggle
              aria-label={resolvedLabel}
              className={TOOLBAR_CONTROL_CLASS}
              data-testid="diff-show-resolved-toggle"
              onPressedChange={onToggleShowResolved}
              pressed={showResolved}
              size="sm"
            >
              <MessageSquare className="size-3.5" />
            </Toggle>
          }
          label={resolvedLabel}
        />
      )}

      <DiffToolbarTooltip
        control={
          <Button
            aria-label={collapseLabel}
            className={TOOLBAR_CONTROL_CLASS}
            onClick={onToggleCollapseAll}
            size="icon"
            variant="ghost"
          >
            <CollapseIcon className="size-3.5" />
          </Button>
        }
        label={collapseLabel}
      />

      {/* Controlled by the resolved style, and every click reports the
          style it asked for — including a click on the already-active
          one, which is how the pane hands the choice back to its width
          observer (see `nextDiffStyleOverride`). */}
      <ToggleGroup className="shrink-0 gap-0.5" size="sm" value={[diffStyle]}>
        <DiffToolbarTooltip
          control={
            <ToggleGroupItem
              aria-label="Unified diff view"
              className={TOOLBAR_CONTROL_CLASS}
              onClick={() => onSelectDiffStyle('unified')}
              value="unified"
            >
              <Rows3 className="size-3.5" />
            </ToggleGroupItem>
          }
          label="Unified diff view"
        />
        <DiffToolbarTooltip
          control={
            <ToggleGroupItem
              aria-label="Split diff view"
              className={TOOLBAR_CONTROL_CLASS}
              onClick={() => onSelectDiffStyle('split')}
              value="split"
            >
              <Columns2 className="size-3.5" />
            </ToggleGroupItem>
          }
          label="Split diff view"
        />
      </ToggleGroup>

      {/* `-w` on the server, so it changes what the diff *is* rather than
          how it is painted — a reindent stops drowning the real change. */}
      <DiffToolbarTooltip
        control={
          <Toggle
            aria-label={whitespaceLabel}
            className={TOOLBAR_CONTROL_CLASS}
            data-testid="diff-ignore-whitespace-toggle"
            onPressedChange={onToggleIgnoreWhitespace}
            pressed={ignoreWhitespace}
            size="sm"
          >
            <Space className="size-3.5" />
          </Toggle>
        }
        label={whitespaceLabel}
      />

      <DiffToolbarTooltip
        control={
          <Toggle
            aria-label={wrapLabel}
            className={TOOLBAR_CONTROL_CLASS}
            onPressedChange={onToggleWordWrap}
            pressed={wordWrap}
            size="sm"
          >
            <WrapText className="size-3.5" />
          </Toggle>
        }
        label={wrapLabel}
      />
    </div>
  )
}

/**
 * Conversations the viewer has nowhere to paint.
 *
 * A thread stores the file, side, and line numbers it was written against,
 * and nothing re-anchors it when the diff changes underneath — so once a
 * refetch leaves its line outside every hunk, or a change of target leaves
 * its file out of the diff entirely, there is no annotation slot for it.
 * Listing those threads here is the honest alternative to letting them
 * vanish: the words are still readable, and the anchor says where they
 * were left.
 */
function DetachedDiffComments({
  onDelete,
  onSetStatus,
  threads,
}: {
  readonly onDelete: (thread: ReviewCommentThread) => void
  readonly onSetStatus: (
    thread: ReviewCommentThread,
    status: 'open' | 'resolved'
  ) => void
  readonly threads: readonly ReviewCommentThread[]
}) {
  return (
    <div
      className="m-2 flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2"
      data-testid="diff-detached-comments"
    >
      <span className="text-muted-foreground text-xs">
        {threads.length === 1
          ? 'One comment does not sit on a line in this diff. It is shown here with the file and lines it was left against.'
          : `${threads.length} comments do not sit on a line in this diff. They are shown here with the files and lines they were left against.`}
      </span>
      <div className="divide-y divide-border/40 rounded border border-border/40 bg-background/50">
        {threads.map((thread) => (
          <DiffCommentThreadCard
            busy={false}
            key={thread.id}
            now={Date.now()}
            onDelete={onDelete}
            onSetStatus={onSetStatus}
            thread={thread}
          />
        ))}
      </div>
    </div>
  )
}

function DiffPaneLoading({
  onClose,
  toolbar,
}: {
  readonly onClose?: (() => void) | undefined
  readonly toolbar?: ReactNode
}) {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <DiffPaneHeader onClose={onClose} toolbar={toolbar} />
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
  toolbar,
}: {
  readonly message: string
  readonly onClose?: (() => void) | undefined
  readonly onRetry: () => void
  readonly toolbar?: ReactNode
}) {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <DiffPaneHeader onClose={onClose} toolbar={toolbar} />
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
 * The repository declining to resolve the target the reader asked for.
 *
 * This is not the generic failure banner and deliberately does not lead
 * with a raw error string. A worktree with no recorded base branch, a ref
 * that was never fetched, an unrelated history — each is an ordinary
 * answer, so the state names what happened, says what to do about it, and
 * keeps two ways out in reach: the target menu still in the header, and a
 * one-click return to the uncommitted diff, which always resolves.
 */
function DiffTargetUnresolvedState({
  failure,
  onClose,
  onShowWorkingTree,
  toolbar,
}: {
  readonly failure: DiffTargetFailure
  readonly onClose?: (() => void) | undefined
  readonly onShowWorkingTree: () => void
  readonly toolbar?: ReactNode
}) {
  const copy = describeDiffTargetFailure(failure)

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <DiffPaneHeader onClose={onClose} toolbar={toolbar} />
      <div
        className="flex flex-1 items-center justify-center"
        data-testid="diff-target-unresolved"
      >
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitCompareArrows />
            </EmptyMedia>
            <EmptyTitle>{copy.title}</EmptyTitle>
            <EmptyDescription>
              {/* The server's own sentence first — it names the ref and the
                  repository state — then what the reader can do here. */}
              {failure.message !== '' && (
                <span className="block">{failure.message}</span>
              )}
              <span className="block pt-1">{copy.guidance}</span>
            </EmptyDescription>
          </EmptyHeader>
          <Button
            data-testid="diff-target-unresolved-fallback"
            onClick={onShowWorkingTree}
            size="sm"
            variant="outline"
          >
            <FileCode2 className="size-3.5" />
            Show uncommitted changes
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

/**
 * Rendered when the patch did arrive but the parser could not turn it
 * into a diff. The text is still the answer the user came for, so it is
 * shown verbatim instead of being reported as missing — the fallback
 * t3code's `getRenderablePatch` takes.
 */
function RawDiffPatch({
  entry,
  patch,
  reason,
  wrap,
}: {
  readonly entry: FileDiffEntry
  readonly patch: string
  readonly reason: string
  /** Follows the toolbar's word wrap, like the viewer's own body. */
  readonly wrap: boolean
}) {
  return (
    <div className="m-2 flex flex-col gap-1 rounded-md border bg-muted/30 px-3 py-2">
      <DiffPlaceholderStats entry={entry} />
      <span className="text-muted-foreground text-xs">{reason}</span>
      {/* An unparseable patch can be arbitrarily long, and unwrapped it is
          also arbitrarily wide, so this scrolls both ways. */}
      <ScrollArea className="max-h-96 rounded bg-background/60" scrollbarGutter>
        <pre
          className={`p-2 font-mono text-[11px] text-foreground leading-relaxed ${
            wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
          }`}
          data-testid="diff-raw-patch"
        >
          {patch}
        </pre>
      </ScrollArea>
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
  /** True only when nothing has ever loaded and no terminal error yet. */
  readonly loading: boolean
  readonly orderedFileDiffs: readonly RenderableFileDiff[]
  readonly refresh: () => void
  /** Identifies the question being asked — workspace, target, whitespace. */
  readonly requestKey: string
  /** True while what is on screen answers a question already superseded. */
  readonly stale: boolean
  /**
   * The repository declining to resolve the requested target. Expected,
   * not exceptional — rendered as its own state with the target menu
   * still in reach, never as the generic failure banner.
   */
  readonly targetFailure: DiffTargetFailure | null
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
function useDiffStore(
  workspaceId: string,
  target: DiffTarget,
  ignoreWhitespace: boolean
): DiffStoreResult {
  const requestKey = fileDiffRequestKey({
    ignoreWhitespace,
    target,
    workspaceId,
  })
  const diffAtom = useMemo(() => fileDiffQuery(requestKey), [requestKey])
  const diffResult = useAtomValue(diffAtom)
  const refresh = useAtomRefresh(diffAtom)

  // Stale-while-revalidate: a waiting/failed Result keeps its previous
  // success value, so the previous diff stays visible during refreshes.
  const entriesOption = Result.value(diffResult)
  const fetched = Option.getOrElse(entriesOption, () => EMPTY_ENTRIES)
  const hasData = Option.isSome(entriesOption)

  // Changing target asks a *different* question, which means a different
  // atom with nothing in it yet — and that would drop the whole pane back
  // to the "Computing diff..." screen, taking the toolbar the reader just
  // used with it. The previous answer is held across the switch instead,
  // marked stale, so the same stale-while-revalidate a watcher refresh
  // gets also covers a target change.
  const [lastEntries, setLastEntries] =
    useState<readonly FileDiffEntry[]>(EMPTY_ENTRIES)
  const [everLoaded, setEverLoaded] = useState(false)
  if (hasData && fetched !== lastEntries) {
    setLastEntries(fetched)
    setEverLoaded(true)
  }

  const stale = !hasData && everLoaded
  const changedFiles = hasData ? fetched : lastEntries

  const loading = !(hasData || everLoaded || Result.isFailure(diffResult))
  const failure =
    !hasData && Result.isFailure(diffResult)
      ? Cause.squash(diffResult.cause)
      : null
  // An unresolvable target is a question the pane can re-ask, so it is
  // pulled out before anything reaches the generic failure banner.
  const targetFailure = failure === null ? null : asDiffTargetFailure(failure)
  const errorMessage =
    failure === null || targetFailure !== null
      ? null
      : extractErrorMessage(failure)

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
    const renderable: RenderableFileDiff[] = []
    for (const entry of changedFiles) {
      const patch = parseFileDiffEntry(entry)
      // A patch omitted by the server-side size budget keeps its entry
      // so the user sees why the file is missing instead of it silently
      // disappearing. No patch and `truncated: false` is a binary file —
      // skipped, matching previous behavior.
      if (patch.kind !== 'absent' || entry.truncated) {
        renderable.push({ entry, patch })
      }
    }
    return renderable
  }, [changedFiles])

  return {
    changedFiles,
    errorMessage,
    loading,
    orderedFileDiffs,
    refresh,
    requestKey,
    stale,
    targetFailure,
  }
}

// ---------------------------------------------------------------------------
// DiffPaneContent — mounted only after Phase 4 (Eventually)
// ---------------------------------------------------------------------------

function DiffPaneContent({ onClose, workspaceId }: DiffPaneProps) {
  const openEditor = useAtomSet(editorOpenMutation, { mode: 'promise' })

  // Declared first because the expansion hook and several callbacks below
  // read the live viewer rather than React state.
  const viewerRef = useRef<CodeViewHandle<DiffCommentAnnotationGroup>>(null)

  // --- What this pane is comparing ---
  // Persisted per workspace, so closing and reopening the pane lands back
  // on the question the reader was asking rather than on the default.
  const { ignoreWhitespace, setIgnoreWhitespace, setTarget, target } =
    useDiffViewPreference(workspaceId)

  const {
    changedFiles,
    errorMessage,
    loading,
    orderedFileDiffs,
    refresh,
    requestKey,
    stale,
    targetFailure,
  } = useDiffStore(workspaceId, target, ignoreWhitespace)

  const targetControl = (
    <DiffTargetControl
      onSelectTarget={setTarget}
      target={target}
      triggerClassName={TOOLBAR_CONTROL_CLASS}
    />
  )

  // --- Diff style: pane width by default, user choice when given ---
  // The observer never stops measuring; `diffStyleOverride` decides
  // whether anyone listens. Picking the style the width already implies
  // clears the override, which is the way back to automatic — see
  // `nextDiffStyleOverride`.
  const [useUnified, setUseUnified] = useState(false)
  const [diffStyleOverride, setDiffStyleOverride] =
    useState<DiffStyleOverride>(null)

  const responsiveStyle = responsiveDiffStyle(useUnified)
  const diffStyle = resolveDiffStyle(diffStyleOverride, responsiveStyle)

  const handleSelectDiffStyle = useCallback(
    (requested: DiffStyle) => {
      setDiffStyleOverride(nextDiffStyleOverride(requested, responsiveStyle))
    },
    [responsiveStyle]
  )

  // --- Word wrap ---
  const [wordWrap, setWordWrap] = useState(true)

  // A callback ref, not an effect: the measured element only exists in
  // the ready branch below, so a mount-time effect would have found an
  // empty ref while the pane was still loading and never looked again.
  // React 19 runs the returned cleanup when the node detaches.
  const observePaneWidth = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setUseUnified(entry.contentRect.width < UNIFIED_DIFF_THRESHOLD)
      }
    })
    observer.observe(node)
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

  // --- Line selection, comments, and the composer ---
  // The selection is held here rather than inside the viewer so the
  // gutter button and the composer read the same range, and so the pane
  // can release the lines when a draft is abandoned.
  const [selectedLines, setSelectedLines] =
    useState<CodeViewLineSelection | null>(null)
  const comments = useDiffReviewComments(workspaceId)
  const { cancelDraft, draft, startComment, threadsByFile } = comments

  // --- Hunk-context expansion ---
  // The loader is what makes the separator's expand control exist at all, so
  // it is wired before the options the viewer is built from.

  /** Files with a patch the loader can fetch both sides of. */
  const expandableFiles = useMemo<readonly ExpandableDiffFile[]>(
    () =>
      deferredFileDiffs.flatMap(({ entry, patch }) =>
        patch.kind === 'parsed'
          ? [
              {
                cacheKey: patch.cacheKey,
                fileDiff: patch.fileDiff,
                path: entry.path,
              },
            ]
          : []
      ),
    [deferredFileDiffs]
  )

  /**
   * The lines worth asking the viewer about.
   *
   * Only a thread the hunks cannot place can be moved by expansion, so this
   * is derived from the hunks alone — which also keeps it independent of the
   * answer it feeds, and the partition below out of a cycle.
   */
  const probesByFile = useMemo(() => {
    const byFile = new Map<string, readonly DiffLineProbe[]>()
    for (const { entry, patch } of deferredFileDiffs) {
      if (patch.kind !== 'parsed') {
        continue
      }
      const threads = threadsByFile.get(entry.path)
      if (threads === undefined || threads.length === 0) {
        continue
      }
      const probes = detachedLineProbes(patch.fileDiff, threads)
      if (probes.length > 0) {
        byFile.set(entry.path, probes)
      }
    }
    return byFile as ReadonlyMap<string, readonly DiffLineProbe[]>
  }, [deferredFileDiffs, threadsByFile])

  const expansion = useDiffHunkExpansion({
    files: expandableFiles,
    probesByFile,
    requestKey,
    target,
    viewerRef,
    workspaceId,
  })
  const { expandedLines } = expansion

  const diffOptions = useMemo(
    () => ({
      ...DIFF_OPTIONS_BASE,
      diffStyle,
      overflow: wordWrap ? ('wrap' as const) : ('scroll' as const),
      lineDiffType:
        totalPatchBytes > LARGE_PATCH_BYTES
          ? ('none' as const)
          : DIFF_OPTIONS_BASE.lineDiffType,
      loadDiffFiles: expansion.loadDiffFiles,
      onPostRender: expansion.onPostRender,
      themeType,
    }),
    [
      diffStyle,
      expansion.loadDiffFiles,
      expansion.onPostRender,
      themeType,
      totalPatchBytes,
      wordWrap,
    ]
  )

  /**
   * Changing the question closes an open composer and releases the lines.
   *
   * A line number only means something inside one diff: line 40 of the
   * working-tree diff and line 40 of the branch diff are usually different
   * code. Carrying an unsent draft across a target switch would therefore
   * anchor it to whatever now happens to sit at that number, which is
   * worse than asking for it again. Stored threads are a different matter
   * — they keep their numbers and are re-partitioned below, landing in the
   * detached list when the new diff has no line for them.
   */
  const [lastRequestKey, setLastRequestKey] = useState(requestKey)
  if (lastRequestKey !== requestKey) {
    setLastRequestKey(requestKey)
    cancelDraft()
    setSelectedLines(null)
  }

  /**
   * Start a comment on a range of a file.
   *
   * Everything above this is view state; everything below it is the
   * anchor a stored conversation hangs off. The range is also pushed
   * into the viewer, so a comment started from a plain hover leaves its
   * line highlighted rather than opening against lines that look
   * untouched.
   */
  const handleStartCommentAtAnchor = useCallback(
    (anchor: DiffCommentAnchor) => {
      const range: SelectedLineRange = {
        end: anchor.endLine,
        side: anchor.side,
        start: anchor.startLine,
      }
      startComment(anchor)
      setSelectedLines({ id: anchor.filePath, range })
      viewerRef.current?.setSelectedLines({ id: anchor.filePath, range })
    },
    [startComment]
  )

  const handleStartComment = useCallback(
    (filePath: string, range: SelectedLineRange) => {
      const anchor = resolveDiffCommentAnchor(filePath, range)
      if (anchor) {
        handleStartCommentAtAnchor(anchor)
      }
    },
    [handleStartCommentAtAnchor]
  )

  /**
   * Cancelling releases the lines too. Leaving them selected would leave
   * the gutter button offering the range that was just abandoned.
   */
  const handleCancelDraft = useCallback(() => {
    cancelDraft()
    setSelectedLines(null)
    viewerRef.current?.clearSelectedLines()
  }, [cancelDraft])

  /**
   * The viewer parks this button on the line the pointer is over, or on
   * the last line of the selection once there is one — so the button
   * itself does not know which; it asks when pressed. A selection in
   * this file wins, because that is what the button is pinned to.
   */
  const renderGutterUtility = useCallback(
    (
      getHoveredLine: DiffGutterHoverGetter,
      item: CodeViewItem<DiffCommentAnnotationGroup>
    ) => {
      const selectedRange =
        selectedLines?.id === item.id ? selectedLines.range : null
      return (
        <DiffCommentGutterButton
          label={
            selectedRange
              ? 'Comment on the selected lines'
              : 'Comment on this line'
          }
          onStartComment={(range) => handleStartComment(item.id, range)}
          resolveRange={() =>
            selectedRange ?? hoveredLineRange(getHoveredLine())
          }
        />
      )
    },
    [handleStartComment, selectedLines]
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

  /**
   * The keyboard route's landing.
   *
   * A named line may be inside a file that starts collapsed, or far outside
   * the window the viewer has rendered — neither of which a drag can be,
   * because a drag needs the line on screen already. So the file is expanded
   * and the viewer is scrolled before the composer opens, or the person would
   * fill in the dialog and appear to get nothing.
   */
  const handleStartCommentByLine = useCallback(
    (anchor: DiffCommentAnchor) => {
      setCollapseOverrides((previous) =>
        new Map(previous).set(anchor.filePath, false)
      )
      handleStartCommentAtAnchor(anchor)
      viewerRef.current?.scrollTo({
        align: 'center',
        behavior: 'smooth',
        id: anchor.filePath,
        lineNumber: anchor.endLine,
        type: 'line',
      })
    },
    [handleStartCommentAtAnchor]
  )

  // --- Collapse all / expand all ---
  // Only files the viewer actually renders take part; a file whose
  // patch never arrived has nothing to collapse.
  const renderablePaths = useMemo(
    () =>
      deferredFileDiffs.flatMap(({ entry, patch }) =>
        patch.kind === 'parsed' ? [entry.path] : []
      ),
    [deferredFileDiffs]
  )

  /** Files a comment can be placed in, for the toolbar's keyboard route. */
  const commentableFiles = useMemo<readonly CommentableDiffFile[]>(
    () =>
      deferredFileDiffs.flatMap(({ entry, patch }) =>
        patch.kind === 'parsed'
          ? [{ fileDiff: patch.fileDiff, path: entry.path }]
          : []
      ),
    [deferredFileDiffs]
  )

  const collapsedByPath = useMemo(() => {
    const flags = new Map<string, boolean>()
    for (const { entry, patch } of deferredFileDiffs) {
      if (patch.kind === 'parsed') {
        flags.set(entry.path, isCollapsed(entry))
      }
    }
    return flags
  }, [deferredFileDiffs, isCollapsed])

  const allCollapsed = areAllDiffFilesCollapsed(
    renderablePaths,
    (path) => collapsedByPath.get(path) === true
  )

  const handleToggleCollapseAll = useCallback(() => {
    setCollapseOverrides((previous) =>
      withCollapseAll(previous, renderablePaths, !allCollapsed)
    )
  }, [allCollapsed, renderablePaths])

  const totals = useMemo(() => sumDiffStats(changedFiles), [changedFiles])

  // --- Viewer items ---
  // The viewer only re-reads an item whose `version` changed, so the
  // version has to cover everything the item carries: the patch itself,
  // whether it is collapsed, and every conversation annotated onto it —
  // an agent reply arriving on the shared stream changes nothing else.
  //
  // A file's threads are also partitioned here, because whether a thread
  // still has a line to sit on is a question only the parsed diff can
  // answer; the ones that do not are listed above the viewer instead.
  //
  // Note the dependency is the draft's *anchor*, not the draft: rebuilding
  // this array re-seeds every item in the viewer, which is far too much work
  // to do on each keystroke. The composer's text reaches the annotation
  // through `renderAnnotation` instead, which the viewer re-runs on its own.
  const draftAnchor = draft?.anchor ?? null

  const { detachedThreads, items } = useMemo(() => {
    const detached: ReviewCommentThread[] = []
    const built: CodeViewItem<DiffCommentAnnotationGroup>[] = []
    const filesInDiff = new Set<string>()

    for (const { entry, patch } of deferredFileDiffs) {
      if (patch.kind !== 'parsed') {
        continue
      }
      filesInDiff.add(entry.path)
      // The expanded lines are part of the question, not a decoration on the
      // answer: a thread inside a gap the reader has just revealed is
      // placeable now and has to leave the detached list on this same pass.
      const partition = partitionDiffCommentThreads(
        patch.fileDiff,
        threadsByFile.get(entry.path) ?? [],
        expandedLines.get(entry.path)
      )
      detached.push(...partition.detached)

      const annotations =
        draftAnchor?.filePath === entry.path
          ? withDraftDiffCommentAnnotation(partition.annotations, draftAnchor)
          : partition.annotations

      const collapsed = isCollapsed(entry)
      built.push({
        id: entry.path,
        type: 'diff' as const,
        fileDiff: patch.fileDiff,
        annotations: [...annotations],
        collapsed,
        version: fnv1a32(
          `${collapsed ? '1' : '0'}:${diffCommentAnnotationsVersion(
            annotations
          )}:${entry.patch ?? ''}`
        ),
      })
    }

    // A thread on a file this diff does not mention never reached the
    // partition above. Switching target makes that ordinary — a comment
    // left on a committed file has no home in the working-tree diff — so
    // it joins the detached list rather than disappearing until the
    // reader happens to switch back.
    detached.push(...threadsOutsideDiff(threadsByFile, filesInDiff))

    return {
      detachedThreads: detached as readonly ReviewCommentThread[],
      items: built,
    }
  }, [
    deferredFileDiffs,
    draftAnchor,
    expandedLines,
    isCollapsed,
    threadsByFile,
  ])

  /**
   * One annotation node per (side, line): the conversations stored there,
   * plus the composer when the open draft belongs to this line.
   */
  const renderAnnotation = useCallback(
    (
      annotation:
        | DiffLineAnnotation<DiffCommentAnnotationGroup>
        | LineAnnotation<DiffCommentAnnotationGroup>,
      item: CodeViewItem<DiffCommentAnnotationGroup>
    ) => {
      const side = 'side' in annotation ? annotation.side : 'additions'
      const isDraftHere =
        draft !== null &&
        draft.anchor.filePath === item.id &&
        draft.anchor.endLine === annotation.lineNumber &&
        (draft.anchor.side === 'deletions' ? 'deletions' : 'additions') === side

      return (
        <DiffCommentAnnotation
          busy={comments.busy}
          group={annotation.metadata}
          now={Date.now()}
          onDelete={comments.deleteThread}
          onReply={comments.startReply}
          onSetStatus={comments.setStatus}
          {...(isDraftHere
            ? {
                composer: (
                  <DiffCommentComposer
                    anchorLabel={draft.anchor.label}
                    busy={comments.busy}
                    onCancel={handleCancelDraft}
                    onChange={comments.changeDraft}
                    onSubmit={comments.submitDraft}
                    placeholder={
                      draft.kind === 'reply'
                        ? 'Reply to this conversation…'
                        : 'Leave a comment for the agent…'
                    }
                    submitLabel={draft.kind === 'reply' ? 'Reply' : 'Comment'}
                    value={draft.body}
                  />
                ),
                ...(draft.kind === 'reply'
                  ? { replyingToThreadId: draft.threadId }
                  : {}),
              }
            : {})}
        />
      )
    },
    [comments, draft, handleCancelDraft]
  )

  /**
   * The chevron in each header takes its colour from the file's change
   * type, and the viewer only hands `renderHeaderPrefix` the item id.
   */
  const changeTypeByPath = useMemo(() => {
    const types = new Map<string, FileDiffEntry['status']>()
    for (const { entry } of deferredFileDiffs) {
      types.set(entry.path, entry.status)
    }
    return types
  }, [deferredFileDiffs])

  /** Files whose patch never left the server — nothing to render. */
  const truncatedEntries = useMemo(
    () =>
      deferredFileDiffs.flatMap(({ entry, patch }) =>
        patch.kind === 'absent' ? [entry] : []
      ),
    [deferredFileDiffs]
  )

  /** Files whose patch arrived but could not be parsed — shown raw. */
  const rawPatches = useMemo(
    () =>
      deferredFileDiffs.flatMap(({ entry, patch }) =>
        patch.kind === 'raw' ? [{ entry, patch }] : []
      ),
    [deferredFileDiffs]
  )

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
   * Clicking a file's name opens it and clicking the rest of its header
   * row collapses it, the way t3code's diff panel does. Both are painted
   * by the viewer inside its shadow root, so the click is caught on the
   * way down and resolved through the composed path; the header's own
   * controls keep their actions, and clicks in the diff body — where
   * text selection lives — resolve to nothing.
   */
  const handleHeaderClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = resolveDiffHeaderClick(event.nativeEvent.composedPath())
      if (target.kind === 'open') {
        handleOpenFile(target.path)
        return
      }
      if (target.kind === 'toggle') {
        toggleCollapsed(target.path, collapsedByPath.get(target.path) === true)
      }
    },
    [collapsedByPath, handleOpenFile, toggleCollapsed]
  )

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<DiffCommentAnnotationGroup>) => {
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
    (item: CodeViewItem<DiffCommentAnnotationGroup>) => {
      const collapsed = item.collapsed === true
      const Chevron = collapsed ? ChevronRight : ChevronDown
      const changeType = changeTypeByPath.get(item.id) ?? 'modified'
      return (
        <button
          aria-expanded={!collapsed}
          // The colour below encodes the change type; the name says it
          // too, so the distinction survives without sight of it.
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${item.id}, ${diffChangeTypeLabel(changeType)}`}
          className={`-ms-0.5 mr-0.5 inline-flex items-center rounded p-0.5 transition-colors hover:bg-accent ${diffChangeTypeIconClassName(changeType)}`}
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
    [changeTypeByPath, toggleCollapsed]
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
    return <DiffPaneLoading onClose={onClose} toolbar={targetControl} />
  }

  // --- Unresolvable target (expected: no base branch, missing ref, ...) ---
  if (targetFailure !== null) {
    return (
      <DiffTargetUnresolvedState
        failure={targetFailure}
        onClose={onClose}
        onShowWorkingTree={() => setTarget({ _tag: 'working' })}
        toolbar={targetControl}
      />
    )
  }

  // --- Error state (fetch exhausted retries and there is no data) ---
  if (errorMessage !== null) {
    return (
      <DiffPaneError
        message={errorMessage}
        onClose={onClose}
        onRetry={refresh}
        toolbar={targetControl}
      />
    )
  }

  // --- Empty state ---
  if (changedFiles.length === 0) {
    return (
      <div className="flex h-full w-full flex-col bg-background">
        <DiffPaneHeader onClose={onClose} toolbar={targetControl} />
        <div className="flex flex-1 items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileCode2 />
              </EmptyMedia>
              <EmptyTitle>No changes</EmptyTitle>
              <EmptyDescription>
                {/* Which question came back empty matters: "nothing
                    uncommitted" and "nothing on this branch" are very
                    different answers to be looking at. */}
                {diffTargetLabel(target)} — nothing to show. Changes appear here
                automatically as the agent modifies files.
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
        <DiffPaneHeader onClose={onClose} toolbar={targetControl} />
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
      ref={observePaneWidth}
    >
      <DiffPaneHeader
        onClose={onClose}
        toolbar={
          <DiffPaneToolbar
            added={totals.added}
            allCollapsed={allCollapsed}
            commentableFiles={commentableFiles}
            diffStyle={diffStyle}
            ignoreWhitespace={ignoreWhitespace}
            onSelectDiffStyle={handleSelectDiffStyle}
            onStartComment={handleStartCommentByLine}
            onToggleCollapseAll={handleToggleCollapseAll}
            onToggleIgnoreWhitespace={setIgnoreWhitespace}
            onToggleShowResolved={comments.setIncludeResolved}
            onToggleWordWrap={setWordWrap}
            removed={totals.removed}
            resolvedCount={comments.resolvedCount}
            showResolved={comments.includeResolved}
            targetControl={targetControl}
            wordWrap={wordWrap}
          />
        }
      />

      {/* Always mounted so the announcement lands: a live region added to
          the page at the same moment as its text is routinely missed. */}
      <div aria-live="polite" className="sr-only">
        {draft ? `Commenting on ${draft.anchor.label}` : ''}
      </div>

      {/* Expanding is a round trip, and it can come back refused. The
          separator carries a short marker of the same state; this is where
          the whole sentence is spoken. */}
      <div
        aria-live="polite"
        className="sr-only"
        data-testid="diff-expansion-status"
      >
        {expansion.announcement}
      </div>

      {showUpdateFlash && (
        <div className="fade-in absolute top-10 right-2 z-10 flex animate-in items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-primary text-xs duration-200">
          <RefreshCw className="h-3 w-3" />
          Updated
        </div>
      )}

      {/* `stale` covers the target switch, where what is on screen still
          answers the previous question. */}
      {(isTransitionPending || stale) && (
        <div
          className="absolute top-10 left-2 z-10 flex items-center gap-1.5 rounded-md bg-muted/90 px-2 py-1 text-muted-foreground text-xs backdrop-blur-sm"
          data-testid="diff-updating-indicator"
        >
          <span className="inline-flex h-3 w-3 animate-spin">
            <RefreshCw className="size-full" />
          </span>
          Updating...
        </div>
      )}

      {/* The click target is the viewer's own filename node inside its
          shadow root; every header's Open button is the keyboard path to
          the same action. */}
      {/* The expand control the viewer paints is a `div[role="button"]` with
          no key handling of its own; `onPostRender` gives it a tab stop and a
          name, and this routes the activation back to it. Key events are
          composed, so they surface here the same way header clicks do. */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-pane-text-selectable
        onClickCapture={handleHeaderClickCapture}
        onKeyDownCapture={expansion.handleKeyDown}
      >
        {(truncatedEntries.length > 0 ||
          rawPatches.length > 0 ||
          detachedThreads.length > 0) && (
          <ScrollArea className="max-h-1/2 shrink-0" scrollFade>
            {detachedThreads.length > 0 && (
              <DetachedDiffComments
                onDelete={comments.deleteThread}
                onSetStatus={comments.setStatus}
                threads={detachedThreads}
              />
            )}
            {truncatedEntries.map((entry) => (
              <TruncatedDiffPlaceholder entry={entry} key={entry.path} />
            ))}
            {rawPatches.map(({ entry, patch }) => (
              <RawDiffPatch
                entry={entry}
                key={entry.path}
                patch={patch.patch}
                reason={patch.reason}
                wrap={wordWrap}
              />
            ))}
          </ScrollArea>
        )}
        {/* Not a ScrollArea: the viewer owns this scroller. It calls
            `setup(root)` on the element it is given, appends its own content
            container to it, and listens for `scroll` there to drive
            virtualization. Nesting it inside a ScrollArea would leave the
            viewport — a different element — doing the scrolling, so the
            viewer would measure a container that never moves and render
            every line of every file. */}
        <StyledDiffCodeView<DiffCommentAnnotationGroup>
          className="min-h-0 flex-1 select-text overflow-auto"
          items={items}
          onSelectedLinesChange={setSelectedLines}
          options={diffOptions}
          renderAnnotation={renderAnnotation}
          renderGutterUtility={renderGutterUtility}
          renderHeaderMetadata={renderHeaderMetadata}
          renderHeaderPrefix={renderHeaderPrefix}
          selectedLines={selectedLines}
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
