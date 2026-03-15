/**
 * TerminalRouterProvider — React context that provides a centralized
 * TerminalSessionRouter instance to the component tree.
 *
 * The router enforces exactly one WebSocket connection per terminal ID,
 * caches screen state for late subscribers, and manages reconnection
 * with exponential backoff. This replaces the per-component
 * `useTerminalWebSocket` hook with a shared router.
 *
 * Placement in the tree: inside `ServerGate` (terminals only exist when
 * the server is reachable). The router is created on mount and disposed
 * on unmount. When `ServerGate` remounts (e.g., after a server reconnect),
 * a fresh router is created automatically.
 *
 * @see apps/web/src/lib/terminal-session-router.ts — TerminalSessionRouter class
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react'

import { TerminalSessionRouter } from '@/lib/terminal-session-router'

/**
 * Context value is the router instance, or null if the provider is not
 * mounted (e.g., before ServerGate passes, or during hot-reload edge cases).
 * Consumers must handle null gracefully by skipping operations.
 */
const TerminalRouterContext = createContext<TerminalSessionRouter | null>(null)

/**
 * Provides a TerminalSessionRouter to the component tree.
 *
 * Creates a new router on mount and disposes it on unmount. This ensures
 * a fresh router is created whenever the ServerGate remounts after a
 * server reconnect — all stale WebSocket sessions are cleaned up and
 * new connections are established.
 */
function TerminalRouterProvider({
  children,
}: {
  readonly children: React.ReactNode
}) {
  const [router, setRouter] = useState<TerminalSessionRouter | null>(null)
  const routerRef = useRef<TerminalSessionRouter | null>(null)

  useEffect(() => {
    const newRouter = new TerminalSessionRouter()
    routerRef.current = newRouter
    setRouter(newRouter)

    return () => {
      newRouter.dispose()
      routerRef.current = null
      setRouter(null)
    }
  }, [])

  return (
    <TerminalRouterContext value={router}>{children}</TerminalRouterContext>
  )
}

/**
 * Access the TerminalSessionRouter from context.
 *
 * Returns null if:
 * - No TerminalRouterProvider is in the tree
 * - The provider is unmounting / remounting (server reconnection)
 *
 * Consumers must handle null gracefully — skip subscribe/sendInput calls
 * when the router is null. This is the expected behavior during server
 * reconnection transitions.
 */
function useTerminalRouter(): TerminalSessionRouter | null {
  return useContext(TerminalRouterContext)
}

export { TerminalRouterProvider, useTerminalRouter }
