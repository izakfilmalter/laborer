/**
 * Tab strip, add-surface menu, and empty-state launcher for the workspace
 * right panel. Ported from t3code's `RightPanelTabs`.
 *
 * Laborer adaptations:
 * - The native desktop context menu is replaced with `@laborer/ui`'s
 *   Base UI context menu (Close / Close others / Close to the right /
 *   Close all).
 * - Preview-session and desktop-overlay (favicon/audio) plumbing is left
 *   out until those surfaces exist; titles and icons fall back to static
 *   names.
 * - There is no Terminal surface: Laborer terminals live in the main panel
 *   tabs/splits, so the launcher offers five cards and the `T` shortcut is
 *   unassigned.
 * - The tab bar is `h-8`, matching Laborer's workspace chrome (frame header
 *   and pane tab bars) instead of t3's `--workspace-topbar-height`.
 */
import { Button } from '@laborer/ui/components/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@laborer/ui/components/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@laborer/ui/components/dropdown-menu'
import { Kbd } from '@laborer/ui/components/kbd'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import {
  Bot,
  FileCode2,
  FileDiff,
  Files,
  GitPullRequest,
  Globe2,
  Plus,
} from 'lucide-react'
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { RightPanelSurface } from '@/right-panel-store'
import { PanelTabCloseButton } from './panel-tab-close-button'
import { RightPanelShell } from './right-panel-shell'

interface RightPanelTabsProps {
  readonly activeSurfaceId: string | null
  readonly agentsAvailable: boolean
  readonly browserAvailable: boolean
  readonly children: ReactNode
  readonly diffAvailable: boolean
  readonly filesAvailable: boolean
  /** Running + waiting subagents; badges the Agents card in the empty state. */
  readonly liveAgentCount?: number
  readonly onActivate: (surface: RightPanelSurface) => void
  readonly onAddAgents: () => void
  readonly onAddBrowser: () => void
  readonly onAddDiff: () => void
  readonly onAddFiles: () => void
  readonly onAddPullRequest: () => void
  readonly onCloseAllSurfaces: () => void
  readonly onCloseOtherSurfaces: (surface: RightPanelSurface) => void
  readonly onCloseSurface: (surface: RightPanelSurface) => void
  readonly onCloseSurfacesToRight: (surface: RightPanelSurface) => void
  readonly pullRequestAvailable: boolean
  /** The workspace's PR number, used for the pull-request tab title. */
  readonly pullRequestNumber?: number | null | undefined
  readonly surfaces: readonly RightPanelSurface[]
  /** localStorage key this panel persists its width under. */
  readonly widthStorageKey: string
}

const SURFACE_DISABLED_REASONS = {
  browser: 'Browser previews are only available in the desktop app.',
  files: 'The file explorer is coming soon.',
  diff: 'Diff is only available inside a workspace.',
  pullRequest: "This workspace's branch has no pull request yet.",
  agents: 'Agent surfaces are coming soon.',
} as const

/** Overlays that must win over the launcher's letter shortcuts. */
const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="menubar-content"]',
  '[data-slot="select-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="combobox-content"]',
  '[data-slot="command"]',
].join(',')

/** One-line unavailability hints for the empty-state cards. */
const SURFACE_UNAVAILABLE_HINTS = {
  browser: 'Only available in the desktop app.',
  files: 'Coming soon.',
  diff: 'Available inside a workspace.',
  pullRequest: 'No pull request on this branch yet.',
  agents: 'Coming soon.',
} as const

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'defaultPrevented' | 'isComposing' | 'key' | 'metaKey'
>

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) {
    return null
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return null
  }
  return (
    actions.find(
      (action) =>
        action.available &&
        action.shortcut.toLowerCase() === event.key.toLowerCase()
    ) ?? null
  )
}

/**
 * A focused editable is a typing context whether or not it has text yet: an
 * empty composer at rest is still where the user's next keystrokes are
 * meant to land, and claiming launcher letters from it would redirect input
 * into whatever surface opens. The `:not` clause lets `closest` see past
 * non-editable islands (`contenteditable="false"`) to an editable host
 * around them.
 */
