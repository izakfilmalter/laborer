/**
 * Ghostty mouse input mapping utilities.
 *
 * Translates browser MouseEvent and WheelEvent data into Ghostty's native
 * mouse input types (ghostty_input_mouse_button_e, ghostty_input_mouse_state_e).
 *
 * @see vendor/ghostty/include/ghostty.h — Ghostty C API mouse types
 * @see Issue 6: Mouse input and interactive terminal behavior
 */

// ---------------------------------------------------------------------------
// Ghostty mouse button enum values (from ghostty_input_mouse_button_e)
// ---------------------------------------------------------------------------

/** ghostty_input_mouse_button_e values */
const GHOSTTY_MOUSE_UNKNOWN = 0
const GHOSTTY_MOUSE_LEFT = 1
const GHOSTTY_MOUSE_RIGHT = 2
const GHOSTTY_MOUSE_MIDDLE = 3
const GHOSTTY_MOUSE_FOUR = 4
const GHOSTTY_MOUSE_FIVE = 5

// ---------------------------------------------------------------------------
// Ghostty mouse state enum values (from ghostty_input_mouse_state_e)
// ---------------------------------------------------------------------------

/** Mouse button release. */
export const GHOSTTY_MOUSE_RELEASE = 0
/** Mouse button press. */
export const GHOSTTY_MOUSE_PRESS = 1

// ---------------------------------------------------------------------------
// Browser → Ghostty mouse button mapping
// ---------------------------------------------------------------------------

/**
 * Map a browser MouseEvent.button value to a Ghostty mouse button enum.
 *
 * Browser MouseEvent.button:
 *   0 = main (usually left)
 *   1 = auxiliary (usually middle)
 *   2 = secondary (usually right)
 *   3 = fourth (back)
 *   4 = fifth (forward)
 *
 * Ghostty ghostty_input_mouse_button_e:
 *   0 = unknown, 1 = left, 2 = right, 3 = middle, 4 = four, 5 = five
 */
export function translateMouseButton(browserButton: number): number {
  switch (browserButton) {
    case 0:
      return GHOSTTY_MOUSE_LEFT
    case 1:
      return GHOSTTY_MOUSE_MIDDLE
    case 2:
      return GHOSTTY_MOUSE_RIGHT
    case 3:
      return GHOSTTY_MOUSE_FOUR
    case 4:
      return GHOSTTY_MOUSE_FIVE
    default:
      return GHOSTTY_MOUSE_UNKNOWN
  }
}

/**
 * Translate browser modifier flags from a MouseEvent to a Ghostty modifier
 * bitmask. Same logic as translateModifiers from ghostty-keys.ts but accepts
 * a MouseEvent-like shape.
 *
 * Ghostty modifier flags:
 *   SHIFT = 1, CTRL = 2, ALT = 4, SUPER = 8
 */
export function translateMouseModifiers(event: {
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}): number {
  let mods = 0
  if (event.shiftKey) {
    mods += 1
  }
  if (event.ctrlKey) {
    mods += 2
  }
  if (event.altKey) {
    mods += 4
  }
  if (event.metaKey) {
    mods += 8
  }
  return mods
}
