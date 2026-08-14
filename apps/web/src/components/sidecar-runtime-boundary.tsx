import type {
  SidecarName,
  SidecarStatusEvent,
} from '@laborer/shared/desktop-bridge'
import { RPC_PORT_DEAD_EVENT } from '@laborer/shared/rpc-transport-messageport-client'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { resetTerminalListStore } from '@/hooks/use-terminal-list'
import { localApi } from '@/lib/local-api'

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
    if (!localApi.isDesktop) {
      return
    }

    const bridge = localApi.desktopBridge
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

      console.log(
        `[sidecar-boundary] ${status.name}: ${String(previousState)} → ${status.state}`
      )

      // `unresponsive` is advisory (ADR 0003): the process is alive, its
      // MessagePorts are intact, and it self-heals on the next heartbeat.
      // It must never mark the service for recovery — bumping the
      // generation when it heals would needlessly wipe terminal state.
      if (status.state === 'unresponsive') {
        return
      }

      // The service was up (healthy or merely unresponsive) and is now
      // actually down (crashed / restarting / starting). Mark it so the
      // next `healthy` bumps the generation and acquires fresh ports.
      const wasUp =
        previousState === 'healthy' || previousState === 'unresponsive'
      if (wasUp && status.state !== 'healthy') {
        console.log(
          `[sidecar-boundary] ${status.name} went unhealthy — marking for recovery`
        )
        pendingRecoveryRef.current.add(status.name)
        return
      }

      if (
        status.state === 'healthy' &&
        pendingRecoveryRef.current.delete(status.name)
      ) {
        console.log(
          `[sidecar-boundary] ${status.name} recovered — bumping generation`
        )
        resetTerminalListStore()
        setGeneration((current) => current + 1)
      }
    }

    // Listen for transport-level port death events. When a MessagePort
    // heartbeat times out or the port closes unexpectedly, the client
    // transport dispatches this DOM event. The main process sidecar
    // health monitor may not detect this (it tracks process health, not
    // individual port health), so we need to mark the server as needing
    // recovery here. This ensures that when the sidecar next reports
    // healthy, the generation bumps and fresh ports are acquired.
    const handlePortDead = () => {
      pendingRecoveryRef.current.add('server')

      if (lastStatesRef.current.get('server') === 'healthy') {
        console.warn(
          '[sidecar-boundary] RPC port dead event received while server is healthy — bumping generation immediately'
        )
        resetTerminalListStore()
        setGeneration((current) => current + 1)
        return
      }

      console.warn(
        '[sidecar-boundary] RPC port dead event received — marking server for recovery'
      )
    }
    window.addEventListener(RPC_PORT_DEAD_EVENT, handlePortDead)

    bridge.getSidecarStatuses().then((statuses) => {
      for (const status of statuses) {
        lastStatesRef.current.set(status.name, status.state)
      }
    })

    const unsubscribeSidecar = bridge.onSidecarStatus(handleStatus)
    return () => {
      unsubscribeSidecar()
      window.removeEventListener(RPC_PORT_DEAD_EVENT, handlePortDead)
    }
  }, [])

  return <>{children(generation)}</>
}
