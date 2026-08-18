/**
 * ServiceStatusDots — one unified status readout for every core service.
 *
 * The whole system reads as a single line: a fixed cluster of four dots
 * (Server, Terminal, File Watcher, Connection, always in that order) and one
 * line of copy describing the most notable state. Position in the cluster
 * identifies the service, so a glance is enough to tell which subsystem is off
 * before any text is read.
 *
 * Hovering the line reveals the per-service breakdown. It is a readout, not a
 * control: nothing here is clickable, so it carries no button or dropdown
 * affordance. The hover card is decoration over the same facts a screen
 * reader already gets from the always-mounted list, so the card is hidden
 * from assistive technology rather than duplicated into it.
 *
 * Anything the user must act on is escalated out of the hover card and onto
 * its own always-visible row, because an action you can only reach by keeping
 * a pointer still is not an action. Error states persist until the user
 * explicitly dismisses them or clicks retry, so a crash is never missed.
 *
 * State transitions use CSS transitions for smooth color changes, and a
 * minimum 300ms display duration prevents flickering on fast transitions.
 *
 * Consumes `useServiceStatus()` for reactive per-service health states.
 *
 * @see apps/web/src/hooks/use-service-status.ts — per-service status hook
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 * @see Issue #8: Header per-service status dots
 * @see Issue #10: Header error state persistence and animations
 */

import type { TerminalHostStatus } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@laborer/ui/components/hover-card'
import { Spinner } from '@laborer/ui/components/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { AlertTriangle, CircleArrowUp, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type ServiceName, useServiceStatus } from '@/hooks/use-service-status'
import { useTerminalHostStatus } from '@/hooks/use-terminal-host-status'
import {
  getStatusColor,
  getStatusLabel,
  type ServiceState,
  type StatusColor,
} from '@/lib/sidecar-statuses'

/** Supervised sidecars that can crash and be retried (excludes sync). */
const STATUS_DOT_SERVICES: readonly ServiceName[] = [
  'server',
  'terminal',
  'file-watcher',
] as const

/**
 * Every service in the unified cluster, in fixed reading order. The order is
 * load-bearing: the dot in slot three is always File Watcher.
 */
const UNIFIED_SERVICES: readonly ServiceName[] = [
  ...STATUS_DOT_SERVICES,
  'sync',
] as const

/** Human-readable display names for service status rows. */
const DOT_DISPLAY_NAMES: Record<ServiceName, string> = {
  server: 'Server',
  terminal: 'Terminal',
  'file-watcher': 'File Watcher',
  sync: 'Connection',
}

/** One-word state used in the collapsed summary line. */
const SUMMARY_STATE_WORDS: Record<ServiceState['state'], string> = {
  unknown: 'not reporting',
  starting: 'starting',
  healthy: 'running',
  reconnecting: 'reconnecting',
  down: 'down',
  unresponsive: 'unresponsive',
  crashed: 'crashed',
  restarting: 'restarting',
}

/** Map semantic colors to Tailwind utility classes for the status dot. */
const DOT_COLOR_CLASSES: Record<StatusColor, string> = {
  green: 'bg-success',
  yellow: 'bg-warning',
  red: 'bg-destructive',
  gray: 'bg-muted-foreground',
}

/** Text color for the summary line, tuned so a healthy system stays quiet. */
const SUMMARY_TEXT_CLASSES: Record<StatusColor, string> = {
  green: 'text-muted-foreground',
  yellow: 'text-warning',
  red: 'text-destructive',
  gray: 'text-muted-foreground',
}

/** Severity ordering used to pick which service the summary speaks for. */
const COLOR_SEVERITY: Record<StatusColor, number> = {
  green: 0,
  gray: 1,
  yellow: 2,
  red: 3,
}

/** Minimum display duration (ms) for a state before transitioning. Prevents flickering. */
const MIN_DISPLAY_DURATION_MS = 300

/** Whether a service state should pulse the indicator dot. */
function shouldPulse(state: ServiceState): boolean {
  return (
    state.state === 'starting' ||
    state.state === 'restarting' ||
    state.state === 'reconnecting'
  )
}

/**
 * Hook that tracks persisted error states for services.
 *
 * When a service enters the 'crashed' state, it gets added to a persisted
 * error set. The error persists even after the service recovers, until the
 * user explicitly dismisses it or retries. This ensures users don't miss
 * important failures.
 *
 * After dismissal, the same crash won't re-trigger persistence — the service
 * must go healthy first, then crash again for a new persisted error.
 */
