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
const PROPOSE_DIMENSIONS_RE = /fitAddon\.proposeDimensions\(\)/
const TERMINAL_RESIZE_RE = /terminal\.resize\(cols, rows\)/
const RESIZE_IN_FLIGHT_RE = /state\.inFlight/
const PENDING_RESIZE_RE = /state\.pending/
const REQUEST_ANIMATION_FRAME_RE = /requestAnimationFrame/
const CANCEL_ANIMATION_FRAME_RE = /cancelAnimationFrame/
const EXECUTE_PTY_FIRST_RESIZE_RE = /executePtyFirstResize/
const AWAIT_RESIZE_RE = /await resizeFn\(/
const PROPOSE_BEFORE_RPC_RE =
  /proposeDimensions\(\)[\s\S]*?await resizeFn\([\s\S]*?terminal\.resize\(/
const COLS_ROWS_CHECK_INITIAL_RE = /cols > 0 && rows > 0/
const COLS_ROWS_CHECK_RESIZE_RE = /proposed\.cols <= 0 \|\| proposed\.rows <= 0/
const MODE_PROMISE_RE =
  /useAtomSet\(terminalResizeMutation,\s*\{\s*mode:\s*'promise'/
const FINALLY_PENDING_RE =
  /\.finally\(\(\) => \{[\s\S]*?state\.inFlight = false[\s\S]*?state\.pending/
const LAST_COLS_RE = /state\.lastCols/
const LAST_ROWS_RE = /state\.lastRows/
const CATCH_RESET_LAST_RE =
  /catch \{[\s\S]*?state\.lastCols = 0[\s\S]*?state\.lastRows = 0/
const CLEANUP_CANCEL_RAF_RE =
  /disposed\.current = true[\s\S]*?cancelAnimationFrame/

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

    it('validates cols/rows in PTY-first resize handler', () => {
      expect(terminalPaneContent).toMatch(COLS_ROWS_CHECK_RESIZE_RE)
    })

    it('sends resize RPC with terminal dimensions', () => {
      expect(terminalPaneContent).toMatch(RESIZE_RPC_RE)
    })
  })

  describe('terminal-pane.tsx PTY-first resize flow', () => {
    it('uses proposeDimensions() to calculate dimensions without applying', () => {
      expect(terminalPaneContent).toMatch(PROPOSE_DIMENSIONS_RE)
    })

    it('uses executePtyFirstResize helper function', () => {
      expect(terminalPaneContent).toMatch(EXECUTE_PTY_FIRST_RESIZE_RE)
    })

    it('awaits the resize RPC before applying frontend resize', () => {
      expect(terminalPaneContent).toMatch(AWAIT_RESIZE_RE)
    })

    it('calls terminal.resize(cols, rows) after backend confirmation', () => {
      expect(terminalPaneContent).toMatch(TERMINAL_RESIZE_RE)
    })

    it('follows the correct order: proposeDimensions → RPC → terminal.resize', () => {
      expect(terminalPaneContent).toMatch(PROPOSE_BEFORE_RPC_RE)
    })

    it('uses mode promise on the resize mutation for awaitable RPC', () => {
      expect(terminalPaneContent).toMatch(MODE_PROMISE_RE)
    })
  })

  describe('terminal-pane.tsx resize coalescing', () => {
    it('tracks in-flight resize state', () => {
      expect(terminalPaneContent).toMatch(RESIZE_IN_FLIGHT_RE)
    })

    it('tracks pending resize requests', () => {
      expect(terminalPaneContent).toMatch(PENDING_RESIZE_RE)
    })

    it('uses requestAnimationFrame for RAF batching', () => {
      expect(terminalPaneContent).toMatch(REQUEST_ANIMATION_FRAME_RE)
    })

    it('cancels pending RAF on new resize', () => {
      expect(terminalPaneContent).toMatch(CANCEL_ANIMATION_FRAME_RE)
    })

    it('processes pending resize after in-flight completes', () => {
      // After the doResize().finally(), if pending is true, handleResize is called again
      expect(terminalPaneContent).toMatch(FINALLY_PENDING_RE)
    })

    it('deduplicates same dimensions via lastCols/lastRows', () => {
      expect(terminalPaneContent).toMatch(LAST_COLS_RE)
      expect(terminalPaneContent).toMatch(LAST_ROWS_RE)
    })

    it('resets lastCols/lastRows on resize failure for retry', () => {
      expect(terminalPaneContent).toMatch(CATCH_RESET_LAST_RE)
    })
  })

  describe('terminal-pane.tsx ResizeObserver integration', () => {
    it('creates a ResizeObserver for container size changes', () => {
      expect(terminalPaneContent).toMatch(RESIZE_OBSERVER_RE)
    })

    it('disconnects ResizeObserver on cleanup', () => {
      expect(terminalPaneContent).toMatch(OBSERVER_DISCONNECT_RE)
    })

    it('cancels pending RAF on cleanup', () => {
      // cleanup function calls cancelAnimationFrame
      expect(terminalPaneContent).toMatch(CLEANUP_CANCEL_RAF_RE)
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
