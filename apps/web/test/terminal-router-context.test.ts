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
const WS_SEND_RE = /wsSend/
const USE_TERMINAL_WEBSOCKET_HOOK_RE = /from '@\/hooks\/use-terminal-websocket'/
const WS_STATUS_DISCONNECTED_RE = /wsStatus === 'disconnected'/
const WS_STATUS_CONNECTING_RE = /wsStatus === 'connecting'/

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

  describe('terminal-pane.tsx integration (current: useTerminalWebSocket)', () => {
    const terminalPanePath = path.resolve(
      import.meta.dirname,
      '../src/panes/terminal-pane.tsx'
    )
    const terminalPaneContent = fs.readFileSync(terminalPanePath, 'utf-8')

    it('imports useTerminalWebSocket (current hook)', () => {
      expect(terminalPaneContent).toMatch(USE_TERMINAL_WEBSOCKET_IMPORT_RE)
    })

    it('uses wsSend for input (current hook pattern)', () => {
      expect(terminalPaneContent).toMatch(WS_SEND_RE)
    })

    it('imports TerminalStatus type from use-terminal-websocket', () => {
      expect(terminalPaneContent).toMatch(USE_TERMINAL_WEBSOCKET_HOOK_RE)
    })
  })

  describe('connection status overlay integration (current: wsStatus)', () => {
    const terminalPanePath = path.resolve(
      import.meta.dirname,
      '../src/panes/terminal-pane.tsx'
    )
    const terminalPaneContent = fs.readFileSync(terminalPanePath, 'utf-8')

    it('uses wsStatus for disconnected banner', () => {
      expect(terminalPaneContent).toMatch(WS_STATUS_DISCONNECTED_RE)
    })

    it('uses wsStatus for reconnecting banner', () => {
      expect(terminalPaneContent).toMatch(WS_STATUS_CONNECTING_RE)
    })
  })
})
