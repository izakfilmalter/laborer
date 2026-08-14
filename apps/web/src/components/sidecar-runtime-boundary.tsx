import type { ReactNode } from 'react'

/**
 * Compatibility wrapper retained until the MessagePort delete stream removes
 * its call sites. Daemon reconnect generation is owned by the RPC supervisor.
 */
export function SidecarRuntimeBoundary({
  children,
}: {
  readonly children: (generation: number) => ReactNode
}) {
  return <>{children(0)}</>
}
