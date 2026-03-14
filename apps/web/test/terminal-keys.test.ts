/**
 * Unit tests for terminal keyboard event detection helpers.
 *
 * These test the pure functions that determine which keyboard events
 * bypass ghostty-web and bubble to the global hotkey layer. Getting these
 * wrong means either panel shortcuts don't work from within terminals,
 * or legitimate terminal input gets silently swallowed.
 *
 * @see apps/web/src/panes/terminal-keys.ts
 * @see Issue #80: Keyboard shortcut scope isolation
 */

import { describe, expect, it } from 'vitest'
import {
  isExactCtrlB,
  isExactMetaW,
  isMetaShiftEnter,
  shouldBypassTerminal,
} from '../src/panes/terminal-keys'

// ---------------------------------------------------------------------------
// Helper — create a minimal KeyboardEvent-shaped object for testing.
// Uses the subset of properties our functions actually check.
// ---------------------------------------------------------------------------

function makeKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent
}

// ---------------------------------------------------------------------------
// Tests: isMetaShiftEnter (Cmd+Shift+Enter — fullscreen toggle)
// ---------------------------------------------------------------------------

describe('isMetaShiftEnter', () => {
  it('returns true for Cmd+Shift+Enter', () => {
    expect(
      isMetaShiftEnter(
        makeKeyEvent({ key: 'Enter', metaKey: true, shiftKey: true })
      )
    ).toBe(true)
  })

  it('returns false when meta is not held', () => {
    expect(
      isMetaShiftEnter(makeKeyEvent({ key: 'Enter', shiftKey: true }))
    ).toBe(false)
  })

  it('returns false when shift is not held', () => {
    expect(
      isMetaShiftEnter(makeKeyEvent({ key: 'Enter', metaKey: true }))
    ).toBe(false)
  })

  it('returns false when ctrl is also held', () => {
    expect(
      isMetaShiftEnter(
        makeKeyEvent({
          key: 'Enter',
          metaKey: true,
          shiftKey: true,
          ctrlKey: true,
        })
      )
    ).toBe(false)
  })

  it('returns false when alt is also held', () => {
    expect(
      isMetaShiftEnter(
        makeKeyEvent({
          key: 'Enter',
          metaKey: true,
          shiftKey: true,
          altKey: true,
        })
      )
    ).toBe(false)
  })

  it('returns false for a different key with same modifiers', () => {
    expect(
      isMetaShiftEnter(
        makeKeyEvent({ key: 'a', metaKey: true, shiftKey: true })
      )
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: shouldBypassTerminal
//
// This is the main public interface — it determines the complete set of
// keyboard events that escape xterm.js to reach panel hotkeys. Every
// supported global shortcut must return true, and normal terminal input
// must return false.
// ---------------------------------------------------------------------------

describe('shouldBypassTerminal', () => {
  it('bypasses Cmd+W (close pane)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'w', metaKey: true }))
    ).toBe(true)
  })

  it('bypasses Cmd+Shift+Enter (fullscreen toggle)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'Enter', metaKey: true, shiftKey: true })
      )
    ).toBe(true)
  })

  it('bypasses Ctrl+B (panel prefix key)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'b', ctrlKey: true }))
    ).toBe(true)
  })

  it('does not bypass plain Enter (normal terminal input)', () => {
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'Enter' }))).toBe(false)
  })

  it('does not bypass plain letter keys', () => {
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'a' }))).toBe(false)
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'w' }))).toBe(false)
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'b' }))).toBe(false)
  })

  it('does not bypass Ctrl+C (terminal interrupt)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'c', ctrlKey: true }))
    ).toBe(false)
  })

  it('does not bypass Ctrl+D (terminal EOF)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'd', ctrlKey: true }))
    ).toBe(false)
  })

  it('does not bypass Cmd+Shift+D (split vertical — handled by TanStack at document level)', () => {
    // Cmd+Shift+D is a panel shortcut but NOT a terminal bypass —
    // it's handled at the document level by TanStack Hotkeys which
    // fires before xterm.js. Only shortcuts that xterm would otherwise
    // consume need explicit bypass.
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'd', metaKey: true, shiftKey: true })
      )
    ).toBe(false)
  })

  it('does not bypass Cmd+D (split horizontal — same as above)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'd', metaKey: true }))
    ).toBe(false)
  })

  it('does not bypass arrow keys (terminal cursor movement)', () => {
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'ArrowUp' }))).toBe(false)
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'ArrowDown' }))).toBe(false)
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'ArrowLeft' }))).toBe(false)
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'ArrowRight' }))).toBe(
      false
    )
  })

  it('does not bypass Ctrl+Shift+B (not exact Ctrl+B)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'b', ctrlKey: true, shiftKey: true })
      )
    ).toBe(false)
  })

  it('does not bypass Cmd+W with extra modifiers (not exact Cmd+W)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'w', metaKey: true, shiftKey: true })
      )
    ).toBe(false)
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'w', metaKey: true, altKey: true })
      )
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: isExactMetaW (Cmd+W — close pane)
// ---------------------------------------------------------------------------

describe('isExactMetaW', () => {
  it('returns true for exact Cmd+W', () => {
    expect(isExactMetaW(makeKeyEvent({ key: 'w', metaKey: true }))).toBe(true)
  })

  it('returns false when shift is also held', () => {
    expect(
      isExactMetaW(makeKeyEvent({ key: 'w', metaKey: true, shiftKey: true }))
    ).toBe(false)
  })

  it('returns false for plain w', () => {
    expect(isExactMetaW(makeKeyEvent({ key: 'w' }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: isExactCtrlB (Ctrl+B — panel prefix key)
// ---------------------------------------------------------------------------

describe('isExactCtrlB', () => {
  it('returns true for exact Ctrl+B', () => {
    expect(isExactCtrlB(makeKeyEvent({ key: 'b', ctrlKey: true }))).toBe(true)
  })

  it('returns false when meta is also held', () => {
    expect(
      isExactCtrlB(makeKeyEvent({ key: 'b', ctrlKey: true, metaKey: true }))
    ).toBe(false)
  })

  it('returns false for plain b', () => {
    expect(isExactCtrlB(makeKeyEvent({ key: 'b' }))).toBe(false)
  })
})
