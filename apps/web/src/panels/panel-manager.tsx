/**
 * PanelManager — tmux-style panel system for rendering terminal and diff panes.
 *
 * Renders a panel layout based on a `PanelNode` tree structure. Supports:
 * - Single pane rendering (LeafNode)
 * - Horizontal split (SplitNode with direction "horizontal") — side-by-side panes
 * - Vertical split (SplitNode with direction "vertical") — stacked panes
 * - Recursive nesting of splits to arbitrary depth (5+ levels tested)
 * - Close pane with automatic tree collapse
 *
 * The PanelManager fills its parent container and renders pane content
 * based on the pane type:
 * - "terminal" → renders a TerminalPane with xterm.js
 * - "diff" → renders a DiffPane with @pierre/diffs
 *
 * Empty terminal panes show a guided empty state with a CTA to spawn a
 * terminal directly in the pane. If the pane has a workspaceId or there's
 * exactly one active workspace, the user can spawn with one click. If
 * multiple workspaces are active, a dropdown lets them pick which workspace
 * to spawn in. If no workspaces exist, guidance text points to the sidebar.
 *
 * Empty panes are also drop targets for terminal drag-and-drop. Users can
 * drag a terminal item from the sidebar terminal list onto an empty pane
 * to assign that terminal to that specific pane. The drop target shows a
 * visual highlight border on drag-over. Occupied panes reject drops.
 *
 * Split panes are rendered using react-resizable-panels (via shadcn/ui's
 * resizable wrapper) with drag-to-resize handles between each child.
 *
 * Split/close/diff-toggle actions have moved to the PanelHeaderBar in the
 * route component. PanelActionsContext is still used for active-pane tracking.
 *
 * @see packages/shared/src/types.ts — PanelNode, LeafNode, SplitNode types
 * @see apps/web/src/panes/terminal-pane.tsx — Terminal pane component
 * @see apps/web/src/panels/layout-utils.ts — Tree manipulation functions
 * @see apps/web/src/panels/panel-context.tsx — PanelActionsContext
 * @see Issue #66: PanelManager — single pane rendering
 * @see Issue #67: PanelManager — horizontal split
 * @see Issue #68: PanelManager — vertical split
 * @see Issue #69: PanelManager — recursive splits
 * @see Issue #120: Empty state — no terminals
 * @see Issue #134: Drag terminal from sidebar onto empty panel pane
 * @see Issue #148: Focused pane border fix — replaced ring with border
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { workspaces } from '@laborer/shared/schema'
import type {
  LeafNode,
  PanelNode,
  PaneType,
  SplitNode,
} from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { Layers, Plus, Server, Terminal as TerminalIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GroupImperativeHandle } from 'react-resizable-panels'
import { LaborerClient } from '@/atoms/laborer-client'
import { TerminalOverlayToolbar } from '@/components/terminal-overlay-toolbar'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { PanelTypePicker } from '@/components/ui/panel-type-picker'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useResponsiveLayout } from '@/hooks/use-responsive-layout'
import { toast } from '@/lib/toast'
import { extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'
import {
  useActivePaneId,
  useFullscreenPaneId,
  useFullscreenPortal,
  usePanelActions,
  usePendingClosePane,
  usePendingPicker,
} from '@/panels/panel-context'
import { usePanelGroupRegistry } from '@/panels/panel-group-registry'
import { TerminalPaneWithSidebars } from '@/panels/terminal-pane-with-sidebars'
import { DevServerTerminalPane } from '@/panes/dev-server-terminal-pane'
import { DiffPane } from '@/panes/diff-pane'
import { ReviewPane } from '@/panes/review-pane'
import { PaneCloseConfirmDialog } from '@/routes/-components/close-dialogs'

const allWorkspaces$ = queryDb(workspaces, { label: 'paneWorkspaces' })
const spawnTerminalMutation = LaborerClient.mutation('terminal.spawn')

/**
 * MIME type for terminal drag data. Must match the value used in
 * terminal-list.tsx drag source.
 */
const TERMINAL_DRAG_MIME = 'application/x-laborer-terminal'