function usePersistedErrors(statuses: Record<ServiceName, ServiceState>) {
  const [persistedErrors, setPersistedErrors] = useState<Set<ServiceName>>(
    () => new Set()
  )
  // Track dismissed services to avoid re-persisting the same crash
  const dismissedRef = useRef<Set<ServiceName>>(new Set<ServiceName>())

  // Watch for new crash events and add them to persisted errors
  useEffect(() => {
    for (const name of STATUS_DOT_SERVICES) {
      // When a service recovers to healthy, clear the dismissed flag
      // so future crashes will be persisted again
      if (
        statuses[name].state === 'healthy' &&
        dismissedRef.current.has(name)
      ) {
        dismissedRef.current.delete(name)
      }
    }

    setPersistedErrors((prev) => {
      let next: Set<ServiceName> | undefined
      for (const name of STATUS_DOT_SERVICES) {
        if (
          statuses[name].state === 'crashed' &&
          !prev.has(name) &&
          !dismissedRef.current.has(name)
        ) {
          next ??= new Set(prev)
          next.add(name)
        }
      }
      return next ?? prev
    })
  }, [statuses])

  const dismissError = useCallback((name: ServiceName) => {
    dismissedRef.current.add(name)
    setPersistedErrors((prev) => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
  }, [])

  return { persistedErrors, dismissError }
}

/**
 * Hook that implements minimum display duration for a service state.
 *
 * Holds the displayed state for at least MIN_DISPLAY_DURATION_MS before
 * allowing a transition to a new state. This prevents flickering when
 * services transition rapidly (e.g., starting -> healthy in < 100ms).
 *
 * Returns the "display state" — the state that should be rendered.
 */
function useMinDisplayDuration(liveState: ServiceState): ServiceState {
  const [displayState, setDisplayState] = useState<ServiceState>(liveState)
  const lastChangeRef = useRef(Date.now())
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  useEffect(() => {
    // If the live state matches display state, nothing to do
    if (liveState.state === displayState.state) {
      return
    }

    const elapsed = Date.now() - lastChangeRef.current

    if (elapsed >= MIN_DISPLAY_DURATION_MS) {
      // Enough time has passed, transition immediately
      setDisplayState(liveState)
      lastChangeRef.current = Date.now()
      return
    }

    // Not enough time passed — schedule the transition
    const remaining = MIN_DISPLAY_DURATION_MS - elapsed
    pendingTimerRef.current = setTimeout(() => {
      setDisplayState(liveState)
      lastChangeRef.current = Date.now()
      pendingTimerRef.current = undefined
    }, remaining)

    return () => {
      if (pendingTimerRef.current !== undefined) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = undefined
      }
    }
  }, [liveState, displayState.state])

  return displayState
}

/** The single dot shared by the cluster and the per-service rows. */
function StatusDot({
  color,
  pulsing,
  size = 'sm',
}: {
  readonly color: StatusColor
  readonly pulsing: boolean
  readonly size?: 'sm' | 'xs'
}) {
  const sizeClass = size === 'xs' ? 'size-1.5' : 'size-2'
  return (
    <span
      aria-hidden="true"
      className={cn('relative inline-flex shrink-0', sizeClass)}
    >
      {pulsing && (
        <span
          className={cn(
            'absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none',
            DOT_COLOR_CLASSES[color]
          )}
        />
      )}
      <span
        className={cn(
          'relative inline-flex rounded-full transition-colors duration-300',
          sizeClass,
          DOT_COLOR_CLASSES[color]
        )}
      />
    </span>
  )
}

/** Summary copy and tone derived from every service at once. */
interface UnifiedSummary {
  readonly color: StatusColor
  readonly text: string
}

/**
 * Pick the one thing worth saying about the whole system.
 *
 * A single affected service is named outright, because naming it saves the
 * user from expanding the list. Several at once collapse to a count, because
 * a list of names in one line stops being scannable.
 */
