/**
 * Unit tests for Ghostty mouse input mapping.
 *
 * Tests the mouse button translation from browser MouseEvent.button to
 * Ghostty's ghostty_input_mouse_button_e enum values, and modifier flag
 * translation for mouse events.
 *
 * @see apps/web/src/panes/ghostty-mouse.ts
 * @see Issue 6: Mouse input and interactive terminal behavior
 */

import { describe, expect, it } from 'vitest'
import {
  GHOSTTY_MOUSE_PRESS,
  GHOSTTY_MOUSE_RELEASE,
  translateMouseButton,
  translateMouseModifiers,
} from '../src/panes/ghostty-mouse'

// ---------------------------------------------------------------------------
// Tests: translateMouseButton — browser button → Ghostty mouse button enum
// ---------------------------------------------------------------------------

describe('translateMouseButton', () => {
  it('maps browser button 0 (main) to GHOSTTY_MOUSE_LEFT (1)', () => {
    expect(translateMouseButton(0)).toBe(1)
  })

  it('maps browser button 1 (auxiliary) to GHOSTTY_MOUSE_MIDDLE (3)', () => {
    expect(translateMouseButton(1)).toBe(3)
  })

  it('maps browser button 2 (secondary) to GHOSTTY_MOUSE_RIGHT (2)', () => {
    expect(translateMouseButton(2)).toBe(2)
  })

  it('maps browser button 3 (back) to GHOSTTY_MOUSE_FOUR (4)', () => {
    expect(translateMouseButton(3)).toBe(4)
  })

  it('maps browser button 4 (forward) to GHOSTTY_MOUSE_FIVE (5)', () => {
    expect(translateMouseButton(4)).toBe(5)
  })

  it('maps unknown browser button to GHOSTTY_MOUSE_UNKNOWN (0)', () => {
    expect(translateMouseButton(99)).toBe(0)
    expect(translateMouseButton(-1)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: translateMouseModifiers — browser modifier flags → Ghostty bitmask
// ---------------------------------------------------------------------------

describe('translateMouseModifiers', () => {
  it('returns 0 when no modifiers are active', () => {
    expect(
      translateMouseModifiers({
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      })
    ).toBe(0)
  })

  it('returns SHIFT (1) for shiftKey only', () => {
    expect(
      translateMouseModifiers({
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      })
    ).toBe(1)
  })

  it('returns CTRL (2) for ctrlKey only', () => {
    expect(
      translateMouseModifiers({
        shiftKey: false,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
      })
    ).toBe(2)
  })

  it('returns ALT (4) for altKey only', () => {
    expect(
      translateMouseModifiers({
        shiftKey: false,
        ctrlKey: false,
        altKey: true,
        metaKey: false,
      })
    ).toBe(4)
  })

  it('returns SUPER (8) for metaKey only', () => {
    expect(
      translateMouseModifiers({
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: true,
      })
    ).toBe(8)
  })

  it('combines all modifiers correctly (15)', () => {
    expect(
      translateMouseModifiers({
        shiftKey: true,
        ctrlKey: true,
        altKey: true,
        metaKey: true,
      })
    ).toBe(15)
  })

  it('combines CTRL+SHIFT correctly (3)', () => {
    expect(
      translateMouseModifiers({
        shiftKey: true,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
      })
    ).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Tests: Mouse state constants
// ---------------------------------------------------------------------------

describe('Mouse state constants', () => {
  it('GHOSTTY_MOUSE_RELEASE is 0', () => {
    expect(GHOSTTY_MOUSE_RELEASE).toBe(0)
  })

  it('GHOSTTY_MOUSE_PRESS is 1', () => {
    expect(GHOSTTY_MOUSE_PRESS).toBe(1)
  })
})