export function surfaceShortcutTargetsTypingContext(
  target: { closest(selectors: string): unknown } | null
): boolean {
  return (
    target?.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
    ) != null
  )
}

/**
 * Arrow-key traversal for the launcher grid: the next highlight index, or
 * null when the key is not a traversal key. -1 highlights nothing.
 */
export function launcherHighlightForKey(
  key: string,
  highlightIndex: number,
  actionCount: number
): number | null {
  if (key === 'ArrowDown' || key === 'ArrowRight') {
    return (highlightIndex + 1) % actionCount
  }
  if (key === 'ArrowUp' || key === 'ArrowLeft') {
    return highlightIndex === -1
      ? actionCount - 1
      : (highlightIndex - 1 + actionCount) % actionCount
  }
  return null
}

function DisabledReasonTooltip(props: {
  reason: string
  trigger: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipContent side="top">{props.reason}</TooltipContent>
    </Tooltip>
  )
}

function SurfaceMenuItem(props: {
  available: boolean
  disabledReason?: string
  shortcut: string
  onClick: () => void
  children: ReactNode
}) {
  const item = (
    <DropdownMenuItem
      aria-keyshortcuts={props.shortcut}
      className={
        props.available ? undefined : 'data-disabled:pointer-events-auto'
      }
      disabled={!props.available}
      onClick={props.onClick}
    >
      {props.children}
      <DropdownMenuShortcut>{props.shortcut}</DropdownMenuShortcut>
    </DropdownMenuItem>
  )
  if (props.available || !props.disabledReason) {
    return item
  }
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />
}

/**
 * Card launcher shown when the right panel has no surfaces. Keyboard-first
 * without palette chrome: a surface's letter opens it directly from anywhere
 * outside a typing context, and arrows plus Enter work while the launcher is
 * focused. The highlight only appears on hover or arrow use. Unavailable
 * surfaces stay visible with a one-line reason.
 */