function summarizeStatuses(
  displayStates: Record<ServiceName, ServiceState>,
  persistedErrors: ReadonlySet<ServiceName>
): UnifiedSummary {
  const affected = UNIFIED_SERVICES.filter(
    (name) => getStatusColor(displayStates[name]) !== 'green'
  ).sort(
    (a, b) =>
      COLOR_SEVERITY[getStatusColor(displayStates[b])] -
      COLOR_SEVERITY[getStatusColor(displayStates[a])]
  )

  const worst = affected[0]
  if (worst !== undefined) {
    const color = getStatusColor(displayStates[worst])
    if (affected.length === 1) {
      return {
        color,
        text: `${DOT_DISPLAY_NAMES[worst]} ${SUMMARY_STATE_WORDS[displayStates[worst].state]}`,
      }
    }
    return { color, text: `${affected.length} services need attention` }
  }

  // Everything is healthy now, but a past crash is still unacknowledged.
  const [firstError] = [...persistedErrors]
  if (firstError !== undefined) {
    return {
      color: 'red',
      text:
        persistedErrors.size === 1
          ? `${DOT_DISPLAY_NAMES[firstError]} crashed earlier`
          : `${persistedErrors.size} services crashed earlier`,
    }
  }

  return { color: 'green', text: 'All services running' }
}

/**
 * The per-service facts, always in the DOM.
 *
 * This list is the accessible form of the readout and the anchor for every
 * service's live state. It is visually hidden because the same information is
 * shown in the hover card, which assistive technology never reaches.
 */
function ServiceStatusList({
  displayStates,
  persistedErrors,
  statuses,
}: {
  readonly displayStates: Record<ServiceName, ServiceState>
  readonly persistedErrors: ReadonlySet<ServiceName>
  readonly statuses: Record<ServiceName, ServiceState>
}) {
  return (
    <ul className="sr-only">
      {UNIFIED_SERVICES.map((name) => (
        <li
          data-display-state={displayStates[name].state}
          data-error-persisted={persistedErrors.has(name) ? 'true' : undefined}
          data-state={statuses[name].state}
          data-testid={`service-dot-${name}`}
          key={name}
        >
          {DOT_DISPLAY_NAMES[name]}: {getStatusLabel(displayStates[name])}
        </li>
      ))}
    </ul>
  )
}

/** One line of the hover breakdown: name on the left, state on the right. */
function ServiceHoverRow({
  displayState,
  name,
}: {
  readonly displayState: ServiceState
  readonly name: ServiceName
}) {
  const color = getStatusColor(displayState)

  return (
    <li className="flex items-center gap-2 text-xs">
      <StatusDot color={color} pulsing={shouldPulse(displayState)} size="xs" />
      <span className="shrink-0">{DOT_DISPLAY_NAMES[name]}</span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-right',
          SUMMARY_TEXT_CLASSES[color]
        )}
      >
        {getStatusLabel(displayState)}
      </span>
    </li>
  )
}

/**
 * What the error row says, which is not always the current state: a crash the
 * user never acknowledged still gets reported after the service recovers,
 * because the recovery does not explain the outage.
 */
function errorRowLabel(
  displayState: ServiceState,
  liveState: ServiceState
): string {
  if (displayState.state === 'unresponsive') {
    return 'Unresponsive'
  }
  if (liveState.state === 'healthy') {
    return 'Crashed earlier, running again'
  }
  return getStatusLabel(displayState)
}

/**
 * A failure the user still has to answer for, on its own row.
 *
 * Retry and dismiss live here rather than in the hover card so they can be
 * clicked and tabbed to like anything else in the footer.
 */
