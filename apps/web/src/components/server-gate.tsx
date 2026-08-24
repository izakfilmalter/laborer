/**
 * ServerGate — blocks the main app UI until backend services are reachable.
 *
 * Browser and Electron both poll the daemon's same-origin `/health` endpoint
 * with exponential backoff until a 2xx response is received.
 *
 * In both cases the gate prevents route content from
 * rendering until the backend is confirmed ready, avoiding the
 * first-boot race condition where server requests would time out
 * against a not-yet-running server.
 *
 * @see apps/web/vite.config.ts — /health proxy
 */

import { Loader2 } from 'lucide-react'
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { rendererConnectionSupervisor } from '@/atoms/renderer-connection'

// ---------------------------------------------------------------------------
// Browser health polling
// ---------------------------------------------------------------------------

/** Initial polling interval (ms). */
const BROWSER_POLL_INITIAL_MS = 300

/** Maximum polling interval (ms). */
const BROWSER_POLL_MAX_MS = 3000

/** Backoff multiplier. */
const BROWSER_POLL_BACKOFF = 1.5

/**
 * Consecutive failures (~12s at this backoff) after which a boot is treated as
 * a stopped daemon rather than a slow one. Polling continues either way; only
 * the copy escalates, so an operator is never left watching a spinner that
 * cannot explain itself.
 */
const BROWSER_POLL_ESCALATE_AFTER = 10

type BrowserGateState = 'polling' | 'healthy' | 'unreachable'

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
    let failures = 0
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

      failures += 1
      if (failures >= BROWSER_POLL_ESCALATE_AFTER) {
        setState('unreachable')
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
  return <BrowserServerGate>{children}</BrowserServerGate>
}

// ---------------------------------------------------------------------------
// Browser gate
// ---------------------------------------------------------------------------

function BrowserServerGate({ children }: { readonly children: ReactNode }) {
  const { state } = useBrowserHealthPoll()
  const connection = useSyncExternalStore(
    rendererConnectionSupervisor.subscribe,
    rendererConnectionSupervisor.getSnapshot,
    rendererConnectionSupervisor.getSnapshot
  )

  if (state === 'healthy' && connection.phase !== 'blocked') {
    return <>{children}</>
  }

  if (connection.phase === 'blocked') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="font-medium text-lg">Daemon restart failed</h2>
        <p className="max-w-sm text-muted-foreground text-sm">
          Laborer could not start a healthy daemon after several attempts. Quit
          and reopen the desktop app to try again.
        </p>
      </div>
    )
  }

  const unreachable = state === 'unreachable'

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      {/* Polling never stops, so the escalation only changes what the operator
          is told — it is announced rather than swapped in silently. */}
      <output
        aria-live="polite"
        className="flex flex-col items-center gap-3 text-center"
      >
        <span
          aria-hidden="true"
          className="inline-flex size-8 animate-spin text-muted-foreground motion-reduce:animate-none"
        >
          <Loader2 className="size-full" />
        </span>
        <h2 className="font-medium text-lg">
          {unreachable ? 'Can’t reach the daemon' : 'Starting daemon'}
        </h2>
        <p className="max-w-sm text-muted-foreground text-sm">
          {unreachable
            ? 'The daemon isn’t responding. Start it with “bun run dev”; mission control loads on its own once it answers.'
            : 'Connecting to backend services…'}
        </p>
      </output>
    </div>
  )
}

export { ServerGate }
