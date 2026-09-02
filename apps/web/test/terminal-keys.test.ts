/**
 * Unit tests for centralized keybind matching and terminal bypass logic.
 *
 * These test the pure functions that determine which keyboard events
 * bypass the terminal and bubble to the global hotkey layer. Getting these
 * wrong means either panel shortcuts don't work from within terminals,
 * or legitimate terminal input gets silently swallowed.
 *
 * @see apps/web/src/lib/keybinds.ts — centralized keybind definitions
 * @see apps/web/src/lib/terminal-keyboard.ts — the surface's `beforeKey` gate
 * @see Issue #80: Keyboard shortcut scope isolation
 */

import { describe, expect, it } from 'vitest'
import {
  IS_MAC,
  isPrefixKey,
  KEYBINDS,
  matchesKeybind,
  shouldBypassTerminal,
} from '../src/lib/keybinds'
import {
  getTerminalInputOverride,
  handleTerminalKeyEvent,
} from '../src/lib/terminal-keyboard'

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

function makePlatformModKeyEvent(
  key: string,
  overrides: Partial<KeyboardEvent> = {}
): KeyboardEvent {
  return makeKeyEvent(
    IS_MAC
      ? { key, metaKey: true, ...overrides }
      : { key, ctrlKey: true, ...overrides }
  )
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
// keyboard events that escape the terminal surface to reach panel hotkeys.
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

  it('bypasses Cmd+K (command palette toggle)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'k', metaKey: true }))
    ).toBe(true)
  })

  it('bypasses Cmd+Shift+K (kanban board overlay toggle)', () => {
    expect(
      shouldBypassTerminal(
        makeKeyEvent({ key: 'k', metaKey: true, shiftKey: true })
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

  it('classifies Ctrl+B as an app prefix outside focused terminal input', () => {
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

  it('does not bypass Cmd+V (paste must reach the terminal for TUI image paste)', () => {
    // Cmd+V must NOT be bypassed — the Ghostty surface handles paste natively.
    // TUIs (opencode, claude code, etc.) detect the paste key in the PTY
    // and read the system clipboard directly via OS commands to get image data.
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'v', metaKey: true }))
    ).toBe(false)
  })

  it('does not bypass Ctrl+V (paste must reach the terminal for TUI image paste)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'v', ctrlKey: true }))
    ).toBe(false)
  })

  it('does not bypass Cmd+C (copy handled natively by the Ghostty surface)', () => {
    expect(
      shouldBypassTerminal(makeKeyEvent({ key: 'c', metaKey: true }))
    ).toBe(false)
  })

  it('keeps the find shortcuts out of the app hotkey layer', () => {
    // Find belongs to the pane that has focus, not to the window.
    expect(shouldBypassTerminal(makePlatformModKeyEvent('f'))).toBe(false)
    expect(shouldBypassTerminal(makePlatformModKeyEvent('g'))).toBe(false)
  })
})

/**
 * The gate Ghostty's surface consults before encoding a key. `true` lets it
 * encode and send; `false` leaves the event to bubble to the global hotkeys,
 * or drops it when this layer already sent something in its place.
 */
