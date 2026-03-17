/**
 * Tests for keyboard bypass and prefix mode integration with xterm.js.
 *
 * Verifies that:
 * 1. terminal-pane.tsx wires `attachCustomKeyEventHandler` to xterm.js
 * 2. The bypass handler correctly intercepts Cmd+W, Cmd+Shift+Enter, Ctrl+B
 * 3. Prefix mode state machine works (enter -> action key -> exit, 1500ms timeout)
 * 4. Normal keys pass through to xterm.js
 *
 * xterm.js convention:
 * - Return `true` -> xterm.js handles the key (normal terminal input)
 * - Return `false` -> xterm.js ignores the key (it bubbles to document)
 *
 * @see apps/web/src/panes/terminal-pane.tsx — handler wiring
 * @see apps/web/src/lib/keybinds.ts — centralized keybind definitions
 * @see apps/web/test/terminal-keys.test.ts — keybind matching unit tests
 */

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPrefixKey, shouldBypassTerminal } from '../src/lib/keybinds'

/** Regex patterns hoisted to module level for biome lint/performance. */
const ATTACH_HANDLER_RE = /attachCustomKeyEventHandler/
const PREFIX_MODE_TIMEOUT_RE = /PREFIX_MODE_TIMEOUT\s*=\s*1500/
const ENTER_PREFIX_RE = /enterPrefixMode\(\)/
const EXIT_PREFIX_RE = /exitPrefixMode\(\)/
const KEYDOWN_CHECK_RE = /event\.type\s*!==\s*'keydown'/
const SHOULD_BYPASS_RE = /shouldBypassTerminal\(event\)/
const PREFIX_KEY_RE = /isPrefixKey\(event\)/
const PREFIX_MODE_REF_RE = /prefixModeRef\.current/
const IMPORT_KEYBINDS_RE = /from ['"]@\/lib\/keybinds['"]/
const SHOULD_BYPASS_WORD_RE = /shouldBypassTerminal/
const IS_PREFIX_KEY_WORD_RE = /isPrefixKey/
const TERMINAL_ATTACH_CALL_RE = /terminal\.attachCustomKeyEventHandler\(/
const PREFIX_MODE_CONDITIONAL_RE = /prefixMode\s*&&/
const CTRL_B_LABEL_RE = /Ctrl\+B/

/** Helper — create a minimal KeyboardEvent-shaped object for testing. */
function makeKeyEvent(
  overrides: Partial<KeyboardEvent> & { type?: string } = {}
): KeyboardEvent {
  return {
    key: '',
    code: '',
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
 *
 * xterm.js convention:
 * - Return `true` -> xterm.js handles the key (normal terminal input)
 * - Return `false` -> xterm.js ignores the key (it bubbles to document)
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
      if (isPrefixKey(event)) {
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

describe('keyboard bypass and prefix mode', () => {
  // ---------------------------------------------------------------------------
  // terminal-pane.tsx integration (source code verification)
  // ---------------------------------------------------------------------------
  describe('terminal-pane.tsx handler wiring', () => {
    const terminalPaneSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/panes/terminal-pane.tsx'),
      'utf-8'
    )

    it('imports shouldBypassTerminal and isPrefixKey from keybinds', () => {
      expect(terminalPaneSrc).toMatch(IMPORT_KEYBINDS_RE)
      expect(terminalPaneSrc).toMatch(SHOULD_BYPASS_WORD_RE)
      expect(terminalPaneSrc).toMatch(IS_PREFIX_KEY_WORD_RE)
    })

    it('calls attachCustomKeyEventHandler on the terminal', () => {
      expect(terminalPaneSrc).toMatch(ATTACH_HANDLER_RE)
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

    it('checks isPrefixKey to enter prefix mode', () => {
      expect(terminalPaneSrc).toMatch(PREFIX_KEY_RE)
    })

    it('defines enterPrefixMode and exitPrefixMode functions', () => {
      expect(terminalPaneSrc).toMatch(ENTER_PREFIX_RE)
      expect(terminalPaneSrc).toMatch(EXIT_PREFIX_RE)
    })

    it('checks prefixModeRef.current for prefix mode action key', () => {
      expect(terminalPaneSrc).toMatch(PREFIX_MODE_REF_RE)
    })

    it('renders a prefix mode UI indicator when active', () => {
      expect(terminalPaneSrc).toMatch(PREFIX_MODE_CONDITIONAL_RE)
      expect(terminalPaneSrc).toMatch(CTRL_B_LABEL_RE)
    })
  })

  // ---------------------------------------------------------------------------
  // Bypass handler behavior (functional tests)
  // ---------------------------------------------------------------------------
  describe('bypass handler returns false (bypass) for intercepted keys', () => {
    let ctx: ReturnType<typeof createPrefixModeHandler>

    beforeEach(() => {
      ctx = createPrefixModeHandler()
    })

    afterEach(() => {
      ctx.cleanup()
    })

    it('returns false for Cmd+W keydown (bypass — bubbles to close pane)', () => {
      const event = makeKeyEvent({ key: 'w', metaKey: true })
      expect(ctx.handler(event)).toBe(false)
    })

    it('returns false for Cmd+Shift+Enter keydown (bypass — bubbles to fullscreen toggle)', () => {
      const event = makeKeyEvent({
        key: 'Enter',
        metaKey: true,
        shiftKey: true,
      })
      expect(ctx.handler(event)).toBe(false)
    })

    it('returns false for Ctrl+B keydown (bypass — enters prefix mode)', () => {
      const event = makeKeyEvent({ key: 'b', ctrlKey: true })
      expect(ctx.handler(event)).toBe(false)
    })

    it('returns true for normal printable keys (handled — terminal input)', () => {
      expect(ctx.handler(makeKeyEvent({ key: 'a' }))).toBe(true)
      expect(ctx.handler(makeKeyEvent({ key: 'z' }))).toBe(true)
      expect(ctx.handler(makeKeyEvent({ key: '1' }))).toBe(true)
      expect(ctx.handler(makeKeyEvent({ key: ' ' }))).toBe(true)
    })

    it('returns true for keyup events (handled — xterm.js processes)', () => {
      const event = makeKeyEvent({ key: 'w', metaKey: true, type: 'keyup' })
      expect(ctx.handler(event)).toBe(true)
    })

    it('returns true for Ctrl+C (handled — terminal interrupt)', () => {
      const event = makeKeyEvent({ key: 'c', ctrlKey: true })
      expect(ctx.handler(event)).toBe(true)
    })

    it('returns true for Ctrl+D (handled — terminal EOF)', () => {
      const event = makeKeyEvent({ key: 'd', ctrlKey: true })
      expect(ctx.handler(event)).toBe(true)
    })

    it('returns true for arrow keys (handled — terminal cursor movement)', () => {
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

    it('in prefix mode, next key returns false (bypass — action key intercepted)', () => {
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)

      const result = ctx.handler(makeKeyEvent({ key: '1' }))
      expect(result).toBe(false)
      expect(ctx.isPrefixMode()).toBe(false)
    })

    it('after action key, subsequent keys return true (handled — normal input)', () => {
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      ctx.handler(makeKeyEvent({ key: '1' }))
      expect(ctx.handler(makeKeyEvent({ key: 'a' }))).toBe(true)
      expect(ctx.handler(makeKeyEvent({ key: 'b' }))).toBe(true)
    })

    it('prefix mode auto-exits after 1500ms timeout', () => {
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)

      vi.advanceTimersByTime(1499)
      expect(ctx.isPrefixMode()).toBe(true)

      vi.advanceTimersByTime(1)
      expect(ctx.isPrefixMode()).toBe(false)
    })

    it('after timeout, keys return true (handled — normal input)', () => {
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      vi.advanceTimersByTime(1500)
      expect(ctx.handler(makeKeyEvent({ key: '1' }))).toBe(true)
    })

    it('pressing Ctrl+B again resets the timeout', () => {
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)

      vi.advanceTimersByTime(1000)
      expect(ctx.isPrefixMode()).toBe(true)

      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)

      vi.advanceTimersByTime(1000)
      expect(ctx.isPrefixMode()).toBe(true)

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
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)

      const result = ctx.handler(makeKeyEvent({ key: '1', type: 'keyup' }))
      expect(result).toBe(true)
      expect(ctx.isPrefixMode()).toBe(true)
    })

    it('multiple Ctrl+B -> action sequences work correctly', () => {
      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)
      ctx.handler(makeKeyEvent({ key: '1' }))
      expect(ctx.isPrefixMode()).toBe(false)

      expect(ctx.handler(makeKeyEvent({ key: 'a' }))).toBe(true)

      ctx.handler(makeKeyEvent({ key: 'b', ctrlKey: true }))
      expect(ctx.isPrefixMode()).toBe(true)
      ctx.handler(makeKeyEvent({ key: '2' }))
      expect(ctx.isPrefixMode()).toBe(false)
    })
  })
})