function ServiceErrorRow({
  label,
  name,
  onDismissError,
  onRetryError,
}: {
  readonly label: string
  readonly name: ServiceName
  readonly onDismissError: () => void
  readonly onRetryError: () => void
}) {
  return (
    <div
      className="flex w-full items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1 text-destructive text-xs"
      data-testid={`service-error-${name}`}
    >
      <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {DOT_DISPLAY_NAMES[name]} — {label}
      </span>
      <button
        aria-label={`Retry ${DOT_DISPLAY_NAMES[name]}`}
        className="rounded-sm p-0.5 hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        data-testid={`retry-error-${name}`}
        onClick={onRetryError}
        type="button"
      >
        <RotateCcw aria-hidden="true" className="size-3.5" />
      </button>
      <button
        aria-label={`Dismiss ${DOT_DISPLAY_NAMES[name]} error`}
        className="rounded-sm p-0.5 hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        data-testid={`dismiss-error-${name}`}
        onClick={onDismissError}
        type="button"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * Severity tone for the terminal host pill.
 *
 * The host is a supervised process, not the terminals themselves, so its
 * states carry different weight: a late heartbeat is advisory, an outdated
 * host is an expected consequence of a rebuild, and only a lost host is
 * critical. Tone drives color so the hierarchy is visible before the copy
 * is read.
 */
type HostTone = 'advisory' | 'critical' | 'busy' | 'update'

const HOST_TONE_CLASSES: Record<HostTone, string> = {
  advisory: 'border-warning/40 bg-warning/10 text-warning',
  critical: 'border-destructive/40 bg-destructive/10 text-destructive',
  busy: 'border-border bg-muted/60 text-muted-foreground',
  update: 'border-primary/40 bg-primary/10 text-primary',
}

interface HostPresentation {
  readonly actionable: boolean
  readonly detail: string
  readonly label: string
  readonly tone: HostTone
}

/**
 * Copy is deliberately reassuring about what did *not* happen: nothing is
 * killed automatically (ADR 0003), so every restart is the operator's call.
 */
const HOST_PRESENTATION: Record<
  Exclude<TerminalHostStatus['state'], 'healthy'>,
  HostPresentation
> = {
  warning: {
    actionable: false,
    detail: 'The terminal host is slow to answer. Terminals keep running.',
    label: 'Terminal host delayed',
    tone: 'advisory',
  },
  unresponsive: {
    actionable: true,
    detail:
      'The terminal host stopped answering. Nothing was killed — restart it when you are ready and history is restored.',
    label: 'Terminal host unresponsive',
    tone: 'critical',
  },
  outdated: {
    actionable: true,
    detail:
      'The running terminal host is older than this build. Restarting checkpoints your terminals, restarts the host, and restores their history.',
    label: 'Terminal host outdated',
    tone: 'update',
  },
  restarting: {
    actionable: false,
    detail: 'Checkpointing terminals, restarting the host, restoring history.',
    label: 'Restarting terminal host…',
    tone: 'busy',
  },
  unavailable: {
    actionable: true,
    detail:
      'No terminal host is running. Restart it to bring your terminals back.',
    label: 'Terminal host unavailable',
    tone: 'critical',
  },
}

/** Progress labels keep their ellipsis on screen but not when spoken. */
const TRAILING_ELLIPSIS = /…$/

/** Version context belongs in the detail, never in the one-line summary. */
function describeHostVersions(status: TerminalHostStatus): string | undefined {
  if (status.runningVersion === undefined) {
    return undefined
  }
  if (status.runningVersion === status.expectedVersion) {
    return undefined
  }
  return `Running ${status.runningVersion}, expected ${status.expectedVersion}.`
}

/** Full explanation behind the one-line label, versions first when they differ. */
function hostDetail(status: TerminalHostStatus): string {
  if (status.state === 'healthy') {
    return ''
  }
  const presentation = HOST_PRESENTATION[status.state]
  const versions = describeHostVersions(status)
  return versions === undefined
    ? presentation.detail
    : `${versions} ${presentation.detail}`
}

/**
 * Spoken form of the pill, rendered from an always-mounted live region so a
 * status change is announced rather than swallowed by the region itself
 * appearing — the same rule the connection banner follows.
 */
function describeHostStatus(status: TerminalHostStatus | undefined): string {
  if (status === undefined || status.state === 'healthy') {
    return ''
  }
  const label = HOST_PRESENTATION[status.state].label.replace(
    TRAILING_ELLIPSIS,
    ''
  )
  return `${label}. ${hostDetail(status)}`
}

/**
 * The leading glyph carries the same hierarchy as the tone: an outdated host
 * is a pending upgrade rather than a fault, so it never wears an alert
 * triangle, and an in-flight restart shows progress instead of a warning.
 */
function HostStateIcon({
  state,
}: {
  readonly state: Exclude<TerminalHostStatus['state'], 'healthy'>
}) {
  if (state === 'restarting') {
    return <Spinner aria-hidden="true" className="size-3.5 shrink-0" />
  }
  if (state === 'outdated') {
    return <CircleArrowUp aria-hidden="true" className="size-3.5 shrink-0" />
  }
  return <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
}

/**
 * Terminal host health, shown above the unified status row because it can
 * make every terminal unusable while the rest of the app stays healthy.
 * Healthy hosts render nothing: this row exists only when there is something
 * to know or something to do.
 */
function TerminalHostStatusPill({
  onRestart,
  status,
}: {
  readonly onRestart: () => void
  readonly status: TerminalHostStatus | undefined
}) {
  if (status === undefined || status.state === 'healthy') {
    return null
  }

  const presentation = HOST_PRESENTATION[status.state]
  const detail = hostDetail(status)
  const restarting = status.state === 'restarting'

  return (
    <span
      className={cn(
        'flex w-full items-center gap-2 rounded-lg border px-2 py-1 text-xs transition-colors duration-300',
        HOST_TONE_CLASSES[presentation.tone]
      )}
      data-state={status.state}
      data-testid="terminal-host-status"
      data-tone={presentation.tone}
    >
      <Tooltip>
        {/* A real button, so the explanation is reachable by keyboard and not
            only on hover; the same text is carried in the announcement
            region for assistive technology. */}
        <TooltipTrigger
          render={
            <button
              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              type="button"
            />
          }
        >
          <HostStateIcon state={status.state} />
          <span className="min-w-0 truncate font-medium">
            {presentation.label}
          </span>
          <span className="sr-only">{detail}</span>
        </TooltipTrigger>
        <TooltipContent>{detail}</TooltipContent>
      </Tooltip>
      {(presentation.actionable || restarting) && (
        <Button
          className="shrink-0"
          disabled={restarting}
          onClick={onRestart}
          size="xs"
          variant="outline"
        >
          <RotateCcw aria-hidden="true" />
          Restart terminal host
        </Button>
      )}
    </span>
  )
}

/** A single line summarizing every service, with the breakdown on hover. */
function ServiceStatusDots() {
  const statuses = useServiceStatus()
  const host = useTerminalHostStatus()
  const { persistedErrors, dismissError } = usePersistedErrors(statuses)

  // Called once per service in a fixed order, so hook order stays stable.
  const displayStates: Record<ServiceName, ServiceState> = {
    server: useMinDisplayDuration(statuses.server),
    terminal: useMinDisplayDuration(statuses.terminal),
    'file-watcher': useMinDisplayDuration(statuses['file-watcher']),
    sync: useMinDisplayDuration(statuses.sync),
  }

  const summary = summarizeStatuses(displayStates, persistedErrors)

  // A service earns its own row when there is something to do about it: an
  // unacknowledged crash, or a host that stopped answering (ADR 0003).
  const actionableServices = UNIFIED_SERVICES.filter(
    (name) =>
      persistedErrors.has(name) || displayStates[name].state === 'unresponsive'
  )

  const handleRetry = useCallback(
    (name: ServiceName) => {
      // Clear the persisted error on retry
      dismissError(name)
    },
    [dismissError]
  )

  return (
    <output
      aria-label="Service statuses"
      className="grid gap-1 transition-all duration-300"
    >
      {/* This row is already a polite live region, so the spoken host summary
          lives here rather than on the pill: a live region that mounts with
          its own content is routinely swallowed, and nesting a second one
          would announce the same change twice. */}
      <span className="sr-only">{describeHostStatus(host.status)}</span>
      <TerminalHostStatusPill
        onRestart={() => {
          host.restart().catch((error: unknown) => {
            console.error('Failed to restart terminal host', error)
          })
        }}
        status={host.status}
      />
      <HoverCard>
        <HoverCardTrigger
          render={
            <span
              aria-hidden="true"
              className="flex w-full cursor-default items-center gap-2 px-0.5 text-xs"
              data-testid="service-status-summary"
            />
          }
        >
          <span className="flex shrink-0 items-center gap-1">
            {UNIFIED_SERVICES.map((name) => (
              <StatusDot
                color={getStatusColor(displayStates[name])}
                key={name}
                pulsing={shouldPulse(displayStates[name])}
                size="xs"
              />
            ))}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-left transition-colors duration-300',
              SUMMARY_TEXT_CLASSES[summary.color]
            )}
          >
            {summary.text}
          </span>
        </HoverCardTrigger>
        <HoverCardContent align="start" className="w-56" side="top">
          <ul className="grid gap-1.5">
            {UNIFIED_SERVICES.map((name) => (
              <ServiceHoverRow
                displayState={displayStates[name]}
                key={name}
                name={name}
              />
            ))}
          </ul>
        </HoverCardContent>
      </HoverCard>
      <ServiceStatusList
        displayStates={displayStates}
        persistedErrors={persistedErrors}
        statuses={statuses}
      />
      {actionableServices.map((name) => (
        <ServiceErrorRow
          key={name}
          label={errorRowLabel(displayStates[name], statuses[name])}
          name={name}
          onDismissError={() => dismissError(name)}
          onRetryError={() => handleRetry(name)}
        />
      ))}
    </output>
  )
}

export {
  describeHostStatus,
  MIN_DISPLAY_DURATION_MS,
  ServiceStatusDots,
  STATUS_DOT_SERVICES,
  TerminalHostStatusPill,
}
