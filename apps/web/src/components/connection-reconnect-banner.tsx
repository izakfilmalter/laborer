import { useAtomSet } from '@effect/atom-react/Hooks'
import { Button } from '@laborer/ui/components/button'
import { cn } from '@laborer/ui/lib/utils'
import { RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  RENDERER_DISCONNECT_GRACE_MS,
  RENDERER_RECONNECT_DELAYS_MS,
  type RendererConnectionState,
  rendererConnectionGenerationAtom,
  rendererConnectionSupervisor,
} from '@/atoms/renderer-connection'
import { localApi } from '@/lib/local-api'

/** How long the "Reconnected" confirmation stays up after a session returns. */
const RECONNECT_RESTORED_MS = 2400

/** Cadence of the visible retry countdown. */
const COUNTDOWN_TICK_MS = 1000

/**
 * Escalation point: once the retry ladder is exhausted the daemon is very
 * likely stopped rather than restarting, so the status changes tone and tells
 * the operator what to do instead of implying it is about to come back.
 */
const UNREACHABLE_ATTEMPT = RENDERER_RECONNECT_DELAYS_MS.length

/**
 * Severity is owned by the attempt count, not the phase. An outage cycles
 * through `connecting` and `backoff` every few seconds, so a phase-driven
 * status would rewrite the headline on a timer — motion that reads as
 * instability rather than status. The phase drives only the detail line and
 * the activity affordances beneath it.
 */
type ReconnectStatus = 'lost' | 'unreachable'

const statusOf = (connection: RendererConnectionState): ReconnectStatus =>
  connection.attempt > UNREACHABLE_ATTEMPT ? 'unreachable' : 'lost'

/**
 * Stable per-status copy; the countdown is deliberately excluded. Only
 * escalation and recovery — the two changes an operator can act on — produce a
 * new announcement, so one outage is not narrated as a stream of retries.
 */
const ANNOUNCEMENTS: Record<ReconnectStatus, string> = {
  lost: 'Connection lost. Retrying automatically. Data shown may be stale.',
  unreachable:
    'Cannot reach the daemon. Start the daemon to resume. Still retrying automatically; data shown may be stale.',
}

const RESTORED_ANNOUNCEMENT = 'Reconnected to the daemon.'

const announcementFor = (
  status: ReconnectStatus,
  showBanner: boolean,
  restored: boolean
): string => {
  if (showBanner) {
    return ANNOUNCEMENTS[status]
  }
  return restored ? RESTORED_ANNOUNCEMENT : ''
}

const TITLES: Record<ReconnectStatus, string> = {
  lost: 'Connection lost',
  unreachable: 'Can’t reach the daemon',
}

const detailOf = (
  status: ReconnectStatus,
  secondsRemaining: number | null,
  inFlight: boolean
): string => {
  if (status === 'lost') {
    if (inFlight) {
      return 'Reconnecting…'
    }
    return secondsRemaining === null
      ? 'Retrying shortly'
      : `Retrying in ${secondsRemaining}s`
  }
  // Once the ladder is exhausted the operator's next step outranks the timer,
  // so it leads the line instead of trailing a countdown they cannot act on.
  if (inFlight) {
    return 'Start the daemon · retrying now'
  }
  return secondsRemaining === null
    ? 'Start the daemon · retrying shortly'
    : `Start the daemon · retrying in ${secondsRemaining}s`
}

/** Shared shell so every connection state reads as one component. */
function StatusPill({
  children,
  className,
  testId,
}: {
  readonly children: ReactNode
  readonly className?: string
  readonly testId: string
}) {
  return (
    <div
      className={cn(
        'pointer-events-auto flex max-w-full items-center gap-3 rounded-xl bg-popover/95 px-3 py-2 text-popover-foreground text-xs shadow-lg ring-1 backdrop-blur',
        'motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:animate-in motion-safe:duration-150',
        className
      )}
      data-testid={testId}
    >
      {children}
    </div>
  )
}

/** Small status dot, pulsing only while an attempt is genuinely in flight. */
function StatusDot({
  className,
  pulse,
}: {
  readonly className: string
  readonly pulse: boolean
}) {
  return (
    <span aria-hidden="true" className="relative inline-flex size-2 shrink-0">
      {pulse && (
        <span
          className={cn(
            'absolute inline-flex size-full rounded-full opacity-75 motion-safe:animate-ping',
            className
          )}
        />
      )}
      <span
        className={cn('relative inline-flex size-2 rounded-full', className)}
      />
    </span>
  )
}

