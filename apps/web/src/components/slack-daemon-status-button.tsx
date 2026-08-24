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
import type * as React from 'react'
import { toast } from 'sonner'
import { useSlackDaemonStatus } from '@/hooks/use-slack-daemon-status'

const STATUS_LABELS: Record<SlackDaemonStatus['status'], string> = {
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
}

/**
 * Tone for each state the button can show. `stopped` is deliberately a solid
 * foreground dot rather than a muted one: a stopped daemon is a fact the
 * operator has to read at a glance, not a disabled control.
 */
type StatusTone = 'running' | 'stopped' | 'error' | 'pending'

const TONE_DOT: Record<StatusTone, string> = {
  running: 'bg-success',
  stopped: 'bg-foreground',
  error: 'bg-destructive',
  pending: 'bg-warning',
}

const TONE_TEXT: Record<StatusTone, string> = {
  running: 'text-success',
  stopped: 'text-foreground',
  error: 'text-destructive',
  pending: 'text-warning',
}

/**
 * The trigger carries status as its own fill so the Slack glyph stays whole.
 * These override the `outline` variant's background, border, and hover.
 */
const TONE_TRIGGER: Record<StatusTone, string> = {
  running:
    'border-success/40 bg-success/15 text-success hover:bg-success/25 hover:text-success aria-expanded:bg-success/25 aria-expanded:text-success dark:border-success/40 dark:bg-success/15 dark:hover:bg-success/25',
  stopped:
    'border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/50',
  error:
    'border-destructive/45 bg-destructive/15 text-destructive hover:bg-destructive/25 hover:text-destructive aria-expanded:bg-destructive/25 aria-expanded:text-destructive dark:border-destructive/45 dark:bg-destructive/15 dark:hover:bg-destructive/25',
  pending:
    'border-warning/45 bg-warning/15 text-warning hover:bg-warning/25 hover:text-warning aria-expanded:bg-warning/25 aria-expanded:text-warning dark:border-warning/45 dark:bg-warning/15 dark:hover:bg-warning/25',
}

/**
 * Only unsettled states animate. A running daemon is a steady, healthy fact
 * and holds still — an endless ping on the happy path keeps the compositor
 * awake for the entire session and buys no information the solid green dot
 * does not already carry. `pending` covers checking, starting, and stopping,
 * and `error` is a state the operator still has to answer for.
 */
const PULSING_TONES: ReadonlySet<StatusTone> = new Set<StatusTone>([
  'error',
  'pending',
])

/** Whether a tone earns the pinging halo behind its dot. */
function tonePulses(tone: StatusTone): boolean {
  return PULSING_TONES.has(tone)
}

/** The dot itself, shared by the trigger badge and the popover status row. */
function StatusDot({
  className,
  tone,
}: {
  readonly className?: string
  readonly tone: StatusTone
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('relative inline-flex shrink-0', className)}
    >
      {tonePulses(tone) ? (
        <span
          className={cn(
            'absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none',
            TONE_DOT[tone]
          )}
        />
      ) : null}
      <span
        className={cn(
          'relative inline-flex size-full rounded-full transition-colors duration-300',
          TONE_DOT[tone]
        )}
      />
    </span>
  )
}

export function SlackDaemonStatusButton({
  anchor,
  onStart,
  onStop,
  starting,
  status,
  stopping,
}: {
  /**
   * Element the popover measures and aligns against. Pass the surrounding nav
   * row so the popover spans it instead of overflowing the sidebar.
   */
  readonly anchor?: React.RefObject<HTMLElement | null> | undefined
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
  let tone: StatusTone = 'pending'
  if (status?.status === 'error') {
    tone = 'error'
  }
  if (status?.status === 'running') {
    tone = 'running'
  }
  if (status?.status === 'stopped') {
    tone = 'stopped'
  }
  if (transitioning) {
    tone = 'pending'
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`Slack daemon status: ${displayedLabel.toLowerCase()}`}
            className={cn('transition-colors duration-300', TONE_TRIGGER[tone])}
            data-testid="slack-daemon-status-trigger"
            size="icon"
            variant="outline"
          />
        }
      >
        {/*
         * Every shape in the Lucide Slack glyph is closed, so filling the root
         * svg turns the outline mark solid. Running is the only state that
         * earns the filled mark.
         */}
        <Slack
          aria-hidden="true"
          className="h-[1.2rem] w-[1.2rem]"
          fill={tone === 'running' ? 'currentColor' : 'none'}
        />
      </PopoverTrigger>
      <PopoverContent
        align="center"
        anchor={anchor}
        className={anchor ? 'w-(--anchor-width)' : undefined}
        side="top"
        sideOffset={10}
      >
        <PopoverHeader>
          <PopoverTitle>Slack daemon</PopoverTitle>
          <PopoverDescription>
            Source daemon in the canonical Laborer checkout.
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-sm">
          <StatusDot className="size-2" tone={tone} />
          <output
            aria-live="polite"
            className={cn('font-medium', TONE_TEXT[tone])}
            data-testid="slack-daemon-status-value"
          >
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

export { tonePulses }
export type { StatusTone }

export function ConnectedSlackDaemonStatusButton({
  anchor,
}: {
  readonly anchor?: React.RefObject<HTMLElement | null> | undefined
}) {
  const { start, starting, status, stop, stopping } = useSlackDaemonStatus()
  const handleStart = () => {
    start().catch(() => toast.error('Unable to start Slack daemon.'))
  }
  const handleStop = () => {
    stop().catch(() => toast.error('Unable to stop Slack daemon.'))
  }
  return (
    <SlackDaemonStatusButton
      anchor={anchor}
      onStart={handleStart}
      onStop={handleStop}
      starting={starting}
      status={status}
      stopping={stopping}
    />
  )
}
