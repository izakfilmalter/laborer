/**
 * ServiceStatusDots — renders compact status dots in the header,
 * one per core service (Server, Terminal, File Watcher), each showing
 * a colored dot indicating the live status of that service.
 *
 * When all core services are healthy for 2 seconds, the individual dots
 * collapse to a single compact green dot. Clicking the collapsed dot opens
 * a popover with per-service detail and restart actions.
 *
 * If a service goes unhealthy while collapsed, the dots expand immediately.
 * On fast startups (all healthy within 500ms of mount), the expanded dots
 * are never shown — the user goes straight to the compact indicator.
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
 * @see Issue #9: Header status collapse and expand
 * @see Issue #10: Header error state persistence and animations
 */

import type { SidecarName } from '@laborer/shared/desktop-bridge'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
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

/** Core services shown as status dots (excludes MCP and sync). */
const STATUS_DOT_SERVICES: readonly ServiceName[] = [
  'server',
  'terminal',
  'file-watcher',
] as const

/** Human-readable display names for service status dots. */
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

/** Delay (ms) before collapsing to compact indicator after all services healthy. */
const COLLAPSE_DELAY_MS = 2000

/** Minimum display duration (ms) for a state before transitioning. Prevents flickering. */
const MIN_DISPLAY_DURATION_MS = 300

/** Whether a service state should pulse the indicator dot. */
function shouldPulse(state: ServiceState): boolean {
  return state.state === 'starting' || state.state === 'restarting'
}