/** Parsed terminal drag data shape. */
interface TerminalDragData {
  readonly terminalId: string
  readonly workspaceId: string
}

/**
 * Parse terminal drag data from a DataTransfer object.
 * Returns undefined if the data is missing or invalid.
 */
function parseTerminalDragData(
  dataTransfer: DataTransfer
): TerminalDragData | undefined {
  const raw = dataTransfer.getData(TERMINAL_DRAG_MIME)
  if (!raw) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'terminalId' in parsed &&
      'workspaceId' in parsed &&
      typeof (parsed as TerminalDragData).terminalId === 'string' &&
      typeof (parsed as TerminalDragData).workspaceId === 'string'
    ) {
      return parsed as TerminalDragData
    }
  } catch {
    // Invalid JSON — ignore
  }
  return undefined
}

/**
 * Check whether a drag event contains terminal drag data.
 * Uses the `types` array on DataTransfer (available during dragover)
 * since `getData()` is only accessible during drop.
 */
function hasTerminalDragData(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(TERMINAL_DRAG_MIME)
}

interface EmptyTerminalPaneProps {
  /** The pane ID, used to assign the spawned terminal to this specific pane. */
  readonly paneId: string
  /** Pre-assigned workspace ID from the pane node, if any. */
  readonly workspaceId?: string | undefined
}

/**
 * Empty state for terminal panes with no terminal assigned.
 *
 * Provides a CTA to spawn a terminal directly in this pane:
 * - If the pane has a workspaceId or exactly one active workspace exists,
 *   a single "Spawn Terminal" button spawns and assigns immediately.
 * - If multiple active workspaces exist, a dropdown lets the user pick
 *   which workspace to spawn in.
 * - If no active workspaces exist, shows guidance pointing to the sidebar.
 */
