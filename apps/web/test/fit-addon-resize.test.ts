/**
 * Tests for Issue 2: ghostty-web FitAddon and basic resize.
 *
 * Verifies that:
 * 1. FitAddon can be instantiated and has the expected API (fit, proposeDimensions)
 * 2. FitAddon can be loaded into a Terminal via loadAddon()
 * 3. terminal-pane.tsx correctly integrates FitAddon with ResizeObserver
 * 4. Resize flow sends dimensions to the backend via RPC after fit
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
const RESIZE_DEBOUNCE_RE = /RESIZE_DEBOUNCE_MS/
const RESIZE_RPC_RE = /resizeTerminalRef\.current\(/
const COLS_ROWS_CHECK_RE = /cols > 0 && rows > 0/
const FIT_ADDON_REF_RE = /fitAddonRef\.current = fitAddon/
const DEBOUNCE_CONST_RE = /const RESIZE_DEBOUNCE_MS\s*=\s*(\d+)/
const HANDLE_RESIZE_FIT_RE = /const handleResize[\s\S]*?fitAddon\.fit\(\)/
const HANDLE_RESIZE_RPC_RE =
  /const handleResize[\s\S]*?resizeTerminalRef\.current\(/
const OBSERVER_DISCONNECT_RE = /resizeObserver\.disconnect\(\)/
const CLEAR_RESIZE_TIMER_RE = /clearTimeout\(resizeTimer\)/

const terminalPanePath = path.resolve(
  import.meta.dirname,
  '../src/panes/terminal-pane.tsx'
)
const terminalPaneContent = fs.readFileSync(terminalPanePath, 'utf-8')

describe('Issue 2: ghostty-web FitAddon and basic resize', () => {
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

    it('validates cols/rows are positive before sending resize RPC', () => {
      expect(terminalPaneContent).toMatch(COLS_ROWS_CHECK_RE)
    })

    it('sends resize RPC with terminal dimensions after fit', () => {
      expect(terminalPaneContent).toMatch(RESIZE_RPC_RE)
    })
  })

  describe('terminal-pane.tsx ResizeObserver integration', () => {
    it('creates a ResizeObserver for container size changes', () => {
      expect(terminalPaneContent).toMatch(RESIZE_OBSERVER_RE)
    })

    it('uses RESIZE_DEBOUNCE_MS constant for debounce delay', () => {
      expect(terminalPaneContent).toMatch(RESIZE_DEBOUNCE_RE)
    })

    it('defines RESIZE_DEBOUNCE_MS as 100ms', () => {
      const debounceMatch = terminalPaneContent.match(DEBOUNCE_CONST_RE)
      expect(debounceMatch).not.toBeNull()
      expect(Number(debounceMatch?.[1])).toBe(100)
    })

    it('re-fits the terminal on resize observer callback', () => {
      const handleResizeMatch = terminalPaneContent.match(HANDLE_RESIZE_FIT_RE)
      expect(handleResizeMatch).not.toBeNull()
    })

    it('sends updated dimensions to backend after re-fit', () => {
      const handleResizeMatch = terminalPaneContent.match(HANDLE_RESIZE_RPC_RE)
      expect(handleResizeMatch).not.toBeNull()
    })

    it('disconnects ResizeObserver on cleanup', () => {
      expect(terminalPaneContent).toMatch(OBSERVER_DISCONNECT_RE)
    })

    it('clears resize timer on cleanup', () => {
      expect(terminalPaneContent).toMatch(CLEAR_RESIZE_TIMER_RE)
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
