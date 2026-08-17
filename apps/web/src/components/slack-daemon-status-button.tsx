import type { SlackDaemonStatus } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@laborer/ui/components/popover'
import { cn } from '@laborer/ui/lib/utils'
import { Slack } from 'lucide-react'
import { toast } from 'sonner'
import { useSlackDaemonStatus } from '@/hooks/use-slack-daemon-status'

const STATUS_LABELS: Record<SlackDaemonStatus['status'], string> = {
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
}

export function SlackDaemonStatusButton({
  onStart,
  onStop,
  starting,
  status,
  stopping,
}: {
  readonly onStart: () => void
  readonly onStop: () => void
  readonly starting: boolean
  readonly status: SlackDaemonStatus | undefined
  readonly stopping: boolean
}) {
  const checking = status === undefined
  const label = checking ? 'Checking status' : STATUS_LABELS[status.status]
  let displayedLabel = label
  if (checking) {
    displayedLabel = 'Checking status'
  }
  if (starting) {
    displayedLabel = 'Starting'
  }
  if (stopping) {
    displayedLabel = 'Stopping'
  }
  const transitioning = starting || stopping
  let statusDotClass = 'bg-muted-foreground'
  if (status?.status === 'error') {
    statusDotClass = 'bg-destructive'
  }
  if (status?.status === 'running') {
    statusDotClass = 'bg-success'
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`Slack daemon status: ${displayedLabel.toLowerCase()}`}
            data-testid="slack-daemon-status-trigger"
            size="icon"
            variant="outline"
          />
        }
      >
        <span className="relative">
          <Slack aria-hidden="true" className="h-[1.2rem] w-[1.2rem]" />
          <span
            aria-hidden="true"
            className={cn(
              'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background',
              statusDotClass
            )}
          />
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" side="top">
        <PopoverHeader>
          <PopoverTitle>Slack daemon</PopoverTitle>
          <PopoverDescription>
            Source daemon in the canonical Laborer checkout.
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex items-center gap-2 text-sm">
          <span
            aria-hidden="true"
            className={cn('size-2 rounded-full', statusDotClass)}
          />
          <output aria-live="polite" data-testid="slack-daemon-status-value">
            {displayedLabel}
          </output>
        </div>
        {status?.status === 'stopped' ? (
          <Button
            className="mt-3 w-full"
            disabled={transitioning}
            onClick={onStart}
            size="sm"
            variant="outline"
          >
            {starting ? 'Starting Slack daemon' : 'Start Slack daemon'}
          </Button>
        ) : null}
        {status?.status === 'running' ? (
          <Button
            className="mt-3 w-full"
            disabled={transitioning}
            onClick={onStop}
            size="sm"
            variant="outline"
          >
            {stopping ? 'Stopping Slack daemon' : 'Stop Slack daemon'}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

export function ConnectedSlackDaemonStatusButton() {
  const { start, starting, status, stop, stopping } = useSlackDaemonStatus()
  const handleStart = () => {
    start().catch(() => toast.error('Unable to start Slack daemon.'))
  }
  const handleStop = () => {
    stop().catch(() => toast.error('Unable to stop Slack daemon.'))
  }
  return (
    <SlackDaemonStatusButton
      onStart={handleStart}
      onStop={handleStop}
      starting={starting}
      status={status}
      stopping={stopping}
    />
  )
}
