import type {
  SidecarName,
  SidecarStatusEvent,
} from '@laborer/shared/desktop-bridge'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { resetTerminalListStore } from '@/hooks/use-terminal-list'
import { getDesktopBridge, isElectron } from '@/lib/desktop'

const RESETTABLE_SIDECARS: readonly SidecarName[] = ['server', 'terminal']

const isResettableSidecar = (name: SidecarName): boolean =>
  RESETTABLE_SIDECARS.includes(name)

/**
 * Recreates the renderer-side client/runtime layer after a core sidecar has
 * gone unhealthy and later recovered. This mirrors VS Code's approach of
 * rebuilding the owning service after process restart instead of keeping a
 * stale client bound to a dead MessagePort.
 */
export function SidecarRuntimeBoundary({
  children,
}: {
  readonly children: (generation: number) => ReactNode
}) {
  const [generation, setGeneration] = useState(0)
  const lastStatesRef = useRef(
    new Map<SidecarName, SidecarStatusEvent['state']>()
  )
  const pendingRecoveryRef = useRef(new Set<SidecarName>())

  useEffect(() => {
    if (!(isElectron() && import.meta.env.PROD)) {
      return
    }

    const bridge = getDesktopBridge()
    if (!bridge) {
      return
    }

    const handleStatus = (status: SidecarStatusEvent) => {
      if (!isResettableSidecar(status.name)) {
        lastStatesRef.current.set(status.name, status.state)
        return
      }

      const previousState = lastStatesRef.current.get(status.name)
      lastStatesRef.current.set(status.name, status.state)

      if (previousState === 'healthy' && status.state !== 'healthy') {
        pendingRecoveryRef.current.add(status.name)
        return
      }

      if (
        status.state === 'healthy' &&
        pendingRecoveryRef.current.delete(status.name)
      ) {
        resetTerminalListStore()
        setGeneration((current) => current + 1)
      }
    }

    bridge.getSidecarStatuses().then((statuses) => {
      for (const status of statuses) {
        lastStatesRef.current.set(status.name, status.state)
      }
    })

    return bridge.onSidecarStatus(handleStatus)
  }, [])

  return <>{children(generation)}</>
}
