import { Button } from '@laborer/ui/components/button'
import { Kbd, KbdGroup } from '@laborer/ui/components/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { useWorkspaceSyncActions } from '@/hooks/use-workspace-sync-actions'
import { useWorkspaceSyncStatus } from '@/hooks/use-workspace-sync-status'

interface WorkspaceSyncStatusProps {
  readonly className?: string | undefined
  readonly size?: 'card' | 'header' | undefined
  readonly workspaceId: string
}

const getCountLabel = (count: number): string =>
  `${count} commit${count === 1 ? '' : 's'}`

/**
 * Push and pull buttons for a workspace, shown only while it is ahead of or
 * behind its upstream. The counts are read here rather than passed in: the
 * repo root and every worktree ask the same question of git, and no caller
 * has an answer to hand down.
 */
function WorkspaceSyncStatus({
  className,
  size = 'card',
  workspaceId,
}: WorkspaceSyncStatusProps) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const { pullWorkspace, pushWorkspace } = useWorkspaceSyncActions()
  const { aheadCount, behindCount } = useWorkspaceSyncStatus(workspaceId)

  const hasPush = (aheadCount ?? 0) > 0
  const hasPull = (behindCount ?? 0) > 0

  if (!(hasPush || hasPull)) {
    return null
  }

  const buttonClassName =
    size === 'header' ? 'h-6 gap-1 px-1.5 text-xs' : 'h-6 gap-1 px-1.5 text-xs'

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {hasPull ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Pull ${getCountLabel(behindCount ?? 0)}`}
                className={cn(
                  'border-sky-500/30 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300',
                  buttonClassName
                )}
                disabled={!isServerReady}
                onClick={() => pullWorkspace(workspaceId)}
                size="sm"
                title={isServerReady ? undefined : 'Connecting to server...'}
                variant="outline"
              />
            }
          >
            <ArrowDownToLine className="size-3.5" />
            {behindCount}
          </TooltipTrigger>
          <TooltipContent>
            Pull {getCountLabel(behindCount ?? 0)}
            <KbdGroup>
              <Kbd>⇧</Kbd>
              <Kbd>⌘</Kbd>
              <Kbd>P</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {hasPush ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Push ${getCountLabel(aheadCount ?? 0)}`}
                className={cn(
                  'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300',
                  buttonClassName
                )}
                disabled={!isServerReady}
                onClick={() => pushWorkspace(workspaceId)}
                size="sm"
                title={isServerReady ? undefined : 'Connecting to server...'}
                variant="outline"
              />
            }
          >
            <ArrowUpToLine className="size-3.5" />
            {aheadCount}
          </TooltipTrigger>
          <TooltipContent>
            Push {getCountLabel(aheadCount ?? 0)}
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>P</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

export { WorkspaceSyncStatus }
