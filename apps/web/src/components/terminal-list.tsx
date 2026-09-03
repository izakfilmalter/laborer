/**
 * Terminal list UI component per workspace.
 *
 * Two pieces, because they answer two different questions. `TerminalList`
 * shows what is running in a workspace — one row per terminal, its command
 * and its status — and selecting a row switches the active pane to it.
 * `TerminalSpawnControls` starts something new there, and lives in the card's
 * action chrome rather than above the rows. Ordinary workspaces use the status
 * rail; the root uses the title row where its unavailable edit, destroy, and
 * sub-workspace actions would otherwise leave empty space.
 *
 * Terminal items are draggable — users can drag a terminal from the sidebar
 * and drop it onto an empty panel pane to assign it to that specific pane.
 * The drag data carries `{ terminalId, workspaceId }` as JSON in the
 * `application/x-laborer-terminal` MIME type.
 *
 * @see Issue #63: Terminal list per workspace UI
 * @see Issue #134: Drag terminal from sidebar onto empty panel pane
 * @see Issue #144: Web app terminal query replacement
 */

import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import type { LeafNode } from '@laborer/shared/types'
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@laborer/ui/components/alert'
import { Badge } from '@laborer/ui/components/badge'
import { Button } from '@laborer/ui/components/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import {
  AlertTriangle,
  AppWindow,
  FileCode,
  MonitorDot,
  RotateCw,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react'
import type React from 'react'
import { type ReactNode, useCallback, useEffect, useMemo } from 'react'
import { ConfigReactivityKeys, LaborerClient } from '@/atoms/laborer-client'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { AGENT_ICONS } from '@/components/agent-icons'
import { AgentStatusBadge } from '@/components/agent-status-badge'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import type {
  AgentStatusSnapshot,
  ForegroundProcess,
} from '@/hooks/use-terminal-list'
import { useTerminalList } from '@/hooks/use-terminal-list'
import { useWhenPhase } from '@/hooks/use-when-phase'
import {
  type AgentDisplayStatus,
  deriveAgentDisplayStatus,
} from '@/lib/agent-attention-projection'
import {
  describeAgentStatus,
  getAgentStatusBadgeClassName,
  getAgentStatusPresentation,
  getAgentStatusSurface,
} from '@/lib/agent-status-presentation'
import { extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { deriveWorkspaceAgentStatus } from '@/lib/workspace-agent-status'
import {
  useActivePaneId,
  useActiveWorkspaceId,
  usePanelActions,
} from '@/panels/panel-context'

const restartTerminalMutation =
  TerminalServiceClient.mutation('terminal.restart')

interface TerminalListProps {
  /** Called when the aggregate agent status for this workspace changes. */
  readonly onAgentStatusChange?:
    | ((status: AgentDisplayStatus | null) => void)
    | undefined
  /** The workspace ID to filter terminals for. */
  readonly workspaceId: string
}

/** Quiet chrome: the controls recede until pointed at, so a column of cards
 *  reads as branch names and statuses rather than as a wall of buttons.
 *
 *  The agent button keeps its word: it is the action the card exists for, and
 *  an unlabelled provider glyph is a guess. The terminal beside it stays a
 *  glyph plus tooltip, so the pair costs the badge rail one word instead of
 *  two. */
const SPAWN_BUTTON_CLASS =
  'text-muted-foreground hover:text-foreground dark:bg-transparent dark:hover:bg-muted/50'

const SPAWN_ICON_BUTTON_CLASS = `size-6 ${SPAWN_BUTTON_CLASS}`

/**
 * Spawn buttons for creating new terminals and agents.
 * Extracted to encapsulate phase-gating logic and reduce complexity.
 */
function TerminalSpawnButtons({
  agentProvider,
  isServiceAvailable,
  onSpawnAgent,
  onSpawnTerminal,
}: {
  readonly agentProvider: string
  readonly isServiceAvailable: boolean
  readonly onSpawnAgent: (event: React.MouseEvent) => void
  readonly onSpawnTerminal: (event: React.MouseEvent) => void
}) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const AgentIcon =
    AGENT_ICONS[agentProvider as keyof typeof AGENT_ICONS] ??
    AGENT_ICONS.opencode

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={`Start ${agentProvider} agent`}
              className={SPAWN_BUTTON_CLASS}
              data-testid="start-agent"
              disabled={!(isServerReady && isServiceAvailable)}
              onClick={onSpawnAgent}
              size="xs"
              title={isServerReady ? undefined : 'Connecting to server...'}
              variant="outline"
            />
          }
        >
          <AgentIcon className="size-3" />
          Agent
        </TooltipTrigger>
        <TooltipContent>Start {agentProvider} in a new terminal</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="New terminal"
              className={SPAWN_ICON_BUTTON_CLASS}
              disabled={!(isServerReady && isServiceAvailable)}
              onClick={onSpawnTerminal}
              size="icon-xs"
              title={isServerReady ? undefined : 'Connecting to server...'}
              variant="outline"
            />
          }
        >
          <TerminalIcon className="size-3" />
        </TooltipTrigger>
        <TooltipContent>Open a new terminal in this workspace</TooltipContent>
      </Tooltip>
    </div>
  )
}

