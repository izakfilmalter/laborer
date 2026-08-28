/**
 * Workspace file explorer on `@pierre/trees`, ported from t3code's
 * `FileBrowserPanel`.
 *
 * Laborer adaptations:
 * - Entries come from the `file.listEntries` RPC keyed by workspace id
 *   rather than t3's environment/cwd pair.
 * - Laborer has no mission-control composer/drop target, so t3's file-row
 *   dragging is disabled. Copy mention and Copy path provide the native
 *   handoff instead.
 * - Git-status decorations ride along: `@pierre/trees` accepts status
 *   entries natively, so the tree tints changed files the way the old
 *   left tree pane did, fed by `file.status`.
 * - The `file.watcher.subscribe` stream invalidates the listing and the
 *   git status (coalesced), replacing t3's manual-refresh-only model and
 *   preserving the old tree pane's reactive invalidation.
 */

import {
  useAtomMount,
  useAtomRefresh,
  useAtomValue,
} from '@effect/atom-react/Hooks'
import type { FileEntry, FileWatcherEvent } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@laborer/ui/components/dropdown-menu'
import { InputGroup, InputGroupInput } from '@laborer/ui/components/input-group'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import type { ContextMenuOpenContext, GitStatusEntry } from '@pierre/trees'
import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react'
import { Effect } from 'effect'
import { Atom, AsyncResult as Result } from 'effect/unstable/reactivity'
import { RotateCw } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fileWatcherEventsAtom } from '@/atoms/file-watcher'
import { LaborerClient } from '@/atoms/laborer-client'
import { serializeFileMention } from '@/components/files/file-mention'
import { LABORER_PIERRE_ICONS } from '@/components/files/pierre-icons'
import { useFileEntriesQuery } from '@/components/files/project-files-query-state'
import { toast } from '@/lib/toast'

