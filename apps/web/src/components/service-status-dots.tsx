/**
 * ServiceStatusBadges — renders Badge-based status indicators in the header,
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
 * MCP is excluded from primary indicators (it's not a core service).
 *
 * @see apps/web/src/hooks/use-service-status.ts — per-service status hook
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 * @see Issue #8: Header per-service status dots
 * @see Issue #10: Header error state persistence and animations
 */

import type { SidecarName } from '@laborer/shared/desktop-bridge'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { type ServiceName, useServiceStatus } from '@/hooks/use-service-status'
import { getDesktopBridge } from '@/lib/desktop'
import {
  getStatusColor,
  getStatusLabel,
  type ServiceState,
  type StatusColor,
} from '@/lib/sidecar-statuses'
import { cn } from '@/lib/utils'

/** Core services shown as status badges (excludes MCP and sync). */
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
  mcp: 'MCP',
  sync: 'Sync',
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
  return state.state === 'starting' || state.state === 'restarting'
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
    const newErrors = new Set(persistedErrors)
    let changed = false
    for (const name of STATUS_DOT_SERVICES) {
      const state = statuses[name].state
      if (
        state === 'crashed' &&
        !newErrors.has(name) &&
        !dismissedRef.current.has(name)
      ) {
        newErrors.add(name)
        changed = true
      }
      // When a service recovers to healthy, clear the dismissed flag
      // so future crashes will be persisted again
      if (state === 'healthy' && dismissedRef.current.has(name)) {
        dismissedRef.current.delete(name)
      }
    }
    if (changed) {
      setPersistedErrors(newErrors)
    }
  }, [statuses, persistedErrors])

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

  return (
    <span
      className="inline-flex items-center gap-0.5"
      data-display-state={displayState.state}
      data-error-persisted={errorPersisted ? 'true' : undefined}
      data-state={serviceState.state}
      data-testid={`service-dot-${name}`}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              className={cn(
                'gap-1.5 transition-colors duration-300',
                color === 'green' && 'border-success/40 text-success',
                color === 'yellow' && 'border-warning/40 text-warning',
                color === 'red' && 'border-destructive text-destructive',
                color === 'gray' && 'border-border text-muted-foreground'
              )}
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
      {errorPersisted && (
        <span className="inline-flex gap-0.5">
          <button
            className="rounded px-0.5 text-muted-foreground text-xs hover:text-foreground"
            data-testid={`dismiss-error-${name}`}
            onClick={onDismissError}
            type="button"
          >
            ✕
          </button>
          <button
            className="rounded px-0.5 text-muted-foreground text-xs hover:text-foreground"
            data-testid={`retry-error-${name}`}
            onClick={onRetryError}
            type="button"
          >
            ↻
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

/** Sync status badge — always visible, shows current sync state. */
function SyncIndicator({ syncState }: { readonly syncState: ServiceState }) {
  const color = getStatusColor(syncState)
  const label = getStatusLabel(syncState)
  const pulsing = shouldPulse(syncState)
  const variant = BADGE_VARIANT_MAP[color]

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            className={cn(
              'gap-1.5 transition-colors duration-300',
              color === 'green' && 'border-success/40 text-success',
              color === 'yellow' && 'border-warning/40 text-warning',
              color === 'red' && 'border-destructive text-destructive',
              color === 'gray' && 'border-border text-muted-foreground'
            )}
            data-testid="sync-indicator"
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
        Sync
      </TooltipTrigger>
      <TooltipContent>Sync — {label}</TooltipContent>
    </Tooltip>
  )
}

/** Row of status badges for core services — always visible. */
function ServiceStatusDots() {
  const statuses = useServiceStatus()
  const { persistedErrors, dismissError } = usePersistedErrors(statuses)

  const handleRetry = useCallback(
    (name: ServiceName) => {
      const bridge = getDesktopBridge()
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
      className="flex items-center gap-1 transition-all duration-300"
    >
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

export { MIN_DISPLAY_DURATION_MS, ServiceStatusDots, STATUS_DOT_SERVICES }