type TerminalSpawnButtonProps = Omit<
  Parameters<typeof TerminalSpawnButtons>[0],
  'agentProvider'
>

function ConfiguredTerminalSpawnButtons({
  projectId,
  ...props
}: TerminalSpawnButtonProps & { readonly projectId: string }) {
  const configGet$ = useMemo(
    () =>
      LaborerClient.query(
        'config.get',
        { projectId },
        { reactivityKeys: ConfigReactivityKeys }
      ),
    [projectId]
  )
  const configResult = useAtomValue(configGet$)
  const agentProvider =
    configResult._tag === 'Success'
      ? configResult.value.agent.value
      : 'opencode2'

  return <TerminalSpawnButtons {...props} agentProvider={agentProvider} />
}

function ConfigAwareTerminalSpawnButtons({
  projectId,
  ...props
}: TerminalSpawnButtonProps & { readonly projectId: string }) {
  const isEventuallyReady = useWhenPhase(LifecyclePhase.Eventually)

  if (!isEventuallyReady) {
    return <TerminalSpawnButtons {...props} agentProvider="opencode2" />
  }

  return <ConfiguredTerminalSpawnButtons {...props} projectId={projectId} />
}

/**
 * Opens a terminal in a workspace: beside the active pane when the operator
 * is already in this workspace, otherwise in a new panel tab. Cmd splits
 * down instead of across.
 *
 * The workspace ownership check prevents a bug where clicking "New" on
 * workspace B (while workspace A is focused) would split workspace A's pane
 * instead of creating a new panel in workspace B.
 */
function useSpawnInWorkspace(
  workspaceId: string,
  isServiceAvailable: boolean,
  paneType: 'agent' | 'terminal'
) {
  const panelActions = usePanelActions()
  const activePaneId = useActivePaneId()
  const activeWorkspaceId = useActiveWorkspaceId()

  return useCallback(
    (event: React.MouseEvent) => {
      if (!isServiceAvailable) {
        toast.error('Terminal service unavailable')
        return
      }
      if (!panelActions) {
        return
      }
      const direction = event.metaKey ? 'vertical' : 'horizontal'
      const paneIsInThisWorkspace = activeWorkspaceId === workspaceId
      if (activePaneId && paneIsInThisWorkspace) {
        panelActions.splitPane(activePaneId, direction, {
          paneType,
          workspaceId,
        } as Partial<LeafNode>)
      } else {
        panelActions.addPanelTab?.(workspaceId, paneType)
      }
    },
    [
      isServiceAvailable,
      workspaceId,
      paneType,
      panelActions,
      activePaneId,
      activeWorkspaceId,
    ]
  )
}

/**
 * The "start work here" controls for a workspace — the configured agent, and
 * a plain terminal.
 *
 * They live in the workspace's action chrome rather than above its terminal
 * rows, because they are what you do to a workspace and not a label for the
 * list below them. A workspace with no terminals then costs nothing: its card
 * is a name, a status, and the two ways to begin.
 */