describe('what a focused terminal claims', () => {
  const makeGateEvent = (overrides: Partial<KeyboardEvent> = {}) =>
    Object.assign(makeKeyEvent(overrides), {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    })

  const gate = (event: KeyboardEvent, isRunning = true) => {
    const sent: string[] = []
    const handled = handleTerminalKeyEvent(event, {
      isRunning,
      send: (data) => {
        sent.push(data)
      },
      shouldBypass: shouldBypassTerminal,
    })
    return { handled, sent }
  }

  it('gives the panel prefix to the PTY while the terminal has focus', () => {
    // Ctrl+B is an app keybind, but a focused terminal owns it for readline.
    const event = makeGateEvent({ key: 'b', ctrlKey: true })
    expect(shouldBypassTerminal(event)).toBe(true)
    expect(gate(event).handled).toBe(true)
  })

  it('lets app shortcuts through to the global hotkey layer', () => {
    expect(gate(makeGateEvent({ key: 'k', metaKey: true })).handled).toBe(false)
    expect(
      gate(makeGateEvent({ key: 'ArrowLeft', metaKey: true, altKey: true }))
        .handled
    ).toBe(false)
  })

  it('leaves ordinary keys to Ghostty', () => {
    expect(gate(makeGateEvent({ key: 'a' })).handled).toBe(true)
    expect(gate(makeGateEvent({ key: 'c', ctrlKey: true })).handled).toBe(true)
  })

  it('sends readline navigation for macOS arrow chords', () => {
    if (!IS_MAC) {
      return
    }

    const option = gate(makeGateEvent({ key: 'ArrowLeft', altKey: true }))
    expect(option.handled).toBe(false)
    expect(option.sent).toEqual(['\x1bb'])

    const command = gate(makeGateEvent({ key: 'ArrowRight', metaKey: true }))
    expect(command.handled).toBe(false)
    expect(command.sent).toEqual(['\x05'])
  })

  it('drops the readline override when the process has exited', () => {
    if (!IS_MAC) {
      return
    }

    const stopped = gate(
      makeGateEvent({ key: 'ArrowLeft', altKey: true }),
      false
    )
    expect(stopped.handled).toBe(false)
    expect(stopped.sent).toEqual([])
  })

  it('routes the find chords to the pane instead of the PTY', () => {
    const requests: string[] = []
    const findGate = (event: KeyboardEvent) =>
      handleTerminalKeyEvent(event, {
        isRunning: true,
        onFind: (request) => {
          requests.push(request)
        },
        send: () => undefined,
        shouldBypass: shouldBypassTerminal,
      })

    const modifier = IS_MAC ? { metaKey: true } : { ctrlKey: true }
    expect(findGate(makeGateEvent({ key: 'f', ...modifier }))).toBe(false)
    expect(findGate(makeGateEvent({ key: 'g', ...modifier }))).toBe(false)
    expect(
      findGate(makeGateEvent({ key: 'g', shiftKey: true, ...modifier }))
    ).toBe(false)
    expect(requests).toEqual(['open', 'next', 'previous'])
  })

  it('leaves the find chords to Ghostty in a pane without a find bar', () => {
    const modifier = IS_MAC ? { metaKey: true } : { ctrlKey: true }
    expect(gate(makeGateEvent({ key: 'f', ...modifier })).handled).toBe(true)
  })

  it('reads the arrow override only on macOS', () => {
    expect(
      getTerminalInputOverride(
        makeGateEvent({ key: 'ArrowLeft', altKey: true }),
        false
      )
    ).toBeUndefined()
  })

  it('leaves Shift-extended arrow selection to the terminal', () => {
    expect(
      getTerminalInputOverride(
        makeGateEvent({ key: 'ArrowLeft', altKey: true, shiftKey: true }),
        true
      )
    ).toBeUndefined()
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
// Tests: NAV_LEFT/RIGHT/UP/DOWN (Cmd+Option+Arrow — directional pane navigation)
// ---------------------------------------------------------------------------

describe('directional pane navigation keybinds', () => {
  it('matches Cmd+Option+ArrowLeft', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'ArrowLeft', metaKey: true, altKey: true }),
        KEYBINDS.NAV_LEFT
      )
    ).toBe(true)
  })

  it('matches Cmd+Option+ArrowRight', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'ArrowRight', metaKey: true, altKey: true }),
        KEYBINDS.NAV_RIGHT
      )
    ).toBe(true)
  })

  it('matches Cmd+Option+ArrowUp', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'ArrowUp', metaKey: true, altKey: true }),
        KEYBINDS.NAV_UP
      )
    ).toBe(true)
  })

  it('matches Cmd+Option+ArrowDown', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'ArrowDown', metaKey: true, altKey: true }),
        KEYBINDS.NAV_DOWN
      )
    ).toBe(true)
  })

  it('does not match when meta is not held', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'ArrowLeft', altKey: true }),
        KEYBINDS.NAV_LEFT
      )
    ).toBe(false)
  })

  it('does not match when alt is not held', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'ArrowLeft', metaKey: true }),
        KEYBINDS.NAV_LEFT
      )
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
        KEYBINDS.NAV_LEFT
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
        KEYBINDS.NAV_LEFT
      )
    ).toBe(false)
  })

  it('does not match non-arrow keys with same modifiers', () => {
    expect(
      matchesKeybind(
        makeKeyEvent({ key: 'a', metaKey: true, altKey: true }),
        KEYBINDS.NAV_LEFT
      )
    ).toBe(false)
  })

  it('does not match plain arrow keys', () => {
    expect(
      matchesKeybind(makeKeyEvent({ key: 'ArrowLeft' }), KEYBINDS.NAV_LEFT)
    ).toBe(false)
    expect(
      matchesKeybind(makeKeyEvent({ key: 'ArrowRight' }), KEYBINDS.NAV_RIGHT)
    ).toBe(false)
    expect(
      matchesKeybind(makeKeyEvent({ key: 'ArrowUp' }), KEYBINDS.NAV_UP)
    ).toBe(false)
    expect(
      matchesKeybind(makeKeyEvent({ key: 'ArrowDown' }), KEYBINDS.NAV_DOWN)
    ).toBe(false)
  })
})
