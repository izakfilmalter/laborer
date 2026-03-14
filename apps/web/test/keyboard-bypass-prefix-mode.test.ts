/**
 * Tests for keyboard bypass and prefix mode integration with ghostty-web
 * (Issue 4).
 *
 * Verifies that:
 * 1. ghostty-web's Terminal class exposes `attachCustomKeyEventHandler`
 * 2. terminal-pane.tsx wires the handler to ghostty-web
 * 3. The bypass handler correctly intercepts Cmd+W, Cmd+Shift+Enter, Ctrl+B
 * 4. Prefix mode state machine works (enter → action key → exit, 1500ms timeout)
 * 5. Normal keys pass through to ghostty-web
 *
 * Note: WASM-dependent tests cannot run in jsdom. The keyboard handler is
 * tested as a standalone function (same logic used in terminal-pane.tsx) with
 * the source code verified to call `attachCustomKeyEventHandler`.
 *
 * @see apps/web/src/panes/terminal-pane.tsx — handler wiring
 * @see apps/web/src/panes/terminal-keys.ts — pure bypass detection functions
 * @see apps/web/test/terminal-keys.test.ts — pure function unit tests
 */

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isExactCtrlB, shouldBypassTerminal } from '../src/panes/terminal-keys'

/** Regex patterns hoisted to module level for biome lint/performance. */
const ATTACH_HANDLER_RE = /attachCustomKeyEventHandler/
const PREFIX_MODE_TIMEOUT_RE = /PREFIX_MODE_TIMEOUT\s*=\s*1500/
const ENTER_PREFIX_RE = /enterPrefixMode\(\)/
const EXIT_PREFIX_RE = /exitPrefixMode\(\)/
const KEYDOWN_CHECK_RE = /event\.type\s*!==\s*'keydown'/
const SHOULD_BYPASS_RE = /shouldBypassTerminal\(event\)/
const CTRL_B_PREFIX_RE = /isExactCtrlB\(event\)/
const PREFIX_MODE_REF_RE = /prefixModeRef\.current/
const IMPORT_TERMINAL_KEYS_RE = /from ['"]@\/panes\/terminal-keys['"]/
const SHOULD_BYPASS_WORD_RE = /shouldBypassTerminal/
const IS_EXACT_CTRL_B_WORD_RE = /isExactCtrlB/
const TERMINAL_ATTACH_CALL_RE = /terminal\.attachCustomKeyEventHandler\(/
const PREFIX_MODE_CONDITIONAL_RE = /prefixMode\s*&&/
const CTRL_B_LABEL_RE = /Ctrl\+B/

/** Helper — create a minimal KeyboardEvent-shaped object for testing. */
function makeKeyEvent(
  overrides: Partial<KeyboardEvent> & { type?: string } = {}
): KeyboardEvent {
  return {
    key: '',
    type: 'keydown',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent
}

/**
 * Simulates the prefix mode state machine as implemented in terminal-pane.tsx.
 * This mirrors the exact logic from the attachCustomKeyEventHandler callback.
 */
function createPrefixModeHandler() {
  let prefixMode = false
  let prefixTimeout: ReturnType<typeof setTimeout> | null = null
  const PREFIX_TIMEOUT_MS = 1500

  const enterPrefixMode = () => {
    prefixMode = true
    if (prefixTimeout !== null) {
      clearTimeout(prefixTimeout)
    }
    prefixTimeout = setTimeout(() => {
      prefixMode = false
      prefixTimeout = null
    }, PREFIX_TIMEOUT_MS)
  }

  const exitPrefixMode = () => {
    prefixMode = false
    if (prefixTimeout !== null) {
      clearTimeout(prefixTimeout)
      prefixTimeout = null
    }
  }

  const handler = (event: KeyboardEvent): boolean => {
    if (event.type !== 'keydown') {
      return true
    }
    if (shouldBypassTerminal(event)) {
      if (isExactCtrlB(event)) {
        enterPrefixMode()
      }
      return false
    }
    if (prefixMode) {
      exitPrefixMode()
      return false
    }
    return true
  }

  return {
    handler,
    isPrefixMode: () => prefixMode,
    cleanup: () => {
      if (prefixTimeout !== null) {
        clearTimeout(prefixTimeout)
      }
    },
  }
}

describe('keyboard bypass and prefix mode (Issue 4)', () => {
  // ---------------------------------------------------------------------------
  // ghostty-web API compatibility
  // ---------------------------------------------------------------------------
  describe('ghostty-web attachCustomKeyEventHandler API', () => {
    it('Terminal.prototype has attachCustomKeyEventHandler method', async () => {
      const ghosttyWeb = await import('ghostty-web')
      expect(
        ghosttyWeb.Terminal.prototype.attachCustomKeyEventHandler
      ).toBeDefined()
      expect(
        typeof ghosttyWeb.Terminal.prototype.attachCustomKeyEventHandler
      ).toBe('function')
    })

    it('attachCustomKeyEventHandler accepts a function argument', async () => {
      const ghosttyWeb = await import('ghostty-web')
      // Verify the method exists — full invocation requires WASM (jsdom limitation)
      const method = ghosttyWeb.Terminal.prototype.attachCustomKeyEventHandler
      expect(method.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ---------------------------------------------------------------------------
  // terminal-pane.tsx integration (source code verification)
  // ---------------------------------------------------------------------------
  describe('terminal-pane.tsx handler wiring', () => {
    const terminalPaneSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/panes/terminal-pane.tsx'),
      'utf-8'
    )

    it('imports shouldBypassTerminal and isExactCtrlB from terminal-keys', () => {
      expect(terminalPaneSrc).toMatch(IMPORT_TERMINAL_KEYS_RE)
      expect(terminalPaneSrc).toMatch(SHOULD_BYPASS_WORD_RE)
      expect(terminalPaneSrc).toMatch(IS_EXACT_CTRL_B_WORD_RE)
    })

    it('calls attachCustomKeyEventHandler on the terminal', () => {
      expect(terminalPaneSrc).toMatch(ATTACH_HANDLER_RE)
      // Verify it's called as terminal.attachCustomKeyEventHandler(...)
      expect(terminalPaneSrc).toMatch(TERMINAL_ATTACH_CALL_RE)
    })

    it('defines PREFIX_MODE_TIMEOUT as 1500ms', () => {
      expect(terminalPaneSrc).toMatch(PREFIX_MODE_TIMEOUT_RE)
    })

    it('only intercepts keydown events (passes keyup through)', () => {
      expect(terminalPaneSrc).toMatch(KEYDOWN_CHECK_RE)
    })

    it('calls shouldBypassTerminal for global shortcut detection', () => {
      expect(terminalPaneSrc).toMatch(SHOULD_BYPASS_RE)
    })

    it('checks isExactCtrlB to enter prefix mode', () => {
      expect(terminalPaneSrc).toMatch(CTRL_B_PREFIX_RE)
    })

    it('defines enterPrefixMode and exitPrefixMode functions', () => {
      expect(terminalPaneSrc).toMatch(ENTER_PREFIX_RE)
      expect(terminalPaneSrc).toMatch(EXIT_PREFIX_RE)
    })

    it('checks prefixModeRef.current for prefix mode action key', () => {
      expect(terminalPaneSrc).toMatch(PREFIX_MODE_REF_RE)
    })

    it('renders a prefix mode UI indicator when active', () => {
      // Verify the "Ctrl+B" badge is rendered conditionally
      expect(terminalPaneSrc).toMatch(PREFIX_MODE_CONDITIONAL_RE)
      expect(terminalPaneSrc).toMatch(CTRL_B_LABEL_RE)
    })
  })

  // ---------------------------------------------------------------------------
  // Bypass handler behavior (functional tests)
  // ---------------------------------------------------------------------------
  describe('bypass handler returns false for intercepted keys', () => {
    let ctx: ReturnType<typeof createPrefixModeHandler>

    beforeEach(() => {
      ctx = createPrefixModeHandler()
    })

    afterEach(() => {
      ctx.cleanup()
    })

    it('returns false for Cmd+W keydown (close pane)', () => {
      const event = makeKeyEvent({ key: 'w', metaKey: true })
      expect(ctx.handler(event)).toBe(false)
    })

    it('returns false for Cmd+Shift+Enter keydown (fullscreen toggle)', () => {
      const event = makeKeyEvent({
        key: 'Enter',
        metaKey: true,
        shiftKey: true,
      })
      expect(ctx.handler(event)).toBe(false)
    })

    it('returns false for Ctrl+B keydown (prefix mode entry)', () => {
      const event = makeKeyEvent({ key: 'b', ctrlKey: true })
      expect(ctx.handler(event)).toBe(false)
    })

    it('returns true for normal printable keys', () => {
      expect(ctx.handler(makeKeyEvent({ key: 'a' }))).toBe(true)
      expect(ctx.handler(makeKeyEvent({ key: 'z' }))).toBe(true)
      expect(ctx.handler(makeKeyEvent({ key: '1' }))).toBe(true)
      expect(ctx.handler(makeKeyEvent({ key: ' ' }))).toBe(true)
    })

    it('returns true for keyup events (never intercepts)', () => {
      const event = makeKeyEvent({ key: 'w', metaKey: true, type: 'keyup' })
      expect(ctx.handler(event)).toBe(true)
    })

    it('returns true for Ctrl+C (terminal interrupt, not bypassed)', () => {
      const event = makeKeyEvent({ key: 'c', ctrlKey: true })
      expect(ctx.handler(event)).toBe(true)
    })

    it('returns true for Ctrl+D (terminal EOF, not bypassed)', () => {
      const event = makeKeyEvent({ key: 'd', ctrlKey: true })
      expect(ctx.handler(event)).toBe(true)
    })

    it('returns true for arrow keys (terminal cursor movement)', () => {
      expect(ctx.handler(makeKeyEvent({ key: 'ArrowUp' }))).toBe(true)
      expect(ctx.handler(makeKeyEvent({ key: 'ArrowDown' }))).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Prefix mode state machine
  // ---------------------------------------------------------------------------
  describe('prefix mode state machine', () => {
    let ctx: ReturnType<typeof createPrefixModeHandler>

    beforeEach(() => {
      vi.useFakeTimers()
      ctx = createPrefixModeHandler()
    })

    afterEach(() => {
      ctx.cleanup()
      vi.useRealTimers()
    })

    it('Ctrl+B enters prefix mode', () => {
      expect(ctx.isPrefixMode()).toBe(false)
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)
    })

    it('in prefix mode, next key returns false (action key intercepted)', () => {
      // Ctrl+B: enter prefix mode
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)

      // Next key (e.g., '1' for panel 1): returns false, exits prefix mode
      const result = ctx.handler(makeKeyEvent({ key: '1' }))
      expect(result).toBe(false)
      expect(ctx.isPrefixMode()).toBe(false)
    })

    it('after action key, subsequent keys return true (normal input)', () => {
      // Ctrl+B
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      // Action key
      ctx.handler(makeKeyEvent({ key: '1' }))
      // Normal key — should return true
      expect(ctx.handler(makeKeyEvent({ key: 'a' }))).toBe(true)
      expect(ctx.handler(makeKeyEvent({ key: 'b' }))).toBe(true)
    })

    it('prefix mode auto-exits after 1500ms timeout', () => {
      // Ctrl+B: enter prefix mode
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)

      // Advance 1499ms — still in prefix mode
      vi.advanceTimersByTime(1499)
      expect(ctx.isPrefixMode()).toBe(true)

      // Advance 1ms more (total 1500ms) — prefix mode exits
      vi.advanceTimersByTime(1)
      expect(ctx.isPrefixMode()).toBe(false)
    })

    it('after timeout, keys return true (normal input)', () => {
      // Ctrl+B
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      // Wait for timeout
      vi.advanceTimersByTime(1500)
      // Normal key — should return true (prefix mode expired)
      expect(ctx.handler(makeKeyEvent({ key: '1' }))).toBe(true)
    })

    it('pressing Ctrl+B again resets the timeout', () => {
      // First Ctrl+B
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)

      // Wait 1000ms
      vi.advanceTimersByTime(1000)
      expect(ctx.isPrefixMode()).toBe(true)

      // Second Ctrl+B resets the timeout
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)

      // Wait 1000ms more (total 2000ms from first, but only 1000ms from second)
      vi.advanceTimersByTime(1000)
      expect(ctx.isPrefixMode()).toBe(true)

      // Wait 500ms more (total 1500ms from second Ctrl+B) — should exit
      vi.advanceTimersByTime(500)
      expect(ctx.isPrefixMode()).toBe(false)
    })

    it('Cmd+W does not enter prefix mode', () => {
      ctx.handler(makeKeyEvent({ key: 'w', metaKey: true }))
      expect(ctx.isPrefixMode()).toBe(false)
    })

    it('Cmd+Shift+Enter does not enter prefix mode', () => {
      ctx.handler(makeKeyEvent({ key: 'Enter', metaKey: true, shiftKey: true }))
      expect(ctx.isPrefixMode()).toBe(false)
    })

    it('prefix mode does not intercept keyup events', () => {
      // Enter prefix mode
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)

      // keyup events pass through even in prefix mode
      const result = ctx.handler(makeKeyEvent({ key: '1', type: 'keyup' }))
      expect(result).toBe(true)
      // Prefix mode still active (keyup didn't consume the action)
      expect(ctx.isPrefixMode()).toBe(true)
    })

    it('multiple Ctrl+B → action sequences work correctly', () => {
      // First sequence: Ctrl+B → 1
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)
      ctx.handler(makeKeyEvent({ key: '1' }))
      expect(ctx.isPrefixMode()).toBe(false)

      // Normal input works between sequences
      expect(ctx.handler(makeKeyEvent({ key: 'a' }))).toBe(true)

      // Second sequence: Ctrl+B → 2
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)
      ctx.handler(makeKeyEvent({ key: '2' }))
      expect(ctx.isPrefixMode()).toBe(false)
    })
  })
})
