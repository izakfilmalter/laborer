/**
 * Ghostty keyboard input mapping — translates browser KeyboardEvent.code
 * values to Ghostty's ghostty_input_key_e enum integers and provides
 * modifier flag translation.
 *
 * The Ghostty key enum is based on the W3C UI Events Code specification
 * (https://www.w3.org/TR/uievents-code/), which maps directly to the
 * browser's KeyboardEvent.code property. Enum values are sequential
 * starting from 0 with no gaps.
 *
 * @see vendor/ghostty/include/ghostty.h — ghostty_input_key_e enum
 * @see vendor/ghostty/include/ghostty.h — ghostty_input_mods_e flags
 */

// ---------------------------------------------------------------------------
// Modifier flags (ghostty_input_mods_e)
// ---------------------------------------------------------------------------

/**
 * Modifier flag constants matching ghostty_input_mods_e.
 * Using decimal values instead of bitwise shifts for linter compatibility.
 */
const GHOSTTY_MODS_NONE = 0
const GHOSTTY_MODS_SHIFT = 1
const GHOSTTY_MODS_CTRL = 2
const GHOSTTY_MODS_ALT = 4
const GHOSTTY_MODS_SUPER = 8

// ---------------------------------------------------------------------------
// Key enum values (ghostty_input_key_e)
//
// Sequential from 0, matching the order in ghostty.h.
// Only commonly-used keys are mapped; rare keys (media, browser, etc.)
// are omitted — they return undefined from the Map lookup and the
// key event is silently dropped.
// ---------------------------------------------------------------------------

/** Map from KeyboardEvent.code to ghostty_input_key_e integer. */
const GHOSTTY_KEY_MAP = new Map<string, number>([
  // "Writing System Keys" S 3.1.1
  ['Backquote', 1],
  ['Backslash', 2],
  ['BracketLeft', 3],
  ['BracketRight', 4],
  ['Comma', 5],
  ['Digit0', 6],
  ['Digit1', 7],
  ['Digit2', 8],
  ['Digit3', 9],
  ['Digit4', 10],
  ['Digit5', 11],
  ['Digit6', 12],
  ['Digit7', 13],
  ['Digit8', 14],
  ['Digit9', 15],
  ['Equal', 16],
  ['IntlBackslash', 17],
  ['IntlRo', 18],
  ['IntlYen', 19],
  ['KeyA', 20],
  ['KeyB', 21],
  ['KeyC', 22],
  ['KeyD', 23],
  ['KeyE', 24],
  ['KeyF', 25],
  ['KeyG', 26],
  ['KeyH', 27],
  ['KeyI', 28],
  ['KeyJ', 29],
  ['KeyK', 30],
  ['KeyL', 31],
  ['KeyM', 32],
  ['KeyN', 33],
  ['KeyO', 34],
  ['KeyP', 35],
  ['KeyQ', 36],
  ['KeyR', 37],
  ['KeyS', 38],
  ['KeyT', 39],
  ['KeyU', 40],
  ['KeyV', 41],
  ['KeyW', 42],
  ['KeyX', 43],
  ['KeyY', 44],
  ['KeyZ', 45],
  ['Minus', 46],
  ['Period', 47],
  ['Quote', 48],
  ['Semicolon', 49],
  ['Slash', 50],

  // "Functional Keys" S 3.1.2
  ['AltLeft', 51],
  ['AltRight', 52],
  ['Backspace', 53],
  ['CapsLock', 54],
  ['ContextMenu', 55],
  ['ControlLeft', 56],
  ['ControlRight', 57],
  ['Enter', 58],
  ['MetaLeft', 59],
  ['MetaRight', 60],
  ['ShiftLeft', 61],
  ['ShiftRight', 62],
  ['Space', 63],
  ['Tab', 64],
  ['Convert', 65],
  ['KanaMode', 66],
  ['NonConvert', 67],

  // "Control Pad Section" S 3.2
  ['Delete', 68],
  ['End', 69],
  ['Help', 70],
  ['Home', 71],
  ['Insert', 72],
  ['PageDown', 73],
  ['PageUp', 74],

  // "Arrow Pad Section" S 3.3
  ['ArrowDown', 75],
  ['ArrowLeft', 76],
  ['ArrowRight', 77],
  ['ArrowUp', 78],

  // "Numpad Section" S 3.4
  ['NumLock', 79],
  ['Numpad0', 80],
  ['Numpad1', 81],
  ['Numpad2', 82],
  ['Numpad3', 83],
  ['Numpad4', 84],
  ['Numpad5', 85],
  ['Numpad6', 86],
  ['Numpad7', 87],
  ['Numpad8', 88],
  ['Numpad9', 89],
  ['NumpadAdd', 90],
  ['NumpadBackspace', 91],
  ['NumpadClear', 92],
  ['NumpadClearEntry', 93],
  ['NumpadComma', 94],
  ['NumpadDecimal', 95],
  ['NumpadDivide', 96],
  ['NumpadEnter', 97],
  ['NumpadEqual', 98],
  ['NumpadMemoryAdd', 99],
  ['NumpadMemoryClear', 100],
  ['NumpadMemoryRecall', 101],
  ['NumpadMemoryStore', 102],
  ['NumpadMemorySubtract', 103],
  ['NumpadMultiply', 104],
  ['NumpadParenLeft', 105],
  ['NumpadParenRight', 106],
  ['NumpadSubtract', 107],

  // "Function Section" S 3.5
  ['Escape', 120],
  ['F1', 121],
  ['F2', 122],
  ['F3', 123],
  ['F4', 124],
  ['F5', 125],
  ['F6', 126],
  ['F7', 127],
  ['F8', 128],
  ['F9', 129],
  ['F10', 130],
  ['F11', 131],
  ['F12', 132],
  ['F13', 133],
  ['F14', 134],
  ['F15', 135],
  ['F16', 136],
  ['F17', 137],
  ['F18', 138],
  ['F19', 139],
  ['F20', 140],
  ['F21', 141],
  ['F22', 142],
  ['F23', 143],
  ['F24', 144],
  ['F25', 145],
  ['Fn', 146],
  ['FnLock', 147],
  ['PrintScreen', 148],
  ['ScrollLock', 149],
  ['Pause', 150],
])

// ---------------------------------------------------------------------------
// Resize debounce
// ---------------------------------------------------------------------------

/** Debounce interval for resize events (ms). Matches existing terminal pane. */
const RESIZE_DEBOUNCE_MS = 100

// ---------------------------------------------------------------------------
// Modifier translation
// ---------------------------------------------------------------------------

/**
 * Translate browser KeyboardEvent modifier flags to Ghostty's modifier bitmask.
 */
const translateModifiers = (event: {
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}): number => {
  let mods = GHOSTTY_MODS_NONE
  if (event.shiftKey) {
    mods += GHOSTTY_MODS_SHIFT
  }
  if (event.ctrlKey) {
    mods += GHOSTTY_MODS_CTRL
  }
  if (event.altKey) {
    mods += GHOSTTY_MODS_ALT
  }
  if (event.metaKey) {
    mods += GHOSTTY_MODS_SUPER
  }
  return mods
}

export { GHOSTTY_KEY_MAP, RESIZE_DEBOUNCE_MS, translateModifiers }
