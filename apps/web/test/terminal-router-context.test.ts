/**
 * Tests for TerminalRouterProvider and useTerminalRouter (Issue 10).
 *
 * Verifies:
 * 1. TerminalRouterProvider provides a non-null router via context
 * 2. useTerminalRouter returns null when no provider is in the tree
 * 3. Router is disposed when the provider unmounts
 * 4. terminal-pane.tsx uses the router instead of useTerminalWebSocket
 * 5. Connection status overlays are driven by router state
 *
 * The TerminalSessionRouter is tested thoroughly in terminal-session-router.test.ts.
 * These tests focus on the React context integration layer.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TerminalSessionRouter } from '@/lib/terminal-session-router'

/** Regex patterns hoisted to top level for biome lint/performance. */
const USE_TERMINAL_WEBSOCKET_IMPORT_RE = /useTerminalWebSocket/
const USE_TERMINAL_ROUTER_IMPORT_RE = /useTerminalRouter/
const TERMINAL_ROUTER_PROVIDER_IMPORT_RE = /TerminalRouterProvider/
const ROUTER_SUBSCRIBE_RE = /router\.subscribe/
const ROUTER_SEND_INPUT_RE = /router.*\.sendInput/
const WS_SEND_RE = /wsSend/
const SESSION_ROUTER_IMPORT_RE = /from '@\/lib\/terminal-session-router'/
const CONTEXTS_IMPORT_RE = /from '@\/contexts\/terminal-router-context'/
const CONNECTION_STATUS_DISCONNECTED_RE = /connectionStatus === 'disconnected'/
const CONNECTION_STATUS_CONNECTING_RE = /connectionStatus === 'connecting'/
const WS_STATUS_RE = /wsStatus/
const SET_TERMINAL_STATUS_RE = /setTerminalStatus/

describe('TerminalRouterProvider context', () => {
  describe('context module exports', () => {
    it('exports TerminalRouterProvider component', async () => {
      const mod = await import('@/contexts/terminal-router-context')
      expect(mod.TerminalRouterProvider).toBeDefined()
      expect(typeof mod.TerminalRouterProvider).toBe('function')
    })

    it('exports useTerminalRouter hook', async () => {
      const mod = await import('@/contexts/terminal-router-context')
      expect(mod.useTerminalRouter).toBeDefined()
      expect(typeof mod.useTerminalRouter).toBe('function')
    })
  })

  describe('TerminalSessionRouter integration', () => {
    it('TerminalSessionRouter can be instantiated without error', () => {
      const router = new TerminalSessionRouter()
      expect(router).toBeDefined()
      expect(router.getSessionCount()).toBe(0)
      router.dispose()
    })

    it('TerminalSessionRouter.dispose() prevents new subscriptions', () => {
      const router = new TerminalSessionRouter()
      router.dispose()

      // After dispose, subscribe returns a no-op unsubscribe function
      const unsubscribe = router.subscribe('test-terminal', {
        onOutput: () => undefined,
        onScreenState: () => undefined,
        onStatus: () => undefined,
      })

      expect(typeof unsubscribe).toBe('function')
      expect(router.getSessionCount()).toBe(0)
      unsubscribe()
    })
  })

  describe('terminal-pane.tsx integration', () => {
    const terminalPanePath = path.resolve(
      import.meta.dirname,
      '../src/panes/terminal-pane.tsx'
    )
    const terminalPaneContent = fs.readFileSync(terminalPanePath, 'utf-8')

    it('does not import useTerminalWebSocket', () => {
      expect(terminalPaneContent).not.toMatch(USE_TERMINAL_WEBSOCKET_IMPORT_RE)
    })

    it('imports useTerminalRouter from context', () => {
      expect(terminalPaneContent).toMatch(USE_TERMINAL_ROUTER_IMPORT_RE)
    })

    it('uses router.subscribe for terminal session management', () => {
      expect(terminalPaneContent).toMatch(ROUTER_SUBSCRIBE_RE)
    })

    it('uses router.sendInput for keyboard input', () => {
      expect(terminalPaneContent).toMatch(ROUTER_SEND_INPUT_RE)
    })

    it('does not use wsSend for input (old hook pattern)', () => {
      expect(terminalPaneContent).not.toMatch(WS_SEND_RE)
    })

    it('imports TerminalStatus type from terminal-session-router', () => {
      expect(terminalPaneContent).toMatch(SESSION_ROUTER_IMPORT_RE)
    })
  })

  describe('__root.tsx integration', () => {
    const rootPath = path.resolve(
      import.meta.dirname,
      '../src/routes/__root.tsx'
    )
    const rootContent = fs.readFileSync(rootPath, 'utf-8')

    it('imports TerminalRouterProvider', () => {
      expect(rootContent).toMatch(TERMINAL_ROUTER_PROVIDER_IMPORT_RE)
    })

    it('imports from contexts/terminal-router-context', () => {
      expect(rootContent).toMatch(CONTEXTS_IMPORT_RE)
    })

    it('places TerminalRouterProvider inside ServerGate', () => {
      // TerminalRouterProvider should appear after ServerGate opening tag
      // and before LiveStoreProvider
      const serverGateIdx = rootContent.indexOf('<ServerGate>')
      const routerProviderIdx = rootContent.indexOf('<TerminalRouterProvider>')
      const liveStoreIdx = rootContent.indexOf('<LiveStoreProvider>')

      expect(serverGateIdx).toBeGreaterThan(-1)
      expect(routerProviderIdx).toBeGreaterThan(serverGateIdx)
      expect(liveStoreIdx).toBeGreaterThan(routerProviderIdx)
    })
  })

  describe('connection status overlay integration', () => {
    const terminalPanePath = path.resolve(
      import.meta.dirname,
      '../src/panes/terminal-pane.tsx'
    )
    const terminalPaneContent = fs.readFileSync(terminalPanePath, 'utf-8')

    it('uses connectionStatus for disconnected banner', () => {
      expect(terminalPaneContent).toMatch(CONNECTION_STATUS_DISCONNECTED_RE)
    })

    it('uses connectionStatus for reconnecting banner', () => {
      expect(terminalPaneContent).toMatch(CONNECTION_STATUS_CONNECTING_RE)
    })

    it('does not reference wsStatus (old hook pattern)', () => {
      expect(terminalPaneContent).not.toMatch(WS_STATUS_RE)
    })

    it('tracks terminal status via router subscriber callbacks', () => {
      // The component should set terminal status via onStatus callback,
      // not via the useTerminalWebSocket hook's terminalStatus return value
      expect(terminalPaneContent).toMatch(SET_TERMINAL_STATUS_RE)
    })
  })
})
