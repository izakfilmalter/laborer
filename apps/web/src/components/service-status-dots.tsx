/**
 * ServiceStatusDots — renders Badge-based status indicators in the header,
 * one per core service (Server, Terminal, File Watcher), each showing the
 * service name and a colored dot indicating the live status.
 *
 * Badges are always visible — no collapse behavior. Each badge shows its
 * service name with a colored status dot that reflects the current state.
 *
 * Error states persist until the user explicitly dismisses them or clicks
 * retry. Even after a service recovers, the error indicator remains visible
 * until dismissed so the user doesn't miss failures.
 *
 * State transitions use CSS transitions for smooth color/opacity changes.
 * A minimum 300ms display duration prevents flickering on fast transitions.
 *
 * Consumes `useServiceStatus()` for reactive per-service health states.
 *
 * @see apps/web/src/hooks/use-service-status.ts — per-service status hook
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 * @see Issue #8: Header per-service status dots
 * @see Issue #10: Header error state persistence and animations
 */

import type { SidecarName } from '@laborer/shared/desktop-bridge'
import type { TerminalHostStatus } from '@laborer/shared/rpc'
import { AlertTriangle, CircleArrowUp, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { type ServiceName, useServiceStatus } from '@/hooks/use-service-status'
import { useTerminalHostStatus } from '@/hooks/use-terminal-host-status'
import { localApi } from '@/lib/local-api'
import {
  getStatusColor,
  getStatusLabel,
  type ServiceState,
  type StatusColor,
} from '@/lib/sidecar-statuses'
import { cn } from '@/lib/utils'

/** Core services shown as status badges (excludes sync). */
const STATUS_DOT_SERVICES: readonly ServiceName[] = [
  'server',
  'terminal',
  'file-watcher',
] as const

/** Human-readable display names for service status badges. */
const DOT_DISPLAY_NAMES: Record<ServiceName, string> = {
  server: 'Server',
  terminal: 'Terminal',
  'file-watcher': 'File Watcher',
  sync: 'Connection',
}

/** Map semantic colors to Tailwind utility classes for the status dot. */
const DOT_COLOR_CLASSES: Record<StatusColor, string> = {
  green: 'bg-success',
  yellow: 'bg-warning',
  red: 'bg-destructive',
  gray: 'bg-muted-foreground',
}

/** Map semantic colors to Badge variants. */
const BADGE_VARIANT_MAP: Record<
  StatusColor,
  'default' | 'destructive' | 'outline' | 'secondary'
> = {
  green: 'secondary',
  yellow: 'outline',
  red: 'destructive',
  gray: 'outline',
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

/** Shared badge+dot+tooltip rendering used by both service and sync indicators. */
function StatusBadgeCore({
  color,
  displayName,
  label,
  onActivate,
  pulsing,
  state,
  testId,
  variant,
}: {
  readonly color: StatusColor
  readonly displayName: string
  readonly label: string
  /**
   * When provided, the badge renders as a button and clicking it invokes
   * this callback. Used for the unresponsive → manual restart affordance
   * (ADR 0003), mirroring VS Code's pty host status bar entry.
   */
  readonly onActivate?: (() => void) | undefined
  readonly pulsing: boolean
  readonly state?: ServiceState['state']
  readonly testId?: string
  readonly variant: 'default' | 'destructive' | 'outline' | 'secondary'
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            className={cn(
              onActivate ? 'cursor-pointer' : 'cursor-default',
              'gap-1.5 transition-colors duration-300',
              color === 'green' && 'border-success/40 text-success',
              color === 'yellow' && 'border-warning/40 text-warning',
              color === 'red' && 'border-destructive text-destructive',
              color === 'gray' && 'border-border text-muted-foreground'
            )}
            data-state={state}
            data-testid={testId}
            render={
              onActivate ? (
                <button onClick={onActivate} type="button" />
              ) : undefined
            }
            variant={variant}
          />
        }
      >
        <span aria-hidden="true" className="relative inline-flex size-2">
          {pulsing && (
            <span
              className={cn(
                'absolute inline-flex size-full animate-ping rounded-full opacity-75',
                DOT_COLOR_CLASSES[color]
              )}
            />
          )}
          <span
            className={cn(
              'relative inline-flex size-2 rounded-full transition-colors duration-300',
              DOT_COLOR_CLASSES[color]
            )}
          />
        </span>
        {displayName}
      </TooltipTrigger>
      <TooltipContent>
        {displayName} — {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** A single service status badge showing the name and a colored status dot. */
function ServiceStatusBadge({
  name,
  serviceState,
  errorPersisted,
  onDismissError,
  onRetryError,
}: {
  readonly name: ServiceName
  readonly serviceState: ServiceState
  readonly errorPersisted: boolean
  readonly onDismissError: () => void
  readonly onRetryError: () => void
}) {
  const displayState = useMinDisplayDuration(serviceState)
  const color = getStatusColor(displayState)
  const displayName = DOT_DISPLAY_NAMES[name]
  const label = getStatusLabel(displayState)
  const pulsing = shouldPulse(displayState)
  const variant = BADGE_VARIANT_MAP[color]
  // Unresponsive is advisory (ADR 0003): offer click-to-restart, the same
  // path as the crash retry action.
  const onActivate =
    displayState.state === 'unresponsive' ? onRetryError : undefined

  return (
    <span
      className="inline-flex items-center gap-0.5"
      data-display-state={displayState.state}
      data-error-persisted={errorPersisted ? 'true' : undefined}
      data-state={serviceState.state}
      data-testid={`service-dot-${name}`}
    >
      <StatusBadgeCore
        color={color}
        displayName={displayName}
        label={label}
        onActivate={onActivate}
        pulsing={pulsing}
        variant={variant}
      />
      {errorPersisted && (
        <span className="inline-flex gap-0.5">
          <button
            className="rounded px-0.5 text-muted-foreground text-xs hover:text-foreground"
            data-testid={`dismiss-error-${name}`}
            onClick={onDismissError}
            type="button"
          >
            <X className="size-3" />
          </button>
          <button
            className="rounded px-0.5 text-muted-foreground text-xs hover:text-foreground"
            data-testid={`retry-error-${name}`}
            onClick={onRetryError}
            type="button"
          >
            <RotateCcw className="size-3" />
          </button>
        </span>
      )}
    </span>
  )
}

/**
 * Map ServiceName to SidecarName for restart calls.
 * Only sidecar services can be restarted (not sync).
 */
function toSidecarName(name: ServiceName): SidecarName | undefined {
  if (name === 'sync') {
    return undefined
  }
  return name
}

/** Server connection badge — always visible in the former sync-status slot. */
function SyncIndicator({ syncState }: { readonly syncState: ServiceState }) {
  const color = getStatusColor(syncState)
  const label = getStatusLabel(syncState)
  const pulsing = shouldPulse(syncState)
  const variant = BADGE_VARIANT_MAP[color]

  return (
    <StatusBadgeCore
      color={color}
      displayName="Connection"
      label={label}
      pulsing={pulsing}
      state={syncState.state}
      testId="sync-indicator"
      variant={variant}
    />
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
 * Terminal host health, shown above the service badges because it can make
 * every terminal unusable while the rest of the app stays healthy. Healthy
 * hosts render nothing: this row exists only when there is something to know
 * or something to do.
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
  const versions = describeHostVersions(status)
  const detail =
    versions === undefined
      ? presentation.detail
      : `${versions} ${presentation.detail}`
  const restarting = status.state === 'restarting'

  return (
    <span
      aria-live="polite"
      className={cn(
        'flex basis-full items-center gap-2 rounded-lg border px-2 py-1 text-xs transition-colors duration-300',
        HOST_TONE_CLASSES[presentation.tone]
      )}
      data-state={status.state}
      data-testid="terminal-host-status"
      data-tone={presentation.tone}
    >
      <Tooltip>
        <TooltipTrigger
          render={<span className="flex min-w-0 flex-1 items-center gap-2" />}
        >
          <HostStateIcon state={status.state} />
          <span className="min-w-0 truncate font-medium">
            {presentation.label}
          </span>
          {/* The tooltip is pointer-only, so the same detail is carried in the
              live region for assistive technology. */}
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

/** Row of status badges for core services — always visible. */
function ServiceStatusDots() {
  const statuses = useServiceStatus()
  const host = useTerminalHostStatus()
  const { persistedErrors, dismissError } = usePersistedErrors(statuses)

  const handleRetry = useCallback(
    (name: ServiceName) => {
      const bridge = localApi.desktopBridge
      const sidecarName = toSidecarName(name)
      if (bridge && sidecarName) {
        bridge.restartSidecar(sidecarName)
      }
      // Clear the persisted error on retry
      dismissError(name)
    },
    [dismissError]
  )

  return (
    <output
      aria-label="Service statuses"
      className="flex flex-wrap items-center gap-1 transition-all duration-300"
    >
      <TerminalHostStatusPill
        onRestart={() => {
          host.restart().catch((error: unknown) => {
            console.error('Failed to restart terminal host', error)
          })
        }}
        status={host.status}
      />
      {STATUS_DOT_SERVICES.map((name) => (
        <ServiceStatusBadge
          errorPersisted={persistedErrors.has(name)}
          key={name}
          name={name}
          onDismissError={() => dismissError(name)}
          onRetryError={() => handleRetry(name)}
          serviceState={statuses[name]}
        />
      ))}
      <SyncIndicator syncState={statuses.sync} />
    </output>
  )
}

export {
  MIN_DISPLAY_DURATION_MS,
  ServiceStatusDots,
  STATUS_DOT_SERVICES,
  TerminalHostStatusPill,
}