function TerminalSpawnControls({
  projectId,
  workspaceId,
}: {
  readonly projectId: string
  readonly workspaceId: string
}) {
  const { isServiceAvailable } = useTerminalList()
  const onSpawnAgent = useSpawnInWorkspace(
    workspaceId,
    isServiceAvailable,
    'agent'
  )
  const onSpawnTerminal = useSpawnInWorkspace(
    workspaceId,
    isServiceAvailable,
    'terminal'
  )

  return (
    <ConfigAwareTerminalSpawnButtons
      isServiceAvailable={isServiceAvailable}
      onSpawnAgent={onSpawnAgent}
      onSpawnTerminal={onSpawnTerminal}
      projectId={projectId}
    />
  )
}

/**
 * The terminals running in a single workspace, one row each.
 *
 * The list is only the rows: it carries no heading and no empty state,
 * because the card around it already names the workspace and offers the
 * controls that start a terminal. A workspace with nothing running renders
 * nothing at all, so a quiet card is a short card.
 */
function TerminalList({ onAgentStatusChange, workspaceId }: TerminalListProps) {
  const {
    errorMessage,
    isServiceAvailable,
    terminals: terminalList,
  } = useTerminalList()
  const panelActions = usePanelActions()
  const restartTerminal = useAtomSet(restartTerminalMutation, {
    mode: 'promise',
  })

  // Filter terminals for this workspace and derive aggregate agent status
  const workspaceTerminals = terminalList.filter(
    (t) => t.workspaceId === workspaceId
  )

  const workspaceAgentStatus = useMemo(
    () => deriveWorkspaceAgentStatus(workspaceTerminals),
    [workspaceTerminals]
  )

  useEffect(() => {
    onAgentStatusChange?.(workspaceAgentStatus)
  }, [onAgentStatusChange, workspaceAgentStatus])

  const handleCloseTerminal = useCallback(
    (terminalId: string) => {
      if (panelActions) {
        panelActions.closeTerminalPane(terminalId)
      }
    },
    [panelActions]
  )

  const handleRestartTerminal = useCallback(
    async (terminalId: string) => {
      try {
        await restartTerminal({
          payload: { id: terminalId },
        })
        toast.success('Terminal restarted')
      } catch (error) {
        toast.error(`Failed to restart terminal: ${extractErrorMessage(error)}`)
      }
    },
    [restartTerminal]
  )

  const handleSelectTerminal = useCallback(
    (terminalId: string) => {
      if (panelActions) {
        panelActions.assignTerminalToPane(terminalId, workspaceId)
      }
    },
    [panelActions, workspaceId]
  )

  const unavailableMessage = errorMessage
    ? `${errorMessage}. The terminal service may be starting or crashed.`
    : 'The terminal service is unavailable. Check sidecar status.'

  const unavailableAlert = isServiceAvailable ? null : (
    <Alert className="rounded-md" variant="destructive">
      <AlertTriangle className="size-3.5" />
      <AlertTitle>Terminal service unavailable</AlertTitle>
      <AlertDescription>{unavailableMessage}</AlertDescription>
    </Alert>
  )

  if (isServiceAvailable && workspaceTerminals.length === 0) {
    return null
  }

  return (
    // Terminal rows own their own pointer: they are draggable onto panes, and
    // on the kanban board the card around them is itself a drag handle.
    // Without this a press on a row would start both drags at once.
    <div
      className="grid gap-1"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {unavailableAlert}
      {workspaceTerminals.map((terminal) => (
        <TerminalItem
          key={terminal.id}
          onClose={handleCloseTerminal}
          onRestart={handleRestartTerminal}
          onSelect={handleSelectTerminal}
          terminal={terminal}
        />
      ))}
    </div>
  )
}

interface TerminalItemProps {
  readonly onClose: (terminalId: string) => void
  readonly onRestart: (terminalId: string) => void
  readonly onSelect: (terminalId: string) => void
  readonly terminal: {
    readonly id: string
    readonly workspaceId: string
    readonly command: string
    readonly agentStatus: AgentStatusSnapshot | null
    readonly foregroundProcess: ForegroundProcess | null
    readonly processChain: readonly ForegroundProcess[]
    readonly sessionTitle: string | null
    readonly status: string
  }
}

/**
 * Row controls sit a step behind the row's name at rest and come up to full
 * ink when the row is pointed at or focused, so the name leads and the
 * buttons are still always there to hit.
 */
