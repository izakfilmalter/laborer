/**
 * ServerGate — blocks the main app UI until backend services are reachable.
 *
 * Two runtime strategies:
 *
 * 1. **Electron production** — subscribes to sidecar status events via
 *    the DesktopBridge. Shows per-service status and offers restart
 *    buttons when services crash.
 *
 * 2. **Browser** — polls the daemon's same-origin `/health` endpoint with
 *    exponential backoff until a 2xx response is received.
 *
 * In both cases the gate prevents route content from
 * rendering until the backend is confirmed ready, avoiding the
 * first-boot race condition where server requests would time out
 * against a not-yet-running server.
 *
 * @see apps/desktop/src/health.ts — HealthMonitor event emission
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 * @see apps/web/vite.config.ts — /health proxy
 */

import type { SidecarName } from '@laborer/shared/desktop-bridge'
import { Loader2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

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
// Browser health polling
// ---------------------------------------------------------------------------

/** Initial polling interval (ms). */
const BROWSER_POLL_INITIAL_MS = 300

/** Maximum polling interval (ms). */
const BROWSER_POLL_MAX_MS = 3000

/** Backoff multiplier. */
const BROWSER_POLL_BACKOFF = 1.5

type BrowserGateState = 'polling' | 'healthy'

/**
 * Hook that polls `/health` (Vite-proxied to the daemon)
 * with exponential backoff until it receives a 2xx response.
 */
function useBrowserHealthPoll(): {
  state: BrowserGateState
} {
  const [state, setState] = useState<BrowserGateState>('polling')

  useEffect(() => {
    let cancelled = false
    let interval = BROWSER_POLL_INITIAL_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let requestController: AbortController | undefined

    const poll = async () => {
      const controller = new AbortController()
      requestController = controller
      const timeout = setTimeout(() => controller.abort(), 2000)
      let healthy = false

      try {
        const response = await fetch('/health', {
          signal: controller.signal,
          redirect: 'error',
        })
        healthy = response.ok
      } catch {
        // Connection refused, timeout, etc.
      } finally {
        clearTimeout(timeout)
        if (requestController === controller) {
          requestController = undefined
        }
      }

      if (cancelled) {
        return
      }
      if (healthy) {
        setState('healthy')
        return
      }

      interval = Math.min(interval * BROWSER_POLL_BACKOFF, BROWSER_POLL_MAX_MS)
      timer = setTimeout(() => {
        poll()
      }, interval)
    }

    poll()

    return () => {
      cancelled = true
      requestController?.abort()
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [])

  return { state }
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

  // Electron dev still uses the utility-process path and has no daemon yet.
  if (bridge) {
    return <>{children}</>
  }

  // Plain browser: wait for the standalone daemon.
  return <BrowserServerGate>{children}</BrowserServerGate>
}

/** Check if running in Electron production (not dev). */
function isElectronProduction(): boolean {
  return isElectron() && import.meta.env.PROD
}

// ---------------------------------------------------------------------------
// Browser gate
// ---------------------------------------------------------------------------

function BrowserServerGate({ children }: { readonly children: ReactNode }) {
  const { state } = useBrowserHealthPoll()

  if (state === 'healthy') {
    return <>{children}</>
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <h2 className="font-medium text-lg">Starting daemon</h2>
        <p className="max-w-sm text-center text-muted-foreground text-sm">
          Connecting to backend services...
        </p>
      </div>
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