function EmptyTerminalPane({ paneId, workspaceId }: EmptyTerminalPaneProps) {
  const store = useLaborerStore()
  const workspaceList = store.useQuery(allWorkspaces$)
  const panelActions = usePanelActions()
  const spawnTerminal = useAtomSet(spawnTerminalMutation, {
    mode: 'promise',
  })
  const [isSpawning, setIsSpawning] = useState(false)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('')

  const activeWorkspaces = workspaceList.filter(
    (ws) => ws.status === 'running' || ws.status === 'creating'
  )

  // Determine which workspace to use for spawning
  const singleWorkspaceId =
    activeWorkspaces.length === 1 ? activeWorkspaces[0]?.id : undefined
  const resolvedWorkspaceId =
    workspaceId ?? singleWorkspaceId ?? selectedWorkspaceId

  const handleSpawn = useCallback(async () => {
    if (!resolvedWorkspaceId) {
      return
    }
    setIsSpawning(true)
    try {
      const result = await spawnTerminal({
        payload: { workspaceId: resolvedWorkspaceId },
      })
      toast.success(`Terminal spawned: ${result.command}`)
      if (panelActions) {
        panelActions.assignTerminalToPane(
          result.id,
          resolvedWorkspaceId,
          paneId
        )
      }
    } catch (error) {
      toast.error(`Failed to spawn terminal: ${extractErrorMessage(error)}`)
    } finally {
      setIsSpawning(false)
    }
  }, [spawnTerminal, resolvedWorkspaceId, panelActions, paneId])

  const hasMultipleWorkspaces = !workspaceId && activeWorkspaces.length > 1

  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TerminalIcon />
          </EmptyMedia>
          <EmptyTitle>No terminal</EmptyTitle>
          <EmptyDescription>
            {activeWorkspaces.length === 0
              ? 'Create a workspace first, then spawn a terminal to see output here.'
              : 'Spawn a terminal in a workspace to see output here.'}
          </EmptyDescription>
        </EmptyHeader>
        {activeWorkspaces.length > 0 && (
          <EmptyContent>
            {hasMultipleWorkspaces && (
              <Select
                onValueChange={(value) => setSelectedWorkspaceId(value ?? '')}
                value={selectedWorkspaceId}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select workspace" />
                </SelectTrigger>
                <SelectContent>
                  {activeWorkspaces.map((ws) => (
                    <SelectItem key={ws.id} value={ws.id}>
                      {ws.branchName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              disabled={isSpawning || !resolvedWorkspaceId}
              onClick={handleSpawn}
              size="sm"
              variant="outline"
            >
              <Plus className="size-3.5" />
              {isSpawning ? 'Spawning...' : 'Spawn Terminal'}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </div>
  )
}

interface EmptyDevServerPaneProps {
  /** The pane ID, used to assign the spawned dev server terminal to this pane. */
  readonly paneId: string
  /** Pre-assigned workspace ID from the pane node. */
  readonly workspaceId: string
}

/**
 * Empty state for dev server terminal panes with no terminal assigned.
 *
 * Automatically spawns a dev server terminal with `autoRun: true` on mount.
 * While spawning, shows a loading indicator. If the spawn fails, shows an
 * error with a retry button.
 */
function EmptyDevServerPane({ paneId, workspaceId }: EmptyDevServerPaneProps) {
  const panelActions = usePanelActions()
  const spawnTerminal = useAtomSet(spawnTerminalMutation, {
    mode: 'promise',
  })
  const [isSpawning, setIsSpawning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasSpawned = useRef(false)

  const description = isSpawning
    ? 'Spawning the dev server terminal for this workspace.'
    : (error ?? 'The dev server terminal will start automatically.')

  const handleSpawn = useCallback(async () => {
    setIsSpawning(true)
    setError(null)
    try {
      const result = await spawnTerminal({
        payload: { workspaceId, autoRun: true },
      })
      if (panelActions) {
        panelActions.assignTerminalToPane(result.id, workspaceId, paneId)
      }
    } catch (spawnError) {
      setError(extractErrorMessage(spawnError))
      toast.error(
        `Failed to spawn dev server: ${extractErrorMessage(spawnError)}`
      )
    } finally {
      setIsSpawning(false)
    }
  }, [spawnTerminal, workspaceId, panelActions, paneId])

  // Auto-spawn on mount
  useEffect(() => {
    if (hasSpawned.current) {
      return
    }
    hasSpawned.current = true
    handleSpawn()
  }, [handleSpawn])

  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Server />
          </EmptyMedia>
          <EmptyTitle>
            {isSpawning ? 'Starting dev server...' : 'Dev server'}
          </EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {error && (
          <EmptyContent>
            <Button
              disabled={isSpawning}
              onClick={handleSpawn}
              size="sm"
              variant="outline"
            >
              <Plus className="size-3.5" />
              Retry
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </div>
  )
}

interface PaneContentProps {
  /** The leaf node describing this pane's content. */
  readonly node: LeafNode
  /** Callback invoked when the terminal process exits. */
  readonly onTerminalExit?: (() => void) | undefined
}

/**
 * Renders the content of a single pane based on its type and assigned IDs.
 *
 * Terminal panes with `diffOpen: true` render the diff as an integrated
 * sidebar (resizable) alongside the terminal within the same pane container.
 * Dev server terminal panes render with `devServerOpen: true` as a right-hand
 * sidebar beside the main terminal. This matches the diff viewer placement
 * while keeping the dev server terminal visually coupled to its workspace.
 */
function PaneContent({ node, onTerminalExit }: PaneContentProps) {
  if (node.paneType === 'terminal' && node.terminalId) {
    return (
      <TerminalPaneWithSidebars node={node} onTerminalExit={onTerminalExit} />
    )
  }

  // Dev server terminal rendered as a standalone pane
  if (node.paneType === 'devServerTerminal' && node.terminalId) {
    return <DevServerTerminalPane terminalId={node.terminalId} />
  }

  // Dev server pane without terminal — auto-spawn dev server
  if (node.paneType === 'devServerTerminal' && node.workspaceId) {
    return (
      <EmptyDevServerPane paneId={node.id} workspaceId={node.workspaceId} />
    )
  }

  // Empty pane — use guided empty state with CTA for terminal panes
  if (node.paneType === 'terminal') {
    return <EmptyTerminalPane paneId={node.id} workspaceId={node.workspaceId} />
  }

  // Diff pane — displays workspace diffs as a standalone panel
  if (node.paneType === 'diff' && node.workspaceId) {
    return <DiffPane workspaceId={node.workspaceId} />
  }

  // Review pane — displays PR review findings and comments
  if (node.paneType === 'review' && node.workspaceId) {
    return <ReviewPane workspaceId={node.workspaceId} />
  }

  // Generic empty pane (non-terminal)
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Layers />
          </EmptyMedia>
          <EmptyTitle>Empty pane</EmptyTitle>
          <EmptyDescription>Assign content to this pane.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  )
}

/**
 * Pane toolbar — currently empty since split/diff/close actions moved
 * to the top-level PanelHeaderBar. Kept as a hook point in case
 * per-pane controls are added later.
 */

interface PanelRendererProps {
  /** The panel node tree to render. */
  readonly node: PanelNode
}

/**
 * Renders a SplitNode as a resizable panel group with children separated
 * by drag handles.
 *
 * - direction "horizontal" → side-by-side panes (row layout)
 * - direction "vertical" → stacked panes (column layout)
 *
 * Each child is rendered recursively via PanelRenderer, supporting
 * arbitrary nesting depth. Panel sizes are taken from the SplitNode's
 * sizes array (percentages that must sum to 100).
 *
 * Registers the ResizablePanelGroup's imperative handle with the
 * PanelGroupRegistry so keyboard shortcuts can programmatically resize
 * panels via `groupRef.setLayout()`.
 *
 * @see Issue #79: Keyboard shortcut — resize panes
 */
function SplitPanelRenderer({ node }: { readonly node: SplitNode }) {
  const registry = usePanelGroupRegistry()
  const setGroupRef = useCallback(
    (handle: GroupImperativeHandle | null) => {
      if (handle) {
        registry?.registerGroupRef(node.id, handle)
        return
      }

      registry?.unregisterGroupRef(node.id)
    },
    [registry, node.id]
  )

  return (
    <ResizablePanelGroup
      data-split-id={node.id}
      groupRef={setGroupRef}
      orientation={node.direction}
    >
      {node.children.map((child, index) => {
        const size = node.sizes[index] ?? 100 / node.children.length
        return (
          <SplitChild
            child={child}
            defaultSize={size}
            index={index}
            key={child.id}
          />
        )
      })}
    </ResizablePanelGroup>
  )
}

/**
 * Renders a single child within a SplitNode, preceded by a ResizableHandle
 * if it is not the first child. Extracted to a separate component to keep
 * the SplitPanelRenderer map clean and to provide stable keys.
 *
 * Each ResizablePanel has an `id` matching its PanelNode ID, enabling
 * programmatic resize via the GroupImperativeHandle's `setLayout()` API.
 *
 * The minimum pane size adapts to viewport width to ensure panes remain
 * usable (at least ~100px) at any resolution from 1080p to 5K.
 *
 * @see Issue #79: Keyboard shortcut — resize panes
 * @see Issue #81: Panel responsive layout
 */
function SplitChild({
  child,
  defaultSize,
  index,
}: {
  readonly child: PanelNode
  readonly defaultSize: number
  readonly index: number
}) {
  const { paneMin } = useResponsiveLayout()
  return (
    <>
      {index > 0 && <ResizableHandle />}
      <ResizablePanel
        defaultSize={`${defaultSize}%`}
        id={child.id}
        minSize={paneMin}
      >
        <PanelRenderer node={child} />
      </ResizablePanel>
    </>
  )
}

/**
 * Inline panel type picker overlay, rendered within a pane's container.
 * Follows the same pattern as PaneCloseConfirmDialog — absolute positioning
 * with a backdrop, centered content, keyboard focus captured on mount.
 */
function PanePickerOverlay({
  onSelect,
  onCancel,
}: {
  readonly onSelect: (type: PaneType) => void
  readonly onCancel: () => void
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Picker overlay needs click-outside-to-dismiss on backdrop
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      onMouseDown={(e) => {
        // Clicking the backdrop (not the picker) cancels
        if (e.target === e.currentTarget) {
          onCancel()
        }
      }}
      role="dialog"
    >
      {/* Backdrop — covers only the pane */}
      <div className="absolute inset-0 bg-foreground/10 supports-backdrop-filter:backdrop-blur-xs" />
      {/* Picker content */}
      <div className="relative z-10">
        <PanelTypePicker onCancel={onCancel} onSelect={onSelect} />
      </div>
    </div>
  )
}

/**
 * Renders a LeafNode pane with drop target support for terminal drag-and-drop.
 *
 * The active pane gets a subtle `ring-1 ring-primary/50` highlight to
 * distinguish it from unfocused panes within a split.
 * Drag-over drop target uses `border-primary bg-primary/5` for visual feedback.
 *
 * Empty terminal panes (no terminalId assigned) accept drops from the
 * sidebar terminal list. On drag-over, a visual highlight border appears.
 * On drop, the terminal is assigned to this specific pane via
 * `assignTerminalToPane(terminalId, workspaceId, paneId)`.
 *
 * Occupied panes (with a terminalId already set) do not accept drops —
 * the drag cursor shows "not allowed".
 *
 * @see Issue #134: Drag terminal from sidebar onto empty panel pane
 * @see Issue #148: Focused pane border fix
 */
function LeafPaneRenderer({ node }: { readonly node: LeafNode }) {
  const actions = usePanelActions()
  const activePaneId = useActivePaneId()
  const fullscreenPaneId = useFullscreenPaneId()
  const fullscreenPortalRef = useFullscreenPortal()
  const pendingClose = usePendingClosePane()
  const pendingPicker = usePendingPicker()
  const [isDragOver, setIsDragOver] = useState(false)
  const paneContainerRef = useRef<HTMLDivElement | null>(null)

  const isFullscreen = fullscreenPaneId === node.id
  const isActive = activePaneId === node.id

  // When this pane becomes active (via keyboard navigation, tab switch, or
  // split), transfer DOM focus to it. This ensures terminal panes receive
  // keyboard input immediately without requiring a click.
  useEffect(() => {
    if (!isActive) {
      return
    }
    const container = paneContainerRef.current
    if (!container) {
      return
    }
    // Check if focus is already inside this pane
    if (container.contains(document.activeElement)) {
      return
    }
    // Focus the first focusable element inside (xterm.js canvas for terminals,
    // or the container itself for non-terminal panes).
    const focusable = container.querySelector<HTMLElement>(
      'canvas, textarea, input, [tabindex="0"]'
    )
    if (focusable) {
      focusable.focus()
    } else {
      container.focus()
    }
  }, [isActive])

  /**
   * Auto-close the pane when the terminal process exits.
   * Invoked by TerminalPane when it receives a "stopped" status
   * control message from the WebSocket.
   */
  const handleTerminalExit = useCallback(() => {
    actions?.closePane(node.id)
  }, [actions, node.id])

  const isEmptyTerminalPane = node.paneType === 'terminal' && !node.terminalId
  const isOccupiedTerminalPane =
    node.paneType === 'terminal' && !!node.terminalId

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!(isEmptyTerminalPane && hasTerminalDragData(e.dataTransfer))) {
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setIsDragOver(true)
    },
    [isEmptyTerminalPane]
  )

  const handleDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!(isEmptyTerminalPane && hasTerminalDragData(e.dataTransfer))) {
        return
      }
      e.preventDefault()
      setIsDragOver(true)
    },
    [isEmptyTerminalPane]
  )

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only clear when leaving the container, not when moving between children
    if (e.currentTarget.contains(e.relatedTarget as Node)) {
      return
    }
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setIsDragOver(false)

      if (!(isEmptyTerminalPane && actions)) {
        return
      }

      const data = parseTerminalDragData(e.dataTransfer)
      if (!data) {
        return
      }

      actions.assignTerminalToPane(data.terminalId, data.workspaceId, node.id)
    },
    [isEmptyTerminalPane, actions, node.id]
  )

  let borderClass = ''
  if (isDragOver) {
    borderClass = 'border-2 border-primary bg-primary/5'
  } else if (isActive) {
    borderClass = 'ring-1 ring-primary/50'
  }

  const paneContent = (
    // biome-ignore lint/a11y/useSemanticElements: Panel pane container requires drag-and-drop target behavior
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Drag-and-drop handlers on pane container are essential for terminal assignment
    <div
      className={`group/pane relative h-full w-full overflow-hidden ${borderClass}`}
      data-pane-id={node.id}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onFocusCapture={() => actions?.setActivePaneId(node.id)}
      onMouseDownCapture={() => actions?.setActivePaneId(node.id)}
      ref={paneContainerRef}
      role="region"
      tabIndex={-1}
    >
      <PaneContent node={node} onTerminalExit={handleTerminalExit} />
      {isOccupiedTerminalPane && (
        <TerminalOverlayToolbar
          actions={actions}
          isFullscreen={isFullscreen}
          paneId={node.id}
        />
      )}
      {pendingClose.paneId === node.id && (
        <PaneCloseConfirmDialog
          onCancel={pendingClose.onCancel}
          onCloseAndDestroy={pendingClose.onCloseAndDestroy}
          onConfirm={pendingClose.onConfirm}
        />
      )}
      {pendingPicker.paneId === node.id && (
        <PanePickerOverlay
          onCancel={pendingPicker.onCancel}
          onSelect={pendingPicker.onSelect}
        />
      )}
    </div>
  )

  // When fullscreened, portal the pane content into a container that sits
  // above the entire panel hierarchy. The pane stays mounted in React's
  // component tree (preserving xterm.js instance, WebGL context, WebSocket
  // connection, and all hook state) but its DOM output renders into an
  // absolutely-positioned overlay at the PanelContent level.
  //
  // Sibling terminals are completely untouched — they keep their DOM
  // position, dimensions, and ResizeObserver state. Only the fullscreened
  // pane needs a re-fit (handled by its ResizeObserver when the portal
  // container expands to fill the panel area). When fullscreen exits, the
  // portal is removed and the pane renders back in its original slot —
  // its ResizeObserver fires one resize, but siblings never changed.
  if (isFullscreen && fullscreenPortalRef) {
    return createPortal(paneContent, fullscreenPortalRef)
  }

  return paneContent
}

/**
 * Recursively renders a PanelNode tree.
 *
 * - LeafNode → renders PaneContent with the appropriate component,
 *   wrapped in a container with active-pane highlighting and drop target
 *   support for terminal drag-and-drop.
 * - SplitNode → renders a ResizablePanelGroup with each child in a
 *   ResizablePanel, separated by ResizableHandles. Supports horizontal
 *   (side-by-side) and vertical (stacked) orientations, and recursive
 *   nesting to arbitrary depth (5+ levels).
 */
function PanelRenderer({ node }: PanelRendererProps) {
  if (node._tag === 'LeafNode') {
    return <LeafPaneRenderer node={node} />
  }

  // SplitNode — render children in a resizable panel group
  if (node.children.length === 0) {
    return null
  }

  return <SplitPanelRenderer node={node} />
}

interface PanelManagerProps {
  /**
   * The root panel node to render. When undefined, renders an empty state
   * guiding the user to create a workspace and spawn a terminal.
   */
  readonly layout?: PanelNode | undefined
}

/**
 * Top-level PanelManager component.
 *
 * Renders the panel layout tree, filling its parent container.
 * Pass a PanelNode tree as the `layout` prop, or omit it for an empty state.
 *
 * Split/close actions are provided via PanelActionsProvider. If no provider
 * is present, the pane toolbar is hidden.
 */
function PanelManager({ layout }: PanelManagerProps) {
  if (!layout) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Layers />
            </EmptyMedia>
            <EmptyTitle>No panels</EmptyTitle>
            <EmptyDescription>
              Create a workspace and spawn a terminal to get started. Panels
              will appear here automatically.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-hidden">
      <PanelRenderer node={layout} />
    </div>
  )
}

export { PanelManager, PanelRenderer, PaneContent, SplitPanelRenderer }
