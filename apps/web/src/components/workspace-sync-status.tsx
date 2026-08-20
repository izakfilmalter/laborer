import { Button } from '@laborer/ui/components/button'
import { Kbd, KbdGroup } from '@laborer/ui/components/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react'
import { useState } from 'react'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { useWorkspaceSyncActions } from '@/hooks/use-workspace-sync-actions'
import { useWorkspaceSyncStatus } from '@/hooks/use-workspace-sync-status'

interface WorkspaceSyncStatusProps {
  readonly className?: string | undefined
  readonly workspaceId: string
}

const getCountLabel = (count: number): string =>
  `${count} commit${count === 1 ? '' : 's'}`

/**
 * One sync button for a workspace, shown only while it is ahead of or behind
 * its upstream. GitHub Desktop's toolbar is the model: a single button whose
 * action is whichever step comes first — pull when there is anything to pull,
 * push otherwise — while both counts stay visible so the button also reports
 * the state it is about to change. The counts are read here rather than
 * passed in: the repo root and every worktree ask the same question of git,
 * and no caller has an answer to hand down.
 */
function WorkspaceSyncStatus({
  className,
  workspaceId,
}: WorkspaceSyncStatusProps) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const { pullWorkspace, pushWorkspace } = useWorkspaceSyncActions()
  const { aheadCount, behindCount } = useWorkspaceSyncStatus(workspaceId)
  const [isSyncing, setIsSyncing] = useState(false)

  const ahead = aheadCount ?? 0
  const behind = behindCount ?? 0
  const hasPush = ahead > 0
  const hasPull = behind > 0

  if (!(hasPush || hasPull)) {
    return null
  }

  // Pulling first is what keeps a push fast-forwardable, so it wins the button
  // whenever there is anything to pull.
  const action = hasPull ? 'pull' : 'push'
  const actionCount = hasPull ? behind : ahead
  const actionLabel = `${action === 'pull' ? 'Pull' : 'Push'} ${getCountLabel(actionCount)}`
  const pendingLabel = action === 'pull' ? 'Pulling…' : 'Pushing…'

  // The label names the action; the secondary count is context the action does
  // not touch, so it is announced separately rather than read as another verb.
  const secondaryLabel = hasPull && hasPush ? `, ${ahead} to push` : ''

  const runSync = async () => {
    setIsSyncing(true)
    try {
      await (action === 'pull'
        ? pullWorkspace(workspaceId)
        : pushWorkspace(workspaceId))
    } finally {
      setIsSyncing(false)
    }
  }

  return (
    <div className={cn('flex items-center', className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={
                isSyncing ? pendingLabel : `${actionLabel}${secondaryLabel}`
              }
              className={cn(
                // `[&>svg]` is the loading spinner: the arrows below sit
                // inside spans, so this sizes the spinner alone.
                'h-6 gap-1.5 px-1.5 text-xs [&>svg]:size-3.5',
                action === 'pull'
                  ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300'
              )}
              disabled={!isServerReady}
              loading={isSyncing}
              onClick={runSync}
              size="xs"
              title={isServerReady ? undefined : 'Connecting to server...'}
              variant="outline"
            />
          }
        >
          {hasPull ? (
            <span className="inline-flex items-center gap-0.5">
              <ArrowDownToLine className="size-3.5" />
              {behind}
            </span>
          ) : null}
          {hasPush ? (
            <span
              className={cn(
                'inline-flex items-center gap-0.5',
                // Push is not this button's action while there is a pull
                // pending, so it reads as a count rather than a control.
                hasPull && 'opacity-60'
              )}
            >
              <ArrowUpToLine className="size-3.5" />
              {ahead}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipContent>
          {actionLabel}
          <KbdGroup>
            {action === 'pull' ? <Kbd>⇧</Kbd> : null}
            <Kbd>⌘</Kbd>
            <Kbd>P</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

export { WorkspaceSyncStatus }
