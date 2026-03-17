/**
 * Unit tests for centralized keybind matching and terminal bypass logic.
 *
 * These test the pure functions that determine which keyboard events
 * bypass ghostty-web and bubble to the global hotkey layer. Getting these
 * wrong means either panel shortcuts don't work from within terminals,
 * or legitimate terminal input gets silently swallowed.
 *
 * @see apps/web/src/lib/keybinds.ts — centralized keybind definitions
 * @see Issue #80: Keyboard shortcut scope isolation
 */

import { describe, expect, it } from 'vitest'
import {
  isPrefixKey,
  KEYBINDS,
  matchesKeybind,
  shouldBypassTerminal,
} from '../src/lib/keybinds'
import { isMetaAltArrow } from '../src/panes/terminal-keys'

// ---------------------------------------------------------------------------
// Helper — create a minimal KeyboardEvent-shaped object for testing.
// Uses the subset of properties our functions actually check.
// ---------------------------------------------------------------------------

function makeKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent
}

// ---------------------------------------------------------------------------
// Tests: matchesKeybind — verifying specific KEYBINDS entries
// ---------------------------------------------------------------------------

describe('matchesKeybind with KEYBINDS.TOGGLE_FULLSCREEN (Cmd+Shift+Enter)', () => {
  const keybind = KEYBINDS.TOGGLE_FULLSCREEN

  it('matches Cmd+Shift+Enter', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'Enter', metaKey: true, shiftKey: true }),
        keybind
      )
    ).toBe(true)
  })

  it('does not match when meta is not held', () => {
    expect(
      matchesKeybind(makeKeyEvent({ key: 'Enter', shiftKey: true }), keybind)
    ).toBe(false)
  })

  it('does not match when shift is not held', () => {
    expect(
      matchesKeybind(makeKeyEvent({ key: 'Enter', metaKey: true }), keybind)
    ).toBe(false)
  })

  it('does not match when ctrl is also held', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({
          key: 'Enter',
          metaKey: true,
          shiftKey: true,
          ctrlKey: true,
        }),
        keybind
      )
    ).toBe(false)
  })

  it('does not match when alt is also held', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({
          key: 'Enter',
          metaKey: true,
          shiftKey: true,
          altKey: true,
        }),
        keybind
      )
    ).toBe(false)
  })

  it('does not match a different key with same modifiers', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'a', metaKey: true, shiftKey: true }),
        keybind
      )
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: shouldBypassTerminal
//
// This is the main public interface — it determines the complete set of
// keyboard events that escape ghostty-web to reach panel hotkeys.
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

  it('does not bypass arbitrary Cmd+key that is not a defined keybind', () => {
    // Cmd+Z (undo) is not in KEYBINDS — should NOT bypass
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'z', metaKey: true }))
    ).toBe(false)
  })

  it('does not bypass Cmd+V (paste must reach ghostty-web for TUI image paste)', () => {
    // Cmd+V must NOT be bypassed — ghostty-web handles paste natively by
    // letting the browser's native paste event fire. TUIs (opencode, claude
    // code, etc.) detect the paste key in the PTY and read the system
    // clipboard directly via OS commands to get image data.
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'v', metaKey: true }))
    ).toBe(false)
  })

  it('does not bypass Ctrl+V (paste must reach ghostty-web for TUI image paste)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'v', ctrlKey: true }))
    ).toBe(false)
  })

  it('does not bypass Cmd+C (copy handled natively by ghostty-web)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'c', metaKey: true }))
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: isPrefixKey (Ctrl+B — panel prefix key)
// ---------------------------------------------------------------------------

describe('isPrefixKey', () => {
  it('returns true for exact Ctrl+B', () => {
    expect(isPrefixKey(makeKeyEvent({ key: 'b', ctrlKey: true }))).toBe(true)
  })

  it('returns false when meta is also held', () => {
    expect(
      isPrefixKey(makeKeyEvent({ key: 'b', ctrlKey: true, metaKey: true }))
    ).toBe(false)
  })

  it('returns false for plain b', () => {
    expect(isPrefixKey(makeKeyEvent({ key: 'b' }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: matchesKeybind with NAV_LEFT (Cmd+Option+Arrow)
// ---------------------------------------------------------------------------

describe('matchesKeybind with KEYBINDS.NAV_LEFT (Cmd+Option+ArrowLeft)', () => {
  const keybind = KEYBINDS.NAV_LEFT

  it('matches Cmd+Option+ArrowLeft', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'ArrowLeft', metaKey: true, altKey: true }),
        keybind
      )
    ).toBe(true)
  })

  it('does not match when meta is not held', () => {
    expect(
      matchesKeybind(makeKeyEvent({ key: 'ArrowLeft', altKey: true }), keybind)
    ).toBe(false)
  })

  it('does not match when alt is not held', () => {
    expect(
      matchesKeybind(makeKeyEvent({ key: 'ArrowLeft', metaKey: true }), keybind)
    ).toBe(false)
  })

  it('does not match when ctrl is also held', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({
          key: 'ArrowLeft',
          metaKey: true,
          altKey: true,
          ctrlKey: true,
        }),
        keybind
      )
    ).toBe(false)
  })

  it('does not match when shift is also held', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({
          key: 'ArrowLeft',
          metaKey: true,
          altKey: true,
          shiftKey: true,
        }),
        keybind
      )
    ).toBe(false)
  })

  it('does not match for non-arrow keys with same modifiers', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'a', metaKey: true, altKey: true }),
        keybind
      )
    ).toBe(false)
  })

  it('does not match for plain arrow keys', () => {
    expect(matchesKeybind(makeKeyEvent({ key: 'ArrowLeft' }), keybind)).toBe(
      false
    )
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
