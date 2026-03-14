/**
 * Keyboard event detection helpers for terminal pane scope isolation.
 *
 * These pure functions determine which keyboard events should bypass
 * ghostty-web and bubble to the global hotkey layer (TanStack Hotkeys on
 * document). They are used by `TerminalPane.attachCustomKeyEventHandler`
 * to let panel shortcuts work even when a terminal has focus.
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

/**
 * Check if a keyboard event should bypass ghostty-web and bubble to
 * the global hotkey layer (TanStack Hotkeys on document).
 *
 * Returns true if the event should be passed through (ghostty-web ignores it).
 */
const shouldBypassTerminal = (event: KeyboardEvent): boolean =>
  isExactMetaW(event) || isMetaShiftEnter(event) || isExactCtrlB(event)

export { isExactCtrlB, isExactMetaW, isMetaShiftEnter, shouldBypassTerminal }
