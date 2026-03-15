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
  isMetaAltArrow,
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
// keyboard events that escape ghostty-web to reach panel hotkeys.
//
// ghostty-web calls stopPropagation() on keys it processes, so all
// app-level shortcuts must be explicitly bypassed. All Meta+ (Cmd)
// combinations are bypassed since they are always app-level shortcuts.
// Ctrl+B is bypassed for the tmux-style prefix key sequence.
// ---------------------------------------------------------------------------

describe('shouldBypassTerminal', () => {
  // --- Meta+ (Cmd) shortcuts — all bypassed ---

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

  it('bypasses Cmd+D (split horizontal)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'd', metaKey: true }))
    ).toBe(true)
  })

  it('bypasses Cmd+Shift+D (split vertical)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'd', metaKey: true, shiftKey: true })
      )
    ).toBe(true)
  })

  it('bypasses Cmd+P (push workspace)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'p', metaKey: true }))
    ).toBe(true)
  })

  it('bypasses Cmd+Shift+P (pull workspace)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'p', metaKey: true, shiftKey: true })
      )
    ).toBe(true)
  })

  it('bypasses any Meta+ combination (Cmd is always app-level)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'w', metaKey: true, shiftKey: true })
      )
    ).toBe(true)
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'w', metaKey: true, altKey: true })
      )
    ).toBe(true)
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'z', metaKey: true }))
    ).toBe(true)
  })

  // --- Ctrl+B — prefix key ---

  it('bypasses Ctrl+B (panel prefix key)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'b', ctrlKey: true }))
    ).toBe(true)
  })

  // --- Non-bypassed keys — normal terminal input ---

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

  it('does not bypass plain arrow keys (terminal cursor movement)', () => {
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'ArrowUp' }))).toBe(false)
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'ArrowDown' }))).toBe(false)
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'ArrowLeft' }))).toBe(false)
    expect(shouldBypassTerminal(makeKeyEvent({ key: 'ArrowRight' }))).toBe(
      false
    )
  })

  it('bypasses Cmd+Option+ArrowLeft (directional pane navigation)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'ArrowLeft', metaKey: true, altKey: true })
      )
    ).toBe(true)
  })

  it('bypasses Cmd+Option+ArrowRight (directional pane navigation)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'ArrowRight', metaKey: true, altKey: true })
      )
    ).toBe(true)
  })

  it('bypasses Cmd+Option+ArrowUp (directional pane navigation)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'ArrowUp', metaKey: true, altKey: true })
      )
    ).toBe(true)
  })

  it('bypasses Cmd+Option+ArrowDown (directional pane navigation)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'ArrowDown', metaKey: true, altKey: true })
      )
    ).toBe(true)
  })

  it('does not bypass Ctrl+Shift+B (not exact Ctrl+B)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'b', ctrlKey: true, shiftKey: true })
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

// ---------------------------------------------------------------------------
// Tests: isMetaAltArrow (Cmd+Option+Arrow — directional pane navigation)
// ---------------------------------------------------------------------------

describe('isMetaAltArrow', () => {
  it('returns true for Cmd+Option+ArrowLeft', () => {
    expect(
      isMetaAltArrow(
        makeKeyEvent({ key: 'ArrowLeft', metaKey: true, altKey: true })
      )
    ).toBe(true)
  })

  it('returns true for Cmd+Option+ArrowRight', () => {
    expect(
      isMetaAltArrow(
        makeKeyEvent({ key: 'ArrowRight', metaKey: true, altKey: true })
      )
    ).toBe(true)
  })

  it('returns true for Cmd+Option+ArrowUp', () => {
    expect(
      isMetaAltArrow(
        makeKeyEvent({ key: 'ArrowUp', metaKey: true, altKey: true })
      )
    ).toBe(true)
  })

  it('returns true for Cmd+Option+ArrowDown', () => {
    expect(
      isMetaAltArrow(
        makeKeyEvent({ key: 'ArrowDown', metaKey: true, altKey: true })
      )
    ).toBe(true)
  })

  it('returns false when meta is not held', () => {
    expect(
      isMetaAltArrow(makeKeyEvent({ key: 'ArrowLeft', altKey: true }))
    ).toBe(false)
  })

  it('returns false when alt is not held', () => {
    expect(
      isMetaAltArrow(makeKeyEvent({ key: 'ArrowLeft', metaKey: true }))
    ).toBe(false)
  })

  it('returns false when ctrl is also held', () => {
    expect(
      isMetaAltArrow(
        makeKeyEvent({
          key: 'ArrowLeft',
          metaKey: true,
          altKey: true,
          ctrlKey: true,
        })
      )
    ).toBe(false)
  })

  it('returns false when shift is also held', () => {
    expect(
      isMetaAltArrow(
        makeKeyEvent({
          key: 'ArrowLeft',
          metaKey: true,
          altKey: true,
          shiftKey: true,
        })
      )
    ).toBe(false)
  })

  it('returns false for non-arrow keys with same modifiers', () => {
    expect(
      isMetaAltArrow(makeKeyEvent({ key: 'a', metaKey: true, altKey: true }))
    ).toBe(false)
  })

  it('returns false for plain arrow keys', () => {
    expect(isMetaAltArrow(makeKeyEvent({ key: 'ArrowLeft' }))).toBe(false)
    expect(isMetaAltArrow(makeKeyEvent({ key: 'ArrowRight' }))).toBe(false)
    expect(isMetaAltArrow(makeKeyEvent({ key: 'ArrowUp' }))).toBe(false)
    expect(isMetaAltArrow(makeKeyEvent({ key: 'ArrowDown' }))).toBe(false)
  })
})
