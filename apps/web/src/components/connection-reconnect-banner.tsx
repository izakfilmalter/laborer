import { useAtomSet } from '@effect/atom-react/Hooks'
import { RotateCw } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

import {
  RENDERER_DISCONNECT_GRACE_MS,
  rendererConnectionGenerationAtom,
  rendererConnectionSupervisor,
} from '@/atoms/renderer-connection'
import { isElectron } from '@/lib/desktop'

/** Keeps RPC runtime generation synchronized and presents post-grace status. */
export function ConnectionReconnectBanner() {
  const connection = useSyncExternalStore(
    rendererConnectionSupervisor.subscribe,
    rendererConnectionSupervisor.getSnapshot,
    rendererConnectionSupervisor.getSnapshot
  )
  const setGeneration = useAtomSet(rendererConnectionGenerationAtom)
  const [pastGrace, setPastGrace] = useState(false)

  useEffect(() => {
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
    const timer = window.setTimeout(
      () => setPastGrace(true),
      RENDERER_DISCONNECT_GRACE_MS
    )
    return () => window.clearTimeout(timer)
  }, [connection.phase])

  if (isElectron() || connection.phase === 'connected' || !pastGrace) {
    return null
  }

  return (
    <aside
      aria-live="polite"
      className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-400/25 bg-background/95 px-3 py-2 text-sm shadow-lg backdrop-blur"
      data-testid="reconnect-banner"
    >
      <span className="flex items-center gap-2 font-medium">
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-amber-400 motion-safe:animate-pulse"
        />
        Reconnecting…
      </span>
      <button
        className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => rendererConnectionSupervisor.retryNow()}
        type="button"
      >
        <RotateCw aria-hidden="true" className="size-3" />
        Reconnect
      </button>
    </aside>
  )
}