interface FileBrowserPanelProps {
  onOpenFile: (relativePath: string) => void
  onRefreshSelectedFile?: () => void
  projectName: string
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number
  workspaceId: string
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`

/** Coalesce watcher bursts before refetching the listing and git status. */
const WATCHER_REFRESH_DEBOUNCE_MS = 150

/** Directory rows are registered with a trailing slash; strip it for lookups. */
const TRAILING_SLASH_REGEX = /\/$/

function treePath(entry: FileEntry): string {
  return entry.kind === 'directory' ? `${entry.path}/` : entry.path
}

/** Per-workspace query atom for git-status tree decorations. */
const fileStatusQueryAtom = Atom.family((workspaceId: string) =>
  LaborerClient.runtime.atom(
    Effect.flatMap(LaborerClient, (client) =>
      client('file.status', { workspaceId })
    )
  )
)

function RefreshFilesButton(props: {
  isPending: boolean
  onRefresh: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
            size="icon-xs"
            type="button"
            variant="ghost"
          />
        }
      >
        <RotateCw className={cn(props.isPending && 'animate-spin')} />
      </TooltipTrigger>
      <TooltipContent>
        {props.isPending ? 'Refreshing…' : 'Refresh files'}
      </TooltipContent>
    </Tooltip>
  )
}

function FileSearchField(props: {
  ariaLabel: string
  name: string
  onClose: () => void
  onValueChange: (value: string) => void
  value: string
}) {
  return (
    <InputGroup className="h-7 min-w-0 flex-1 border-transparent shadow-none">
      <InputGroupInput
        aria-label={props.ariaLabel}
        name={props.name}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') {
            return
          }
          props.onClose()
          event.currentTarget.blur()
        }}
        placeholder="Search files"
        spellCheck={false}
        type="search"
        value={props.value}
      />
    </InputGroup>
  )
}

export function FileBrowserPanel({
  workspaceId,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme()
  const entriesQuery = useFileEntriesQuery(workspaceId)
  const entries = useMemo(
    () => entriesQuery.data?.entries ?? [],
    [entriesQuery.data]
  )
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries]
  )
  const entryKindsRef =
    useRef<ReadonlyMap<string, FileEntry['kind']>>(entryKinds)
  const treePaths = useMemo(() => entries.map(treePath), [entries])
  const previousTreePathsRef = useRef<readonly string[]>([])
  const syncingSelectionRef = useRef(false)
  const treeSelectionPathRef = useRef<string | null>(null)
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(
    null
  )
  const contextMenuPointerRef = useRef<{
    x: number
    y: number
    at: number
  } | null>(null)
  const [entryMenu, setEntryMenu] = useState<{
    close: () => void
    path: string
    x: number
    y: number
  } | null>(null)
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
      }
    }
    document.addEventListener('contextmenu', capturePointer, true)
    return () =>
      document.removeEventListener('contextmenu', capturePointer, true)
  }, [])

  const openEntryMenu = (path: string, context: ContextMenuOpenContext) => {
    const pointer = contextMenuPointerRef.current
    const anchor = context.anchorElement.getBoundingClientRect()
    setEntryMenu({
      close: context.close,
      path: path.replace(TRAILING_SLASH_REGEX, ''),
      x:
        pointer && performance.now() - pointer.at < 1000
          ? pointer.x
          : anchor.left,
      y:
        pointer && performance.now() - pointer.at < 1000
          ? pointer.y
          : anchor.bottom,
    })
  }
  const closeEntryMenu = () => {
    entryMenu?.close()
    setEntryMenu(null)
  }

  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: 'right-click',
        onOpen: (item, context) => openEntryMenu(item.path, context),
      },
    },
    density: 'compact',
    fileTreeSearchMode: 'hide-non-matches',
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: LABORER_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) {
        return
      }
      const changedPath = selectedPaths
        .at(-1)
        ?.replace(TRAILING_SLASH_REGEX, '')
      if (changedPath && entryKindsRef.current.get(changedPath) === 'file') {
        treeSelectionPathRef.current = changedPath
        onOpenFile(changedPath)
      }
    },
    paths: [],
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  })
  const search = useFileTreeSearch(model)
  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      search.close()
      return
    }
    search.setValue(value)
  }

  // --- Git-status decorations ---
  const statusAtom = fileStatusQueryAtom(workspaceId)
  const statusResult = useAtomValue(statusAtom)
  const refreshStatus = useAtomRefresh(statusAtom)
  useEffect(() => {
    const files = Result.isSuccess(statusResult) ? statusResult.value : []
    const gitStatus: GitStatusEntry[] = files.map((file) => ({
      path: file.path,
      status: file.status,
    }))
    model.setGitStatus(gitStatus)
  }, [model, statusResult])

  const handleRefresh = () => {
    entriesQuery.refresh()
    refreshStatus()
    onRefreshSelectedFile?.()
  }

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) {
      return
    }
    entryKindsRef.current = entryKinds
    previousTreePathsRef.current = treePaths
    model.resetPaths(treePaths)
  }, [entryKinds, model, treePaths])

  // biome-ignore lint/correctness/useExhaustiveDependencies: treePaths re-runs the reveal after an entry refresh rebuilds the tree, ported from t3code.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: t3code's reveal-sync effect, ported whole; splitting it would diverge from the source it mirrors.
  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null
      return
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId }
    const handledReveal = handledRevealRef.current
    // Entry refreshes rebuild treePaths while the same preview stays open.
    // Replaying a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return
    }
    if (entryKinds.get(selectedPath) !== 'file') {
      return
    }
    const selectedItem = model.getItem(selectedPath)
    if (!selectedItem) {
      return
    }

    // A selection that originated inside the tree (clicking a row, possibly
    // in an active tree search) is already visible; re-revealing it would
    // close the search and clobber the user's context. Only sync external
    // opens (persisted tabs, chat links).
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(TRAILING_SLASH_REGEX, '') === selectedPath)
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null
      handledRevealRef.current = revealRequest
      return
    }
    treeSelectionPathRef.current = null
    handledRevealRef.current = revealRequest

    syncingSelectionRef.current = true
    model.closeSearch()
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect()
    }

    // Directory rows are registered with a trailing slash (see treePath), so
    // ancestor lookups must use the same form to expand them.
    const segments = selectedPath.split('/')
    let ancestorPath = ''
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment
      const item =
        model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath)
      if (item && 'expand' in item) {
        item.expand()
      }
    }

    selectedItem.select()
    model.scrollToPath(selectedPath, { focus: true, offset: 'center' })
    queueMicrotask(() => {
      syncingSelectionRef.current = false
    })
  }, [entryKinds, model, selectedPath, selectedPathRevealId, treePaths])

  // --- Watcher-driven invalidation ---
  const watcherAtom = fileWatcherEventsAtom(workspaceId)
  useAtomMount(watcherAtom)
  const watcherResult = useAtomValue(watcherAtom)
  const lastProcessedIndexRef = useRef(0)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshEntriesRef = useRef(entriesQuery.refresh)
  refreshEntriesRef.current = entriesQuery.refresh
  const refreshStatusRef = useRef(refreshStatus)
  refreshStatusRef.current = refreshStatus

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
    lastProcessedIndexRef.current = items.length

    const relevant = items
      .slice(startIndex)
      .some(
        (event) =>
          event !== undefined &&
          !event.file.startsWith('.git/') &&
          event.file !== '.git'
      )
    if (!relevant || refreshTimerRef.current !== null) {
      return
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      refreshEntriesRef.current()
      refreshStatusRef.current()
    }, WATCHER_REFRESH_DEBOUNCE_MS)
  }, [watcherResult])

  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current)
      }
    },
    []
  )

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={workspaceId}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-border/60 border-b bg-background px-2"
        data-surface-subheader
      >
        <RefreshFilesButton
          isPending={entriesQuery.isPending}
          onRefresh={handleRefresh}
        />
        <FileSearchField
          ariaLabel={`Search ${projectName} files`}
          name="project-files-search"
          onClose={search.close}
          onValueChange={handleSearchValueChange}
          value={search.value}
        />
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-destructive text-xs leading-relaxed">
          {entriesQuery.error}
        </div>
      ) : (
        <>
          <FileTree
            aria-label={`${projectName} files`}
            className="min-h-0 flex-1 overflow-hidden"
            model={model}
            style={{
              colorScheme: resolvedTheme === 'light' ? 'light' : 'dark',
              ['--trees-fg-override' as string]: 'var(--foreground)',
            }}
          />
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) {
                closeEntryMenu()
              }
            }}
            open={entryMenu !== null}
          >
            <DropdownMenuTrigger
              render={
                <span
                  aria-hidden
                  className="pointer-events-none fixed size-px"
                  style={{ left: entryMenu?.x ?? 0, top: entryMenu?.y ?? 0 }}
                />
              }
            />
            <DropdownMenuContent align="start" sideOffset={0}>
              <DropdownMenuItem
                onClick={() => {
                  if (entryMenu) {
                    navigator.clipboard
                      .writeText(serializeFileMention(entryMenu.path))
                      .then(
                        () => toast.success('Mention copied'),
                        () => toast.error('Unable to copy mention')
                      )
                  }
                  closeEntryMenu()
                }}
              >
                Copy mention
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  if (entryMenu) {
                    navigator.clipboard.writeText(entryMenu.path).then(
                      () => toast.success('Path copied'),
                      () => toast.error('Unable to copy path')
                    )
                  }
                  closeEntryMenu()
                }}
              >
                Copy path
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  )
}