function RightPanelEmptyState(props: {
  onAddBrowser: () => void
  onAddDiff: () => void
  onAddFiles: () => void
  onAddPullRequest: () => void
  onAddAgents: () => void
  browserAvailable: boolean
  diffAvailable: boolean
  filesAvailable: boolean
  pullRequestAvailable: boolean
  agentsAvailable: boolean
  liveAgentCount: number
}) {
  // -1 means no highlight: it only appears on hover or arrow use.
  const [highlight, setHighlight] = useState(-1)

  const actions = [
    {
      label: 'Browser',
      description: 'Open a local app or URL.',
      icon: Globe2,
      shortcut: 'B',
      available: props.browserAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.browser,
      onClick: props.onAddBrowser,
      badgeCount: 0,
    },
    {
      label: 'Files',
      description: 'Browse and read workspace files.',
      icon: Files,
      shortcut: 'F',
      available: props.filesAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.files,
      onClick: props.onAddFiles,
      badgeCount: 0,
    },
    {
      label: 'Diff',
      description: 'Review changes in this workspace.',
      icon: FileDiff,
      shortcut: 'D',
      available: props.diffAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.diff,
      onClick: props.onAddDiff,
      badgeCount: 0,
    },
    {
      label: 'Pull request',
      description: "Open this branch's pull request.",
      icon: GitPullRequest,
      shortcut: 'P',
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequest,
      onClick: props.onAddPullRequest,
      badgeCount: 0,
    },
    {
      label: 'Agents',
      description: 'Follow subagents and workflows.',
      icon: Bot,
      shortcut: 'A',
      available: props.agentsAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.agents,
      onClick: props.onAddAgents,
      badgeCount: props.liveAgentCount,
    },
  ] as const

  type SurfaceAction = (typeof actions)[number]

  const availableActions = actions.filter((action) => action.available)
  const highlightIndex =
    availableActions.length === 0
      ? -1
      : Math.min(highlight, availableActions.length - 1)

  // Letter shortcuts work while the launcher is visible, not only while it
  // is focused; focus moves around too easily (stray clicks) to carry them.
  // Capture phase so app-level key handlers cannot swallow the event first;
  // typing contexts and already-handled events are left alone.
  const shortcutActionsRef = useRef(availableActions)
  useEffect(() => {
    shortcutActionsRef.current = availableActions
  })
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const action = surfaceShortcutActionForKey(
        shortcutActionsRef.current,
        event
      )
      if (!action) {
        return
      }
      if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) {
        return
      }
      const target = event.target
      if (
        target instanceof Element &&
        surfaceShortcutTargetsTypingContext(target)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      action.onClick()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      availableActions.length === 0
    ) {
      return
    }
    const nextHighlight = launcherHighlightForKey(
      event.key,
      highlightIndex,
      availableActions.length
    )
    if (nextHighlight !== null) {
      event.preventDefault()
      setHighlight(nextHighlight)
      return
    }
    if (event.key === 'Enter') {
      // A focused card button owns its own activation; only open from the
      // highlight when the container itself has focus.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('button')
      ) {
        return
      }
      const action = availableActions[highlightIndex]
      if (!action) {
        return
      }
      event.preventDefault()
      action.onClick()
    }
  }

  // Stable identity so React only runs this callback ref on mount/unmount;
  // an inline arrow would re-attach and re-focus on every render.
  const focusOnMount = useCallback((node: HTMLDivElement | null) => {
    node?.focus()
  }, [])

  const isHighlighted = (action: SurfaceAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action

  const actionIcon = (action: SurfaceAction, iconClassName = 'size-4') => {
    const Icon = action.icon
    return (
      <span className="relative inline-flex shrink-0">
        <Icon className={iconClassName} />
        {action.badgeCount > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 font-semibold text-[9px] text-primary-foreground tabular-nums"
          >
            {action.badgeCount}
          </span>
        ) : null}
      </span>
    )
  }

  const cardShellClass =
    'rounded-lg border border-border/80 bg-card dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5'
  const highlightedCardClass = 'bg-accent/60 dark:inset-ring-white/20'

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: key handling lives on the container so arrows work without focusing a card, matching t3's keyboard-first launcher.
    <section
      aria-label="Open a surface"
      className={cn(
        'flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pt-6 outline-none',
        // The panel topbar sits above this container; matching bottom padding
        // keeps the cards centered against the full panel, not the leftover.
        'pb-14'
      )}
      data-surface-launcher-keys={availableActions
        .map((action) => action.shortcut)
        .join('')}
      onKeyDown={handleKeyDown}
      ref={focusOnMount}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the container is the launcher's focus target so arrows and Enter work before any card is focused.
      tabIndex={0}
    >
      <div className="relative w-full max-w-lg">
        <div className="absolute inset-x-0 bottom-full mb-5 text-center">
          <h3 className="font-medium text-foreground text-sm">
            Open a surface
          </h3>
          <p className="mt-1 text-muted-foreground text-xs">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) =>
            action.available ? (
              <button
                className={cn(
                  'relative flex w-full cursor-pointer flex-col items-start p-4 text-left transition hover:border-border hover:bg-accent/60',
                  cardShellClass,
                  isHighlighted(action) && highlightedCardClass
                )}
                key={action.label}
                onClick={action.onClick}
                onMouseEnter={() =>
                  setHighlight(availableActions.indexOf(action))
                }
                onMouseLeave={() =>
                  setHighlight((current) =>
                    current === availableActions.indexOf(action) ? -1 : current
                  )
                }
                type="button"
              >
                <Kbd className="absolute top-3 right-3">{action.shortcut}</Kbd>
                <span className="flex items-center gap-2 pe-8">
                  {actionIcon(action)}
                  <span className="font-medium text-sm">{action.label}</span>
                </span>
                <span className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                  {action.description}
                </span>
              </button>
            ) : (
              <div
                className={cn(
                  'relative flex w-full flex-col items-start p-4 opacity-40',
                  cardShellClass
                )}
                key={action.label}
              >
                <Kbd className="absolute top-3 right-3">{action.shortcut}</Kbd>
                <span className="flex items-center gap-2 pe-8">
                  {actionIcon(action)}
                  <span className="font-medium text-sm">{action.label}</span>
                </span>
                <span className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                  {action.disabledReason}
                </span>
              </div>
            )
          )}
        </div>
      </div>
    </section>
  )
}

