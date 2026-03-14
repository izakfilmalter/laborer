/**
 * Keyboard event detection helpers for terminal pane scope isolation.
 *
 * These pure functions determine which keyboard events should bypass
 * xterm.js and bubble to the global hotkey layer (TanStack Hotkeys on
 * document). They are used by `TerminalPane.attachCustomKeyEventHandler`
 * to let panel shortcuts work even when a terminal has focus.
 *
 * @see apps/web/src/panes/terminal-pane.tsx — usage in xterm.js key handler
 * @see apps/web/src/panels/panel-hotkeys.tsx — global shortcuts that need these events
 * @see Issue #80: Keyboard shortcut scope isolation
 */

/** Cmd+W — close pane. Must be exactly Meta+W with no other modifiers. */
const isExactMetaW = (event: KeyboardEvent): boolean =>
  event.key === 'w' &&
  event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey

/** Cmd+Shift+Enter — toggle fullscreen pane. */
const isMetaShiftEnter = (event: KeyboardEvent): boolean =>
  event.key === 'Enter' &&
  event.metaKey &&
  event.shiftKey &&
  !event.ctrlKey &&
  !event.altKey

/** Ctrl+B — panel prefix key. Must be exactly Ctrl+B with no other modifiers. */
const isExactCtrlB = (event: KeyboardEvent): boolean =>
  event.key === 'b' &&
  event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  !event.metaKey

/** Cmd+N — new window tab. */
const isMetaN = (event: KeyboardEvent): boolean =>
  event.key === 'n' &&
  event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey

/** Cmd+Shift+W — close window tab. */
const isMetaShiftW = (event: KeyboardEvent): boolean =>
  event.key === 'W' &&
  event.metaKey &&
  event.shiftKey &&
  !event.ctrlKey &&
  !event.altKey

/** Cmd+1 through Cmd+9 — switch window tab by index. */
const isMetaDigit = (event: KeyboardEvent): boolean =>
  event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  event.key >= '1' &&
  event.key <= '9'

/** Cmd+Shift+[ or Cmd+Shift+] — cycle window tabs. */
const isMetaShiftBracket = (event: KeyboardEvent): boolean =>
  event.metaKey &&
  event.shiftKey &&
  !event.ctrlKey &&
  !event.altKey &&
  (event.key === '[' || event.key === ']')

/** Ctrl+T — new panel tab. */
const isCtrlT = (event: KeyboardEvent): boolean =>
  event.key === 't' &&
  event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  !event.altKey

/** Ctrl+1 through Ctrl+9 — switch panel tab by index. */
const isCtrlDigit = (event: KeyboardEvent): boolean =>
  event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  !event.altKey &&
  event.key >= '1' &&
  event.key <= '9'

/** Ctrl+Shift+[ or Ctrl+Shift+] — cycle panel tabs. */
const isCtrlShiftBracket = (event: KeyboardEvent): boolean =>
  event.ctrlKey &&
  event.shiftKey &&
  !event.metaKey &&
  !event.altKey &&
  (event.key === '[' || event.key === ']')

/**
 * Check if a keyboard event should bypass xterm.js and bubble to
 * the global hotkey layer (TanStack Hotkeys on document).
 *
 * Returns true if the event should be passed through (xterm ignores it).
 */
const shouldBypassTerminal = (event: KeyboardEvent): boolean =>
  isExactMetaW(event) ||
  isMetaShiftEnter(event) ||
  isExactCtrlB(event) ||
  isMetaN(event) ||
  isMetaShiftW(event) ||
  isMetaDigit(event) ||
  isMetaShiftBracket(event) ||
  isCtrlT(event) ||
  isCtrlDigit(event) ||
  isCtrlShiftBracket(event)

export {
  isCtrlDigit,
  isCtrlShiftBracket,
  isCtrlT,
  isExactCtrlB,
  isExactMetaW,
  isMetaDigit,
  isMetaN,
  isMetaShiftBracket,
  isMetaShiftEnter,
  isMetaShiftW,
  shouldBypassTerminal,
}
