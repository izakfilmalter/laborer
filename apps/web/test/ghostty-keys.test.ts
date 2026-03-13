/**
 * Unit tests for Ghostty keyboard input mapping.
 *
 * Tests the key code translation from browser KeyboardEvent.code to
 * Ghostty's ghostty_input_key_e enum values, and modifier flag translation.
 *
 * @see apps/web/src/panes/ghostty-keys.ts
 * @see Issue 5: Keyboard, focus, and resize routing
 */

import { describe, expect, it } from 'vitest'
import {
  GHOSTTY_KEY_MAP,
  RESIZE_DEBOUNCE_MS,
  translateModifiers,
} from '../src/panes/ghostty-keys'

// ---------------------------------------------------------------------------
// Tests: GHOSTTY_KEY_MAP — browser code → Ghostty key enum
// ---------------------------------------------------------------------------

describe('GHOSTTY_KEY_MAP', () => {
  it('maps letter keys correctly (KeyA=20 through KeyZ=45)', () => {
    expect(GHOSTTY_KEY_MAP.get('KeyA')).toBe(20)
    expect(GHOSTTY_KEY_MAP.get('KeyB')).toBe(21)
    expect(GHOSTTY_KEY_MAP.get('KeyM')).toBe(32)
    expect(GHOSTTY_KEY_MAP.get('KeyZ')).toBe(45)
  })

  it('maps digit keys correctly (Digit0=6 through Digit9=15)', () => {
    expect(GHOSTTY_KEY_MAP.get('Digit0')).toBe(6)
    expect(GHOSTTY_KEY_MAP.get('Digit1')).toBe(7)
    expect(GHOSTTY_KEY_MAP.get('Digit9')).toBe(15)
  })

  it('maps functional keys correctly', () => {
    expect(GHOSTTY_KEY_MAP.get('Backspace')).toBe(53)
    expect(GHOSTTY_KEY_MAP.get('Enter')).toBe(58)
    expect(GHOSTTY_KEY_MAP.get('Space')).toBe(63)
    expect(GHOSTTY_KEY_MAP.get('Tab')).toBe(64)
    expect(GHOSTTY_KEY_MAP.get('Escape')).toBe(120)
    expect(GHOSTTY_KEY_MAP.get('CapsLock')).toBe(54)
  })

  it('maps modifier keys correctly', () => {
    expect(GHOSTTY_KEY_MAP.get('ShiftLeft')).toBe(61)
    expect(GHOSTTY_KEY_MAP.get('ShiftRight')).toBe(62)
    expect(GHOSTTY_KEY_MAP.get('ControlLeft')).toBe(56)
    expect(GHOSTTY_KEY_MAP.get('ControlRight')).toBe(57)
    expect(GHOSTTY_KEY_MAP.get('AltLeft')).toBe(51)
    expect(GHOSTTY_KEY_MAP.get('AltRight')).toBe(52)
    expect(GHOSTTY_KEY_MAP.get('MetaLeft')).toBe(59)
    expect(GHOSTTY_KEY_MAP.get('MetaRight')).toBe(60)
  })

  it('maps arrow keys correctly', () => {
    expect(GHOSTTY_KEY_MAP.get('ArrowDown')).toBe(75)
    expect(GHOSTTY_KEY_MAP.get('ArrowLeft')).toBe(76)
    expect(GHOSTTY_KEY_MAP.get('ArrowRight')).toBe(77)
    expect(GHOSTTY_KEY_MAP.get('ArrowUp')).toBe(78)
  })

  it('maps control pad keys correctly', () => {
    expect(GHOSTTY_KEY_MAP.get('Delete')).toBe(68)
    expect(GHOSTTY_KEY_MAP.get('End')).toBe(69)
    expect(GHOSTTY_KEY_MAP.get('Home')).toBe(71)
    expect(GHOSTTY_KEY_MAP.get('Insert')).toBe(72)
    expect(GHOSTTY_KEY_MAP.get('PageDown')).toBe(73)
    expect(GHOSTTY_KEY_MAP.get('PageUp')).toBe(74)
  })

  it('maps function keys correctly (F1=121 through F12=132)', () => {
    expect(GHOSTTY_KEY_MAP.get('F1')).toBe(121)
    expect(GHOSTTY_KEY_MAP.get('F2')).toBe(122)
    expect(GHOSTTY_KEY_MAP.get('F12')).toBe(132)
  })

  it('maps punctuation keys correctly', () => {
    expect(GHOSTTY_KEY_MAP.get('Backquote')).toBe(1)
    expect(GHOSTTY_KEY_MAP.get('Backslash')).toBe(2)
    expect(GHOSTTY_KEY_MAP.get('BracketLeft')).toBe(3)
    expect(GHOSTTY_KEY_MAP.get('BracketRight')).toBe(4)
    expect(GHOSTTY_KEY_MAP.get('Comma')).toBe(5)
    expect(GHOSTTY_KEY_MAP.get('Equal')).toBe(16)
    expect(GHOSTTY_KEY_MAP.get('Minus')).toBe(46)
    expect(GHOSTTY_KEY_MAP.get('Period')).toBe(47)
    expect(GHOSTTY_KEY_MAP.get('Quote')).toBe(48)
    expect(GHOSTTY_KEY_MAP.get('Semicolon')).toBe(49)
    expect(GHOSTTY_KEY_MAP.get('Slash')).toBe(50)
  })

  it('maps numpad keys correctly', () => {
    expect(GHOSTTY_KEY_MAP.get('Numpad0')).toBe(80)
    expect(GHOSTTY_KEY_MAP.get('Numpad9')).toBe(89)
    expect(GHOSTTY_KEY_MAP.get('NumpadAdd')).toBe(90)
    expect(GHOSTTY_KEY_MAP.get('NumpadSubtract')).toBe(107)
    expect(GHOSTTY_KEY_MAP.get('NumpadMultiply')).toBe(104)
    expect(GHOSTTY_KEY_MAP.get('NumpadDivide')).toBe(96)
    expect(GHOSTTY_KEY_MAP.get('NumpadEnter')).toBe(97)
    expect(GHOSTTY_KEY_MAP.get('NumpadDecimal')).toBe(95)
  })

  it('returns undefined for unknown key codes', () => {
    expect(GHOSTTY_KEY_MAP.get('UnknownKey')).toBeUndefined()
    expect(GHOSTTY_KEY_MAP.get('')).toBeUndefined()
    expect(GHOSTTY_KEY_MAP.get('MediaPlayPause')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: translateModifiers — browser modifier flags → Ghostty mods bitmask
// ---------------------------------------------------------------------------

describe('translateModifiers', () => {
  it('returns 0 when no modifiers are active', () => {
    expect(
      translateModifiers({
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      })
    ).toBe(0)
  })

  it('returns SHIFT (1) for shiftKey only', () => {
    expect(
      translateModifiers({
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      })
    ).toBe(1)
  })

  it('returns CTRL (2) for ctrlKey only', () => {
    expect(
      translateModifiers({
        shiftKey: false,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
      })
    ).toBe(2)
  })

  it('returns ALT (4) for altKey only', () => {
    expect(
      translateModifiers({
        shiftKey: false,
        ctrlKey: false,
        altKey: true,
        metaKey: false,
      })
    ).toBe(4)
  })

  it('returns SUPER (8) for metaKey only', () => {
    expect(
      translateModifiers({
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: true,
      })
    ).toBe(8)
  })

  it('combines CTRL+SHIFT correctly (3)', () => {
    expect(
      translateModifiers({
        shiftKey: true,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
      })
    ).toBe(3)
  })

  it('combines all modifiers correctly (15)', () => {
    expect(
      translateModifiers({
        shiftKey: true,
        ctrlKey: true,
        altKey: true,
        metaKey: true,
      })
    ).toBe(15)
  })

  it('combines SUPER+ALT correctly (12)', () => {
    expect(
      translateModifiers({
        shiftKey: false,
        ctrlKey: false,
        altKey: true,
        metaKey: true,
      })
    ).toBe(12)
  })
})

// ---------------------------------------------------------------------------
// Tests: RESIZE_DEBOUNCE_MS constant
// ---------------------------------------------------------------------------

describe('RESIZE_DEBOUNCE_MS', () => {
  it('is 100ms matching the existing terminal pane debounce', () => {
    expect(RESIZE_DEBOUNCE_MS).toBe(100)
  })
})