function surfaceTitle(
  surface: RightPanelSurface,
  pullRequestNumber: number | null | undefined
): string {
  switch (surface.kind) {
    case 'diff':
      return 'Diff'
    case 'files':
      return 'Files'
    case 'file':
      return surface.relativePath.slice(
        surface.relativePath.lastIndexOf('/') + 1
      )
    case 'pull-request':
      return pullRequestNumber == null
        ? 'Pull request'
        : `#${pullRequestNumber}`
    case 'agents':
      return 'Agents'
    case 'preview':
      return 'Browser'
    default:
      return surface satisfies never
  }
}

function SurfaceIcon({ surface }: { surface: RightPanelSurface }) {
  switch (surface.kind) {
    case 'preview':
      return <Globe2 className="size-3 shrink-0" />
    case 'diff':
      return <FileDiff className="size-3 shrink-0" />
    case 'files':
      return <Files className="size-3 shrink-0" />
    case 'file':
      return <FileCode2 className="size-3 shrink-0" />
    case 'pull-request':
      return <GitPullRequest className="size-3 shrink-0" />
    case 'agents':
      return <Bot className="size-3 shrink-0" />
    default:
      return surface satisfies never
  }
}

/** One tab in the strip, wrapped in a right-click close context menu. */
function RightPanelTab({
  active,
  onActivate,
  onCloseAll,
  onCloseOthers,
  onCloseSurface,
  onCloseToRight,
  surface,
  surfaceCount,
  surfaceIndex,
  title,
}: {
  readonly active: boolean
  readonly onActivate: () => void
  readonly onCloseAll: () => void
  readonly onCloseOthers: () => void
  readonly onCloseSurface: () => void
  readonly onCloseToRight: () => void
  readonly surface: RightPanelSurface
  readonly surfaceCount: number
  readonly surfaceIndex: number
  readonly title: string
}) {
  const handleMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) {
      return
    }
    event.preventDefault()
  }, [])
  const handleAuxClick = useCallback(
    (event: ReactMouseEvent) => {
      if (event.button !== 1) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      onCloseSurface()
    },
    [onCloseSurface]
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          // biome-ignore lint/a11y/noStaticElementInteractions: middle-click close mirrors browser tab strips; the inner buttons carry keyboard access.
          // biome-ignore lint/a11y/noNoninteractiveElementInteractions: same as above — pointer-only affordances layered over keyboard-accessible buttons.
          <div
            className={cn(
              'group/tab flex h-6 max-w-36 shrink-0 cursor-pointer items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs',
              active
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
            data-active-tab={active}
            onAuxClick={handleAuxClick}
            onMouseDown={handleMouseDown}
          >
            <PanelTabCloseButton
              label={`Close ${title}`}
              onClick={onCloseSurface}
            >
              <SurfaceIcon surface={surface} />
            </PanelTabCloseButton>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    className="flex min-w-0 cursor-pointer items-center"
                    onClick={onActivate}
                    type="button"
                  >
                    <span className="truncate">{title}</span>
                  </button>
                }
              />
              <TooltipContent>{title}</TooltipContent>
            </Tooltip>
          </div>
        }
      />
      <ContextMenuContent>
        <ContextMenuItem onClick={onCloseSurface}>Close</ContextMenuItem>
        <ContextMenuItem disabled={surfaceCount <= 1} onClick={onCloseOthers}>
          Close others
        </ContextMenuItem>
        <ContextMenuItem
          disabled={surfaceIndex >= surfaceCount - 1}
          onClick={onCloseToRight}
        >
          Close to the right
        </ContextMenuItem>
        <ContextMenuItem disabled={surfaceCount === 0} onClick={onCloseAll}>
          Close all
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const tabListRef = useRef<HTMLDivElement>(null)
  const [addSurfaceMenuOpen, setAddSurfaceMenuOpen] = useState(false)

  const addSurfaceActions = [
    {
      label: 'Browser',
      icon: Globe2,
      shortcut: 'B',
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: 'Files',
      icon: Files,
      shortcut: 'F',
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      label: 'Diff',
      icon: FileDiff,
      shortcut: 'D',
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: 'Pull request',
      icon: GitPullRequest,
      shortcut: 'P',
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.pullRequest,
      onClick: props.onAddPullRequest,
    },
    {
      label: 'Agents',
      icon: Bot,
      shortcut: 'A',
      available: props.agentsAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.agents,
      onClick: props.onAddAgents,
    },
  ] as const

  const handleAddSurfaceMenuKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => {
    const action = surfaceShortcutActionForKey(
      addSurfaceActions,
      event.nativeEvent
    )
    if (!action) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    setAddSurfaceMenuOpen(false)
    action.onClick()
  }

  const activeSurfaceId = props.activeSurfaceId
  useEffect(() => {
    if (activeSurfaceId === null) {
      return
    }
    const activeTab = tabListRef.current?.querySelector<HTMLElement>(
      "[data-active-tab='true']"
    )
    // jsdom does not implement scrollIntoView; guard for tests.
    if (typeof activeTab?.scrollIntoView === 'function') {
      activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [activeSurfaceId])

  return (
    <RightPanelShell widthStorageKey={props.widthStorageKey}>
      <div
        className="flex h-8 min-h-8 shrink-0 items-center gap-1 border-b bg-muted/30 pr-3 pl-2"
        data-right-panel-tabbar
      >
        <ScrollArea
          className="min-w-0 flex-1 rounded-none"
          data-right-panel-tab-list
          scrollFade
        >
          <div
            className="flex h-full w-max min-w-full items-center gap-1"
            ref={tabListRef}
          >
            {props.surfaces.map((surface, surfaceIndex) => (
              <RightPanelTab
                active={surface.id === props.activeSurfaceId}
                key={surface.id}
                onActivate={() => props.onActivate(surface)}
                onCloseAll={props.onCloseAllSurfaces}
                onCloseOthers={() => props.onCloseOtherSurfaces(surface)}
                onCloseSurface={() => props.onCloseSurface(surface)}
                onCloseToRight={() => props.onCloseSurfacesToRight(surface)}
                surface={surface}
                surfaceCount={props.surfaces.length}
                surfaceIndex={surfaceIndex}
                title={surfaceTitle(surface, props.pullRequestNumber)}
              />
            ))}
            {props.surfaces.length > 0 ? (
              <DropdownMenu
                onOpenChange={setAddSurfaceMenuOpen}
                open={addSurfaceMenuOpen}
              >
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label="Add panel surface"
                      className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                >
                  <Plus className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="min-w-44"
                  onKeyDownCapture={handleAddSurfaceMenuKeyDown}
                  side="bottom"
                  sideOffset={6}
                >
                  {addSurfaceActions.map((action) => {
                    const Icon = action.icon
                    return (
                      <SurfaceMenuItem
                        available={action.available}
                        disabledReason={action.disabledReason}
                        key={action.label}
                        onClick={action.onClick}
                        shortcut={action.shortcut}
                      >
                        <Icon />
                        {action.label}
                      </SurfaceMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </ScrollArea>
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-right-panel-surface-content
      >
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            agentsAvailable={props.agentsAvailable}
            browserAvailable={props.browserAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            liveAgentCount={props.liveAgentCount ?? 0}
            onAddAgents={props.onAddAgents}
            onAddBrowser={props.onAddBrowser}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddPullRequest={props.onAddPullRequest}
            pullRequestAvailable={props.pullRequestAvailable}
          />
        ) : (
          props.children
        )}
      </div>
    </RightPanelShell>
  )
}