const ROW_ACTION_CLASS =
  'size-5 shrink-0 text-muted-foreground/70 transition-colors group-focus-within/row:text-muted-foreground group-hover/row:text-muted-foreground'

/**
 * MIME type for terminal drag data. Using a custom MIME type ensures
 * only laborer drop targets accept the drag.
 */
const TERMINAL_DRAG_MIME = 'application/x-laborer-terminal'

/**
 * Map from agent rawName to its icon component for sidebar display.
 * Only includes agents that have dedicated icons.
 */
const AGENT_ICON_BY_RAW_NAME: Record<
  string,
  ((props: { className?: string }) => ReactNode) | undefined
> = {
  claude: AGENT_ICONS.claude,
  opencode: AGENT_ICONS.opencode,
  opencode2: AGENT_ICONS.opencode2,
  codex: AGENT_ICONS.codex,
}

/**
 * Map from agent command names (lowercase) to their display label and icon.
 *
 * Used as a fallback when `foregroundProcess` is null (idle / pre-detection).
 * Without this, agent terminals show the raw command string ("opencode")
 * and a generic terminal icon until the background detection fiber detects
 * the process. This map ensures agent branding is shown immediately.
 */
const AGENT_COMMAND_DISPLAY: Record<
  string,
  { readonly label: string; readonly icon: ReactNode } | undefined
> = {
  claude: {
    label: 'Claude',
    icon: <AGENT_ICONS.claude className="size-3.5 shrink-0" />,
  },
  opencode: {
    label: 'OpenCode',
    icon: <AGENT_ICONS.opencode className="size-3.5 shrink-0" />,
  },
  opencode2: {
    label: 'OpenCode 2',
    icon: <AGENT_ICONS.opencode2 className="size-3.5 shrink-0" />,
  },
  codex: {
    label: 'Codex',
    icon: <AGENT_ICONS.codex className="size-3.5 shrink-0" />,
  },
}

/**
 * Get the icon for a process based on its category and raw name.
 */
function getProcessIcon(
  category: ForegroundProcess['category'],
  rawName: string
): ReactNode {
  switch (category) {
    case 'agent': {
      const AgentIcon = AGENT_ICON_BY_RAW_NAME[rawName]
      return AgentIcon ? (
        <AgentIcon className="size-3.5 shrink-0" />
      ) : (
        <MonitorDot className="size-3.5 shrink-0 text-blue-400" />
      )
    }
    case 'editor':
      return <FileCode className="size-3.5 shrink-0 text-amber-400" />
    case 'devServer':
      return <AppWindow className="size-3.5 shrink-0 text-emerald-400" />
    default:
      return <TerminalIcon className="size-3.5 shrink-0 text-success" />
  }
}

/**
 * Build a display label from the process chain. Shows the root process
 * label followed by " › subprocess" for each deeper process in the chain.
 * e.g. "OpenCode › biome", "OpenCode › Node.js"
 */
function buildChainLabel(processChain: readonly ForegroundProcess[]): string {
  return processChain.map((p) => p.label).join(' \u203A ')
}

/**
 * Get the badge info for a process category.
 */
function getCategoryBadge(category: ForegroundProcess['category']): {
  badgeLabel: string
  badgeClassName: string
} {
  switch (category) {
    case 'agent':
      return {
        badgeLabel: 'agent',
        badgeClassName: 'border-blue-400/30 bg-blue-400/10 text-blue-400',
      }
    case 'editor':
      return {
        badgeLabel: 'editor',
        badgeClassName: 'border-amber-400/30 bg-amber-400/10 text-amber-400',
      }
    case 'devServer':
      return {
        badgeLabel: 'running',
        badgeClassName:
          'border-emerald-400/30 bg-emerald-400/10 text-emerald-400',
      }
    case 'shell':
      return {
        badgeLabel: 'idle',
        badgeClassName: 'border-success/30 bg-success/10 text-success',
      }
    default:
      return {
        badgeLabel: 'running',
        badgeClassName: 'border-success/30 bg-success/10 text-success',
      }
  }
}

