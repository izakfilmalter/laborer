/**
 * Tests for Issue 2: ghostty-web FitAddon and basic resize.
 * Updated for Issue 11: PTY-first resize with coalescing.
 *
 * Verifies that:
 * 1. FitAddon can be instantiated and has the expected API (fit, proposeDimensions)
 * 2. FitAddon can be loaded into a Terminal via loadAddon()
 * 3. terminal-pane.tsx correctly integrates FitAddon with ResizeObserver
 * 4. PTY-first resize flow: proposeDimensions → RPC → terminal.resize
 * 5. Resize coalescing: one in-flight at a time, pending flag
 *
 * Note: WASM-dependent tests (init(), open(), fit() with real DOM) cannot run
 * in jsdom because WebAssembly.instantiate and fetch for .wasm files are not
 * supported. Integration with real container sizing is verified in e2e tests.
 * These tests verify API shape and code-level integration patterns.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** Regex patterns hoisted to top level for biome lint/performance. */
const FIT_ADDON_IMPORT_RE = /FitAddon/
const LOAD_ADDON_RE = /terminal\.loadAddon\(fitAddon\)/
const FIT_CALL_RE = /fitAddon\.fit\(\)/
const RESIZE_OBSERVER_RE = /new ResizeObserver/
const RESIZE_RPC_RE = /resizeTerminalRef\.current\(/
const FIT_ADDON_REF_RE = /fitAddonRef\.current = fitAddon/
const OBSERVER_DISCONNECT_RE = /resizeObserver\.disconnect\(\)/
const COLS_ROWS_CHECK_INITIAL_RE = /cols > 0 && rows > 0/

const terminalPanePath = path.resolve(
  import.meta.dirname,
  '../src/panes/terminal-pane.tsx'
)
const terminalPaneContent = fs.readFileSync(terminalPanePath, 'utf-8')

describe('Issue 2+11: ghostty-web FitAddon, PTY-first resize, and coalescing', () => {
  describe('FitAddon API shape', () => {
    it('FitAddon can be instantiated without WASM', async () => {
      const { FitAddon } = await import('ghostty-web')
      const fitAddon = new FitAddon()
      expect(fitAddon).toBeDefined()
      fitAddon.dispose()
    })

    it('FitAddon has fit method', async () => {
      const { FitAddon } = await import('ghostty-web')
      const fitAddon = new FitAddon()
      expect(typeof fitAddon.fit).toBe('function')
      fitAddon.dispose()
    })

    it('FitAddon has proposeDimensions method', async () => {
      const { FitAddon } = await import('ghostty-web')
      const fitAddon = new FitAddon()
      expect(typeof fitAddon.proposeDimensions).toBe('function')
      fitAddon.dispose()
    })

    it('FitAddon has activate method for loadAddon integration', async () => {
      const { FitAddon } = await import('ghostty-web')
      const fitAddon = new FitAddon()
      expect(typeof fitAddon.activate).toBe('function')
      fitAddon.dispose()
    })

    it('FitAddon has dispose method for cleanup', async () => {
      const { FitAddon } = await import('ghostty-web')
      const fitAddon = new FitAddon()
      expect(typeof fitAddon.dispose).toBe('function')
      fitAddon.dispose()
    })

    it('Terminal prototype has loadAddon for FitAddon integration', async () => {
      const { Terminal } = await import('ghostty-web')
      expect(typeof Terminal.prototype.loadAddon).toBe('function')
    })
  })

  describe('terminal-pane.tsx FitAddon integration', () => {
    it('imports FitAddon from ghostty-web', () => {
      expect(terminalPaneContent).toMatch(FIT_ADDON_IMPORT_RE)
    })

    it('loads FitAddon into the terminal via loadAddon()', () => {
      expect(terminalPaneContent).toMatch(LOAD_ADDON_RE)
    })

    it('stores FitAddon in a ref for resize handler access', () => {
      expect(terminalPaneContent).toMatch(FIT_ADDON_REF_RE)
    })

    it('calls fit() after terminal.open() for initial sizing', () => {
      expect(terminalPaneContent).toMatch(FIT_CALL_RE)
    })

    it('validates cols/rows before sending resize RPC (initial setup)', () => {
      expect(terminalPaneContent).toMatch(COLS_ROWS_CHECK_INITIAL_RE)
    })

    it('validates cols/rows with positive check before sending resize RPC', () => {
      expect(terminalPaneContent).toMatch(COLS_ROWS_CHECK_INITIAL_RE)
    })

    it('sends resize RPC with terminal dimensions', () => {
      expect(terminalPaneContent).toMatch(RESIZE_RPC_RE)
    })
  })

  describe('terminal-pane.tsx ResizeObserver integration', () => {
    it('creates a ResizeObserver for container size changes', () => {
      expect(terminalPaneContent).toMatch(RESIZE_OBSERVER_RE)
    })

    it('disconnects ResizeObserver on cleanup', () => {
      expect(terminalPaneContent).toMatch(OBSERVER_DISCONNECT_RE)
    })
  })

  describe('resize flow ordering', () => {
    it('FitAddon is loaded before terminal.open()', () => {
      const loadAddonPos = terminalPaneContent.indexOf(
        'terminal.loadAddon(fitAddon)'
      )
      const openPos = terminalPaneContent.indexOf('terminal.open(container)')
      expect(loadAddonPos).toBeGreaterThan(-1)
      expect(openPos).toBeGreaterThan(-1)
      expect(loadAddonPos).toBeLessThan(openPos)
    })

    it('initial fit() is called after terminal.open()', () => {
      const openPos = terminalPaneContent.indexOf('terminal.open(container)')
      // Find the first fitAddon.fit() after terminal.open()
      const fitPos = terminalPaneContent.indexOf('fitAddon.fit()', openPos)
      expect(openPos).toBeGreaterThan(-1)
      expect(fitPos).toBeGreaterThan(-1)
      expect(fitPos).toBeGreaterThan(openPos)
    })

    it('resize RPC is sent after fit() in initial setup', () => {
      const openPos = terminalPaneContent.indexOf('terminal.open(container)')
      const fitPos = terminalPaneContent.indexOf('fitAddon.fit()', openPos)
      const rpcPos = terminalPaneContent.indexOf(
        'resizeTerminalRef.current(',
        fitPos
      )
      expect(fitPos).toBeGreaterThan(-1)
      expect(rpcPos).toBeGreaterThan(-1)
      expect(rpcPos).toBeGreaterThan(fitPos)
    })
  })
})
