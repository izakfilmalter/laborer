/**
 * ServerGate — blocks the main app UI until backend services are reachable.
 *
 * Two runtime strategies:
 *
 * 1. **Electron production** — subscribes to sidecar status events via
 *    the DesktopBridge. Shows per-service status and offers restart
 *    buttons when services crash.
 *
 * 2. **Dev mode (browser or Electron dev)** — polls the server health
 *    endpoint (`/server-health`, proxied by Vite) with exponential
 *    backoff until a 2xx response is received.
 *
 * In both cases the gate prevents LiveStore and route content from
 * rendering until the backend is confirmed ready, avoiding the
 * first-boot race condition where LiveStore sync would time out
 * against a not-yet-running server.
 *
 * @see apps/desktop/src/health.ts — HealthMonitor event emission
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 * @see apps/web/vite.config.ts — /server-health proxy
 */

import type { SidecarName } from '@laborer/shared/desktop-bridge'
import { Loader2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useSidecarStatuses } from '@/hooks/use-sidecar-statuses'
import { getDesktopBridge, isElectron } from '@/lib/desktop'
import {
  areCoreServicesHealthy,
  CORE_SIDECAR_NAMES,
  getDisplayName,
  getStatusColor,
  getStatusLabel,
  hasAnyCoreServiceCrashed,
} from '@/lib/sidecar-statuses'
import { cn } from '@/lib/utils'

/** Dot color classes matching the service-status-pills component. */
const DOT_CLASSES: Record<ReturnType<typeof getStatusColor>, string> = {
  green: 'bg-success',
  yellow: 'bg-warning',
  red: 'bg-destructive',
  gray: 'bg-muted-foreground',
}

// ---------------------------------------------------------------------------
// Dev mode health polling
// ---------------------------------------------------------------------------

/** Initial polling interval (ms). */
const DEV_POLL_INITIAL_MS = 300

/** Maximum polling interval (ms). */
const DEV_POLL_MAX_MS = 3000

/** Backoff multiplier. */
const DEV_POLL_BACKOFF = 1.5

/** Max consecutive failures before showing the error state. */
const DEV_POLL_ERROR_THRESHOLD = 10

type DevGateState = 'polling' | 'healthy' | 'failed'

/**
 * Hook that polls `/server-health` (Vite-proxied to the server root)
 * with exponential backoff until it receives a 2xx response.
 */
function useDevHealthPoll(): {
  state: DevGateState
  retry: () => void
} {
  const [state, setState] = useState<DevGateState>('polling')
  const failureCount = useRef(0)
  const intervalRef = useRef(DEV_POLL_INITIAL_MS)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const poll = useCallback(async () => {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 2000)
      const response = await fetch('/server-health', {
        signal: controller.signal,
        redirect: 'error',
      })
      clearTimeout(timeoutId)

      if (response.ok) {
        if (mountedRef.current) {
          setState('healthy')
        }
        return
      }
    } catch {
      // Connection refused, timeout, etc.
    }

    if (!mountedRef.current) {
      return
    }

    failureCount.current += 1

    if (failureCount.current >= DEV_POLL_ERROR_THRESHOLD) {
      setState('failed')
    }

    // Schedule next poll with backoff.
    intervalRef.current = Math.min(
      intervalRef.current * DEV_POLL_BACKOFF,
      DEV_POLL_MAX_MS
    )
    timerRef.current = setTimeout(() => {
      poll()
    }, intervalRef.current)
  }, [])

  const retry = useCallback(() => {
    // Reset state and restart polling.
    failureCount.current = 0
    intervalRef.current = DEV_POLL_INITIAL_MS
    setState('polling')
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }
    poll()
  }, [poll])

  useEffect(() => {
    mountedRef.current = true
    poll()

    return () => {
      mountedRef.current = false
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [poll])

  return { state, retry }
}

// ---------------------------------------------------------------------------
// Gate components
// ---------------------------------------------------------------------------

/**
 * Gate that blocks children until backend services are reachable.
 * Uses sidecar events in Electron production, HTTP polling in dev.
 */
function ServerGate({ children }: { readonly children: ReactNode }) {
  const bridge = getDesktopBridge()

  // Electron production: use sidecar status events from the DesktopBridge.
  if (bridge && isElectronProduction()) {
    return <ElectronServerGate bridge={bridge}>{children}</ElectronServerGate>
  }

  // Dev mode (browser or Electron dev): poll the health endpoint.
  return <DevServerGate>{children}</DevServerGate>
}

/** Check if running in Electron production (not dev). */
function isElectronProduction(): boolean {
  return isElectron() && import.meta.env.PROD
}

// ---------------------------------------------------------------------------
// Dev mode gate
// ---------------------------------------------------------------------------

function DevServerGate({ children }: { readonly children: ReactNode }) {
  const { state, retry } = useDevHealthPoll()

  if (state === 'healthy') {
    return <>{children}</>
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3">
        {state === 'polling' && (
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        )}
        <h2 className="font-medium text-lg">
          {state === 'failed' ? 'Cannot reach server' : 'Waiting for server'}
        </h2>
        <p className="max-w-sm text-center text-muted-foreground text-sm">
          {state === 'failed'
            ? 'The backend server is not responding. Make sure your dev services are running (turbo dev).'
            : 'Connecting to backend services...'}
        </p>
      </div>

      {state === 'failed' && (
        <Button onClick={retry} variant="outline">
          Retry
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Electron production gate
// ---------------------------------------------------------------------------

function ElectronServerGate({
  bridge,
  children,
}: {
  readonly bridge: NonNullable<ReturnType<typeof getDesktopBridge>>
  readonly children: ReactNode
}) {
  const statuses = useSidecarStatuses()
  const allHealthy = areCoreServicesHealthy(statuses)

  if (allHealthy) {
    return <>{children}</>
  }

  const hasCrash = hasAnyCoreServiceCrashed(statuses)

  const handleRestartAll = () => {
    for (const name of CORE_SIDECAR_NAMES) {
      if (statuses[name].state === 'crashed') {
        bridge.restartSidecar(name as SidecarName)
      }
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3">
        {!hasCrash && (
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        )}
        <h2 className="font-medium text-lg">
          {hasCrash ? 'Service startup failed' : 'Starting services'}
        </h2>
        <p className="text-muted-foreground text-sm">
          {hasCrash
            ? 'One or more services failed to start. You can retry below.'
            : 'Waiting for backend services to become ready...'}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {CORE_SIDECAR_NAMES.map((name) => {
          const state = statuses[name]
          const color = getStatusColor(state)
          const label = getStatusLabel(state)

          return (
            <div className="flex items-center gap-3 text-sm" key={name}>
              <span
                aria-hidden="true"
                className={cn(
                  'inline-block size-2 rounded-full',
                  DOT_CLASSES[color]
                )}
              />
              <span className="w-28 font-medium">{getDisplayName(name)}</span>
              <span className="text-muted-foreground">{label}</span>
            </div>
          )
        })}
      </div>

      {hasCrash && (
        <Button onClick={handleRestartAll} variant="outline">
          Restart failed services
        </Button>
      )}
    </div>
  )
}

export { ServerGate }