function getAgentStatusDisplay(
  commandLabel: string,
  foregroundProcess: ForegroundProcess | null,
  rootProcess: ForegroundProcess | null,
  agentCommandInfo:
    | { readonly label: string; readonly icon: ReactNode }
    | undefined,
  agentStatus: AgentStatusSnapshot
) {
  const displayedAgentProcess =
    rootProcess ??
    (foregroundProcess?.category === 'agent' ? foregroundProcess : null)
  const presentation = getAgentStatusPresentation(
    deriveAgentDisplayStatus(agentStatus)
  )

  return {
    icon: displayedAgentProcess
      ? getProcessIcon(
          displayedAgentProcess.category,
          displayedAgentProcess.rawName
        )
      : (agentCommandInfo?.icon ?? (
          <TerminalIcon className="size-3.5 shrink-0 text-amber-400" />
        )),
    label: displayedAgentProcess
      ? displayedAgentProcess.label
      : (agentCommandInfo?.label ?? commandLabel),
    badgeLabel: presentation.label,
    badgeClassName: getAgentStatusBadgeClassName(agentStatus),
    badgeTitle: describeAgentStatus(agentStatus),
    agentStatus,
  }
}

/**
 * Get the icon and label to display for a terminal based on its
 * process chain and agent status. Uses the root process (first in chain)
 * for the icon, and shows the full chain as "root › sub › sub" in the label.
 * Falls back to the terminal command name when idle.
 */
function getTerminalDisplay(
  command: string,
  foregroundProcess: ForegroundProcess | null,
  isRunning: boolean,
  agentStatus: AgentStatusSnapshot | null,
  processChain: readonly ForegroundProcess[] = []
): {
  icon: ReactNode
  label: string
  badgeLabel: string | null
  badgeClassName: string | null
  badgeTitle?: string
  /**
   * Present only for agent terminals, so the row can render the shared
   * semantic status badge (dot, motion, provenance) instead of a plain one.
   */
  agentStatus?: AgentStatusSnapshot
} {
  const rootProcess = processChain[0] ?? null
  const commandLabel = command || 'shell'

  // Fallback agent display derived from the terminal command name.
  // Ensures agent branding (icon + capitalised label) is shown even when
  // `foregroundProcess` is null (pre-detection, idle, or shell at prompt).
  const agentCommandInfo = AGENT_COMMAND_DISPLAY[command.toLowerCase()]

  if (!isRunning) {
    return {
      icon: agentCommandInfo?.icon ?? (
        <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ),
      label: agentCommandInfo?.label ?? commandLabel,
      badgeLabel: 'stopped',
      badgeClassName:
        'border-muted-foreground/30 bg-muted text-muted-foreground',
    }
  }

  if (agentStatus !== null) {
    return getAgentStatusDisplay(
      commandLabel,
      foregroundProcess,
      rootProcess,
      agentCommandInfo,
      agentStatus
    )
  }

  // No foreground process detected — shell is idle at prompt.
  // For agent commands, show the agent icon and label instead of
  // the raw command string.
  if (foregroundProcess === null) {
    return {
      icon: agentCommandInfo?.icon ?? (
        <TerminalIcon className="size-3.5 shrink-0 text-success" />
      ),
      label: agentCommandInfo?.label ?? commandLabel,
      badgeLabel: 'idle',
      badgeClassName: 'border-success/30 bg-success/10 text-success',
    }
  }

  // Use the root process for the icon, the full chain for the label,
  // and the deepest (foreground) process for the badge category.
  const displayRoot = rootProcess ?? foregroundProcess
  const icon = getProcessIcon(displayRoot.category, displayRoot.rawName)
  const label =
    processChain.length > 0
      ? buildChainLabel(processChain)
      : foregroundProcess.label

  // Shell category means idle at prompt
  if (foregroundProcess.category === 'shell') {
    return {
      icon: agentCommandInfo?.icon ?? (
        <TerminalIcon className="size-3.5 shrink-0 text-success" />
      ),
      label: agentCommandInfo?.label ?? commandLabel,
      badgeLabel: 'idle',
      badgeClassName: 'border-success/30 bg-success/10 text-success',
    }
  }

  const { badgeLabel, badgeClassName } = getCategoryBadge(
    foregroundProcess.category
  )

  return { icon, label, badgeLabel, badgeClassName }
}