/** Check if all core services are currently healthy. */
function areAllCoreHealthy(
  statuses: Record<ServiceName, ServiceState>
): boolean {
  return STATUS_DOT_SERVICES.every((name) => statuses[name].state === 'healthy')
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
 * services transition rapidly (e.g., starting → healthy in < 100ms).
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

/** A single compact status dot with a tooltip showing service name and state. */
function ServiceDot({
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
  const effectiveState = errorPersisted ? displayState : displayState
  const color = errorPersisted
    ? getStatusColor(displayState)
    : getStatusColor(displayState)
  const displayName = DOT_DISPLAY_NAMES[name]
  const label = getStatusLabel(effectiveState)
  const pulsing = shouldPulse(effectiveState)

  return (
    <span
      className="inline-flex w-4 items-center justify-center"
      data-display-state={displayState.state}
      data-error-persisted={errorPersisted ? 'true' : undefined}
      data-state={serviceState.state}
      data-testid={`service-dot-${name}`}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex items-center justify-center p-1" />
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

/** A single row in the expanded popover showing service detail and restart action. */
function ServiceDetailRow({
  name,
  serviceState,
}: {
  readonly name: ServiceName
  readonly serviceState: ServiceState
}) {
  const color = getStatusColor(serviceState)
  const displayName = DOT_DISPLAY_NAMES[name]
  const label = getStatusLabel(serviceState)
  const bridge = getDesktopBridge()

  const handleRestart = useCallback(() => {
    const sidecarName = toSidecarName(name)
    if (bridge && sidecarName) {
      bridge.restartSidecar(sidecarName)
    }
  }, [bridge, name])

  const canRestart = bridge !== undefined && toSidecarName(name) !== undefined

  return (
    <div
      className="flex items-center justify-between gap-2 py-1"
      data-testid={`service-detail-${name}`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex size-2 rounded-full transition-colors duration-300',
            DOT_COLOR_CLASSES[color]
          )}
        />
        <span className="font-medium text-sm">{displayName}</span>
        <span className="text-muted-foreground text-xs">{label}</span>
      </div>
      {canRestart && (
        <button
          className="rounded px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
          data-testid={`restart-${name}`}
          onClick={handleRestart}
          type="button"
        >
          Restart
        </button>
      )}
    </div>
  )
}

/**
 * Compact collapsed indicator — a single green dot that opens a popover
 * with per-service detail and restart actions on click.
 */
function CollapsedIndicator({
  statuses,
}: {
  readonly statuses: Record<ServiceName, ServiceState>
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  className="inline-flex items-center justify-center p-1"
                  data-testid="service-status-collapsed"
                  type="button"
                />
              }
            />
          }
        >
          <span aria-hidden="true" className="relative inline-flex size-2">
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
        </TooltipTrigger>
        <TooltipContent>All services healthy</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        data-testid="service-status-popover"
        side="bottom"
        sideOffset={8}
      >
        <div className="flex flex-col gap-0.5">
          <span className="mb-1 font-medium text-xs">Service Status</span>
          {STATUS_DOT_SERVICES.map((name) => (
            <ServiceDetailRow
              key={name}
              name={name}
              serviceState={statuses[name]}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Hook that manages the collapsed/expanded state for service status dots.
 *
 * Collapse happens 2 seconds after all core services become healthy.
 * Immediate expansion if any service goes unhealthy while collapsed.
 * On fast startups (all healthy within 500ms of mount), skips the expanded state.
 */
function useCollapseState(
  statuses: Record<ServiceName, ServiceState>
): boolean {
  const [collapsed, setCollapsed] = useState(false)
  const allHealthy = areAllCoreHealthy(statuses)
  const mountTimeRef = useRef(Date.now())
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  useEffect(() => {
    if (allHealthy) {
      // Fast startup: if all healthy within 500ms of mount, collapse immediately
      const elapsed = Date.now() - mountTimeRef.current
      if (elapsed < 500) {
        setCollapsed(true)
        return
      }

      // Normal startup: collapse after 2s delay
      collapseTimerRef.current = setTimeout(() => {
        setCollapsed(true)
      }, COLLAPSE_DELAY_MS)

      return () => {
        if (collapseTimerRef.current !== undefined) {
          clearTimeout(collapseTimerRef.current)
          collapseTimerRef.current = undefined
        }
      }
    }

    // Not all healthy: expand immediately, cancel any pending collapse
    if (collapseTimerRef.current !== undefined) {
      clearTimeout(collapseTimerRef.current)
      collapseTimerRef.current = undefined
    }
    setCollapsed(false)
    return undefined
  }, [allHealthy])

  return collapsed
}

/**
 * Whether the sync indicator should be visible.
 * Only shows when sync is actively connecting/catching up (not healthy, not unknown).
 */
function isSyncActive(state: ServiceState): boolean {
  return state.state !== 'healthy' && state.state !== 'unknown'
}

/**
 * Subtle sync indicator — a small pulsing dot that appears only when
 * LiveStore sync is actively connecting or catching up. Hidden when
 * sync is idle/connected or when no sync backend is configured.
 *
 * Visually distinct from the core service dots — uses a smaller size
 * and different color to avoid confusion.
 */
function SyncIndicator({ syncState }: { readonly syncState: ServiceState }) {
  if (!isSyncActive(syncState)) {
    return null
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex w-4 items-center justify-center p-1"
            data-testid="sync-indicator"
          />
        }
      >
        <span aria-hidden="true" className="relative inline-flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-info" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Syncing...</TooltipContent>
    </Tooltip>
  )
}

/** Compact row of status dots for core services, with collapse/expand behavior. */
function ServiceStatusDots() {
  const statuses = useServiceStatus()
  const collapsed = useCollapseState(statuses)
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

  if (collapsed) {
    return (
      <output
        aria-label="Service statuses"
        className="flex items-center gap-0.5 transition-all duration-300"
      >
        <CollapsedIndicator statuses={statuses} />
        <SyncIndicator syncState={statuses.sync} />
      </output>
    )
  }

  return (
    <output
      aria-label="Service statuses"
      className="flex items-center gap-0.5 transition-all duration-300"
    >
      {STATUS_DOT_SERVICES.map((name) => (
        <ServiceDot
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
  COLLAPSE_DELAY_MS,
  MIN_DISPLAY_DURATION_MS,
  ServiceStatusDots,
  STATUS_DOT_SERVICES,
  useCollapseState,
}
