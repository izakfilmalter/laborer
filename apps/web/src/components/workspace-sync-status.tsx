import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useWorkspaceSyncActions } from '@/hooks/use-workspace-sync-actions'
import { cn } from '@/lib/utils'

interface WorkspaceSyncStatusProps {
  readonly aheadCount: number | null
  readonly behindCount: number | null
  readonly className?: string | undefined
  readonly size?: 'card' | 'header' | undefined
  readonly workspaceId: string
}

const getCountLabel = (count: number): string =>
  `${count} commit${count === 1 ? '' : 's'}`

function WorkspaceSyncStatus({
  aheadCount,
  behindCount,
  className,
  size = 'card',
  workspaceId,
}: WorkspaceSyncStatusProps) {
  const { pullWorkspace, pushWorkspace } = useWorkspaceSyncActions()

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
                onClick={() => pullWorkspace(workspaceId)}
                size="sm"
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
                onClick={() => pushWorkspace(workspaceId)}
                size="sm"
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
