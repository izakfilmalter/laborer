/**
 * Keyboard event detection helpers for terminal pane scope isolation.
 *
 * These pure functions determine which keyboard events should bypass
 * ghostty-web and bubble to the global hotkey layer (TanStack Hotkeys on
 * document). They are used by `TerminalPane.attachCustomKeyEventHandler`
 * to let panel shortcuts work even when a terminal has focus.
 *
 * ghostty-web calls `event.stopPropagation()` on keys it processes,
 * which prevents them from reaching document-level listeners. Any key
 * combination that should trigger an app-level shortcut (registered via
 * TanStack Hotkeys on document) must be explicitly bypassed here.
 *
 * All `Meta+` (Cmd on macOS) key events are bypassed because they are
 * always app-level shortcuts — the terminal uses `Ctrl+` for its own
 * sequences. This covers Cmd+D (split), Cmd+Shift+D (split vertical),
 * Cmd+W (close), Cmd+Shift+Enter (fullscreen), Cmd+P (push), etc.
 *
 * @see apps/web/src/panes/terminal-pane.tsx — usage in ghostty-web key handler
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

/** Cmd+Option+Arrow — directional pane navigation (cmux-style). */
const isMetaAltArrow = (event: KeyboardEvent): boolean =>
  event.metaKey &&
  event.altKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  (event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown')

/**
 * Check if a keyboard event should bypass ghostty-web and bubble to
 * the global hotkey layer (TanStack Hotkeys on document).
 *
 * Returns true if the event should be passed through (ghostty-web ignores it).
 *
 * ghostty-web calls `stopPropagation()` on keys it processes, so any
 * shortcut that needs to reach document-level listeners must be bypassed.
 * All `Meta+` (Cmd) combinations are bypassed since they are always
 * app-level shortcuts, never terminal input. `Ctrl+B` is bypassed for
 * the tmux-style prefix key sequence.
 */
const shouldBypassTerminal = (event: KeyboardEvent): boolean =>
  event.metaKey ||
  isExactCtrlB(event) ||
  isCtrlT(event) ||
  isCtrlDigit(event) ||
  isCtrlShiftBracket(event)

export {
  isCtrlDigit,
  isCtrlShiftBracket,
  isCtrlT,
  isExactCtrlB,
  isExactMetaW,
  isMetaAltArrow,
  isMetaDigit,
  isMetaN,
  isMetaShiftBracket,
  isMetaShiftEnter,
  isMetaShiftW,
  shouldBypassTerminal,
}
