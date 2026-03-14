/**
 * Terminal list UI component per workspace.
 *
 * Displays all terminals for a given workspace from the terminal service
 * (via the `useTerminalList` polling hook). Each terminal shows its command
 * and status. Includes a "New Terminal" button that spawns a new terminal
 * via the terminal.spawn RPC mutation. Selecting a terminal switches the
 * active pane to display it.
 *
 * Terminal items are draggable — users can drag a terminal from the sidebar
 * and drop it onto an empty panel pane to assign it to that specific pane.
 * The drag data carries `{ terminalId, workspaceId }` as JSON in the
 * `application/x-laborer-terminal` MIME type.
 *
 * @see Issue #63: Terminal list per workspace UI
 * @see Issue #134: Drag terminal from sidebar onto empty panel pane
 * @see Issue #144: Web app LiveStore terminal query replacement
 */

import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import {
  AlertTriangle,
  AppWindow,
  FileCode,
  MonitorDot,
  Plus,
  RotateCw,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react'
import type React from 'react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { ConfigReactivityKeys, LaborerClient } from '@/atoms/laborer-client'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { AGENT_ICONS } from '@/components/agent-icons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type {
  AgentStatus,
  ForegroundProcess,
  TerminalInfo,
} from '@/hooks/use-terminal-list'
import {
  upsertTerminalListItem,
  useTerminalList,
} from '@/hooks/use-terminal-list'
import { toast } from '@/lib/toast'
import { cn, extractErrorMessage } from '@/lib/utils'
import { deriveWorkspaceAgentStatus } from '@/lib/workspace-agent-status'
import { usePanelActions } from '@/panels/panel-context'

const spawnTerminalMutation = LaborerClient.mutation('terminal.spawn')
const restartTerminalMutation =
  TerminalServiceClient.mutation('terminal.restart')

interface TerminalListProps {
  /** Called when the aggregate agent status for this workspace changes. */
  readonly onAgentStatusChange?:
    | ((status: AgentStatus | null) => void)
    | undefined
  /** The project ID this workspace belongs to (for agent config resolution). */
  readonly projectId: string
  /** The workspace ID to filter terminals for. */
  readonly workspaceId: string
}

const buildOptimisticTerminalInfo = (terminal: {
  readonly command: string
  readonly id: string
  readonly status: 'running' | 'stopped'
  readonly workspaceId: string
}): TerminalInfo => ({
  agentStatus: null,
  args: [],
  command: terminal.command,
  cwd: '',
  foregroundProcess: null,
  hasChildProcess: false,
  id: terminal.id,
  processChain: [],
  status: terminal.status,
  workspaceId: terminal.workspaceId,
})

/**
 * Terminal list for a single workspace.
 *
 * Shows all terminals belonging to the workspace, with a "New Terminal"
 * button, an "Agent" button (spawns the configured AI agent), and
 * click-to-select behavior for switching the active panel pane.
 */
function TerminalList({
  onAgentStatusChange,
  projectId,
  workspaceId,
}: TerminalListProps) {
  const {
    errorMessage,
    isServiceAvailable,
    terminals: terminalList,
  } = useTerminalList()
  const panelActions = usePanelActions()
  const spawnTerminal = useAtomSet(spawnTerminalMutation, {
    mode: 'promise',
  })
  const restartTerminal = useAtomSet(restartTerminalMutation, {
    mode: 'promise',
  })
  const [isSpawning, setIsSpawning] = useState(false)
  const [isSpawningAgent, setIsSpawningAgent] = useState(false)

  // Fetch the project config to determine which agent to use
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
      : 'opencode'
  const autoOpenDevServer =
    configResult._tag === 'Success'
      ? configResult.value.devServer.autoOpen.value
      : false
  const AgentIcon = AGENT_ICONS[agentProvider]

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

  const handleSpawnTerminal = useCallback(async () => {
    if (!isServiceAvailable) {
      toast.error('Terminal service unavailable')
      return
    }
    setIsSpawning(true)
    try {
      const result = await spawnTerminal({
        payload: { workspaceId },
      })
      upsertTerminalListItem(buildOptimisticTerminalInfo(result))
      toast.success(`Terminal spawned: ${result.command}`)
      // Auto-assign the new terminal to a pane
      if (panelActions) {
        panelActions.assignTerminalToPane(result.id, workspaceId, undefined, {
          autoOpenDevServer,
        })
      }
    } catch (error) {
      toast.error(`Failed to spawn terminal: ${extractErrorMessage(error)}`)
    } finally {
      setIsSpawning(false)
    }
  }, [
    autoOpenDevServer,
    isServiceAvailable,
    spawnTerminal,
    workspaceId,
    panelActions,
  ])

  const handleSpawnAgent = useCallback(async () => {
    if (!isServiceAvailable) {
      toast.error('Terminal service unavailable')
      return
    }
    setIsSpawningAgent(true)
    try {
      const result = await spawnTerminal({
        payload: { workspaceId, command: agentProvider },
      })
      upsertTerminalListItem(buildOptimisticTerminalInfo(result))
      toast.success(`Agent spawned: ${agentProvider}`)
      if (panelActions) {
        panelActions.assignTerminalToPane(result.id, workspaceId, undefined, {
          autoOpenDevServer,
        })
      }
    } catch (error) {
      toast.error(`Failed to spawn agent: ${extractErrorMessage(error)}`)
    } finally {
      setIsSpawningAgent(false)
    }
  }, [
    isServiceAvailable,
    spawnTerminal,
    workspaceId,
    panelActions,
    agentProvider,
    autoOpenDevServer,
  ])

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
    ? `${errorMessage}. Start terminal service with turbo dev.`
    : 'Start terminal service with turbo dev.'

  const unavailableAlert = isServiceAvailable ? null : (
    <Alert className="rounded-md" variant="destructive">
      <AlertTriangle className="size-3.5" />
      <AlertTitle>Terminal service unavailable</AlertTitle>
      <AlertDescription>{unavailableMessage}</AlertDescription>
    </Alert>
  )

  if (workspaceTerminals.length === 0) {
    return (
      <div className="grid gap-2 py-1">
        {unavailableAlert}
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">No terminals</span>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={`Start ${agentProvider} agent`}
                    disabled={isSpawningAgent || !isServiceAvailable}
                    onClick={handleSpawnAgent}
                    size="xs"
                    variant="outline"
                  />
                }
              >
                <AgentIcon className="size-3" />
                {isSpawningAgent ? 'Starting...' : 'Agent'}
              </TooltipTrigger>
              <TooltipContent>
                Start {agentProvider} in a new terminal
              </TooltipContent>
            </Tooltip>
            <Button
              aria-label="New terminal"
              disabled={isSpawning || !isServiceAvailable}
              onClick={handleSpawnTerminal}
              size="xs"
              variant="outline"
            >
              <Plus className="size-3" />
              {isSpawning ? 'Spawning...' : 'New'}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-1">
      {unavailableAlert}
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-muted-foreground text-xs">
          Terminals ({workspaceTerminals.length})
        </span>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`Start ${agentProvider} agent`}
                  disabled={isSpawningAgent || !isServiceAvailable}
                  onClick={handleSpawnAgent}
                  size="xs"
                  variant="outline"
                />
              }
            >
              <AgentIcon className="size-3" />
              {isSpawningAgent ? 'Starting...' : 'Agent'}
            </TooltipTrigger>
            <TooltipContent>
              Start {agentProvider} in a new terminal
            </TooltipContent>
          </Tooltip>
          <Button
            aria-label="New terminal"
            disabled={isSpawning || !isServiceAvailable}
            onClick={handleSpawnTerminal}
            size="xs"
            variant="outline"
          >
            <Plus className="size-3" />
            {isSpawning ? 'Spawning...' : 'New'}
          </Button>
        </div>
      </div>
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
    readonly agentStatus: AgentStatus | null
    readonly foregroundProcess: ForegroundProcess | null
    readonly processChain: readonly ForegroundProcess[]
    readonly status: string
  }
}

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
  agentStatus: AgentStatus | null,
  processChain: readonly ForegroundProcess[] = []
): {
  icon: ReactNode
  label: string
  badgeLabel: string | null
  badgeClassName: string | null
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

  // Agent finished / waiting for user input — pulsing amber badge.
  // Show the root process label if available, otherwise fall back to
  // the agent command display (icon + label) or the raw command name.
  if (agentStatus === 'waiting_for_input') {
    return {
      icon: rootProcess
        ? getProcessIcon(rootProcess.category, rootProcess.rawName)
        : (agentCommandInfo?.icon ?? (
            <TerminalIcon className="size-3.5 shrink-0 text-amber-400" />
          )),
      label: rootProcess
        ? rootProcess.label
        : (agentCommandInfo?.label ?? commandLabel),
      badgeLabel: 'needs input',
      badgeClassName:
        'animate-pulse border-amber-400/30 bg-amber-400/10 text-amber-400',
    }
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
  const { icon, label, badgeLabel, badgeClassName } = getTerminalDisplay(
    terminal.command,
    terminal.foregroundProcess,
    isRunning,
    terminal.agentStatus,
    terminal.processChain
  )

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
    <button
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'cursor-grab active:cursor-grabbing'
      )}
      draggable
      onClick={() => onSelect(terminal.id)}
      onDragStart={handleDragStart}
      type="button"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      {badgeLabel !== null && badgeClassName !== null && (
        <Badge
          className={cn(
            'shrink-0 border text-[10px] leading-none',
            badgeClassName
          )}
          variant="outline"
        >
          {badgeLabel}
        </Badge>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Restart terminal"
              className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
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
              className="size-5 shrink-0 text-muted-foreground hover:text-destructive"
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
    </button>
  )
}

export { getTerminalDisplay, TerminalList }