/** The disconnect banner itself: status, retry countdown, manual reconnect. */
function DisconnectPill({
  inFlight,
  secondsRemaining,
  status,
}: {
  readonly inFlight: boolean
  readonly secondsRemaining: number | null
  readonly status: ReconnectStatus
}) {
  const severe = status === 'unreachable'

  return (
    <StatusPill
      className={severe ? 'ring-destructive/40' : 'ring-warning/40'}
      testId="reconnect-banner"
    >
      <StatusDot
        className={severe ? 'bg-destructive' : 'bg-warning'}
        pulse={inFlight}
      />
      <span className="grid min-w-0 gap-0.5">
        <span
          className={cn('truncate font-medium', severe && 'text-destructive')}
        >
          {TITLES[status]}
        </span>
        <span
          aria-hidden="true"
          className="truncate text-[11px] text-muted-foreground tabular-nums"
        >
          {detailOf(status, secondsRemaining, inFlight)}
        </span>
      </span>
      {/* Stays enabled while an attempt is in flight: disabling it would drop
          focus out of the banner mid-outage, and the spinning icon already
          reports that pressing again is redundant rather than broken. */}
      <Button
        className="shrink-0"
        onClick={() => rendererConnectionSupervisor.retryNow()}
        size="xs"
        type="button"
        variant="outline"
      >
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex size-3',
            inFlight && 'motion-safe:animate-spin'
          )}
        >
          <RotateCw className="size-full" />
        </span>
        Reconnect
      </Button>
    </StatusPill>
  )
}

/** Brief confirmation that the session came back, so the banner never just
 * vanishes without resolution. */
function RestoredPill() {
  return (
    <StatusPill className="ring-success/40" testId="reconnect-restored">
      <StatusDot className="bg-success" pulse={false} />
      <span className="font-medium">Reconnected</span>
    </StatusPill>
  )
}

/** Reads the retry deadline into a once-a-second countdown. */
function useRetryCountdown(retryAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (retryAt === null) {
      return
    }
    setNow(Date.now())
    const timer = window.setInterval(
      () => setNow(Date.now()),
      COUNTDOWN_TICK_MS
    )
    return () => window.clearInterval(timer)
  }, [retryAt])

  return retryAt === null
    ? null
    : Math.max(0, Math.ceil((retryAt - now) / 1000))
}

/** Keeps RPC runtime generation synchronized and presents post-grace status. */
export function ConnectionReconnectBanner() {
  const desktop = localApi.isDesktop
  const connection = useSyncExternalStore(
    rendererConnectionSupervisor.subscribe,
    rendererConnectionSupervisor.getSnapshot,
    rendererConnectionSupervisor.getSnapshot
  )
  const setGeneration = useAtomSet(rendererConnectionGenerationAtom)
  const [pastGrace, setPastGrace] = useState(false)
  const [restored, setRestored] = useState(false)
  const wasVisibleRef = useRef(false)

  useEffect(() => {
    if (desktop) {
      return
    }
    rendererConnectionSupervisor.start()
  }, [])

  useEffect(() => {
    setGeneration(connection.generation)
  }, [connection.generation, setGeneration])

  useEffect(() => {
    if (connection.phase === 'connected') {
      setPastGrace(false)
      return
    }
    const timer = window.setTimeout(() => {
      wasVisibleRef.current = true
      setPastGrace(true)
    }, RENDERER_DISCONNECT_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [connection.phase])

  // A confirmation is only worth showing when the interruption was visible;
  // a sub-grace dev restart stays completely silent.
  useEffect(() => {
    if (connection.phase !== 'connected' || !wasVisibleRef.current) {
      return
    }
    wasVisibleRef.current = false
    setRestored(true)
    const timer = window.setTimeout(
      () => setRestored(false),
      RECONNECT_RESTORED_MS
    )
    return () => window.clearTimeout(timer)
  }, [connection.phase])

  const disconnected = connection.phase !== 'connected'
  // Recovery confirmation belongs to the connected session that produced it.
  // If that session drops again before the confirmation timeout, do not keep
  // presenting or announcing a stale "Reconnected" state during the grace
  // period for the new outage.
  const showRestored = !disconnected && restored
  const status = statusOf(connection)
  const secondsRemaining = useRetryCountdown(
    disconnected && connection.phase === 'backoff' ? connection.retryAt : null
  )

  if (desktop) {
    return null
  }

  const showBanner = disconnected && pastGrace
  const announcement = announcementFor(status, showBanner, showRestored)

  return (
    <>
      {/* Always mounted so status changes are announced rather than swallowed
          by the region itself appearing. */}
      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>
      {(showBanner || showRestored) && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
          {showBanner ? (
            <DisconnectPill
              inFlight={connection.phase === 'connecting'}
              secondsRemaining={secondsRemaining}
              status={status}
            />
          ) : (
            <RestoredPill />
          )}
        </div>
      )}
    </>
  )
}