function TerminalItem({
  terminal,
  onSelect,
  onClose,
  onRestart,
}: TerminalItemProps) {
  const isRunning = terminal.status === 'running'
  const { agentStatus, icon, label, badgeLabel, badgeClassName, badgeTitle } =
    getTerminalDisplay(
      terminal.command,
      terminal.foregroundProcess,
      isRunning,
      terminal.agentStatus,
      terminal.processChain
    )
  const displayStatus = agentStatus
    ? deriveAgentDisplayStatus(agentStatus)
    : null
  const agentSurface = getAgentStatusSurface(displayStatus)

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLButtonElement>) => {
      e.dataTransfer.setData(
        TERMINAL_DRAG_MIME,
        JSON.stringify({
          terminalId: terminal.id,
          workspaceId: terminal.workspaceId,
        })
      )
      e.dataTransfer.effectAllowed = 'move'
    },
    [terminal.id, terminal.workspaceId]
  )

  return (
    <div
      className={cn(
        // A row is its own object inside the card, not a tint of it. The
        // resting fill is a full step up from the card surface and carries a
        // hairline edge, so a terminal reads as a thing you can act on at a
        // glance; hover lifts it one further step. `bg-muted/40` blended back
        // down to almost the card colour, which is what made a column of rows
        // read as one grey smear.
        'group/row flex w-full min-w-0 items-center gap-1.5 rounded-md border border-foreground/8 bg-muted/25 py-1 pr-1 pl-1.5 text-left text-xs transition-colors',
        // A row that wants something carries a steady edge from the shared
        // vocabulary — amber to act on, violet to review — and the motion
        // stays in the badge so the label remains readable. The hover
        // treatment comes from the same vocabulary so pointing at an
        // accented row deepens its hue instead of washing it to plain
        // accent grey.
        agentSurface.rowClassName,
        agentSurface.rowHoverClassName
      )}
      data-agent-status={displayStatus ?? undefined}
      data-testid={`terminal-row-${terminal.id}`}
    >
      <button
        className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:cursor-grabbing"
        draggable
        onClick={() => onSelect(terminal.id)}
        onDragStart={handleDragStart}
        type="button"
      >
        {icon}
        {/*
          The agent name identifies the tool and the session title identifies
          the work. The name keeps a bounded share of the row so the title
          absorbs the remaining space and truncates first — the agent a row
          belongs to must stay legible even when its session has a long name.
        */}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 truncate font-medium font-mono text-foreground',
              terminal.sessionTitle === null ? 'flex-1' : 'max-w-[60%] shrink-0'
            )}
          >
            {label}
          </span>
          {terminal.sessionTitle === null ? null : (
            <>
              <span
                aria-hidden="true"
                className="shrink-0 text-muted-foreground/60"
              >
                &middot;
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                title={terminal.sessionTitle}
              >
                {terminal.sessionTitle}
              </span>
            </>
          )}
        </span>
        {agentStatus ? (
          <AgentStatusBadge className="shrink-0" snapshot={agentStatus} />
        ) : null}
        {!agentStatus && badgeLabel !== null && badgeClassName !== null && (
          <Badge
            className={cn(
              'shrink-0 border text-[10px] leading-none',
              badgeClassName
            )}
            title={badgeTitle}
            variant="outline"
          >
            {badgeLabel}
          </Badge>
        )}
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Restart terminal"
              className={cn(ROW_ACTION_CLASS, 'hover:text-foreground')}
              onClick={(e) => {
                e.stopPropagation()
                onRestart(terminal.id)
              }}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <RotateCw className="size-2.5" />
        </TooltipTrigger>
        <TooltipContent>Restart</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Close terminal"
              className={cn(ROW_ACTION_CLASS, 'hover:text-destructive')}
              onClick={(e) => {
                e.stopPropagation()
                onClose(terminal.id)
              }}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <X className="size-2.5" />
        </TooltipTrigger>
        <TooltipContent>Close</TooltipContent>
      </Tooltip>
    </div>
  )
}

export { getTerminalDisplay, TerminalList, TerminalSpawnControls }
