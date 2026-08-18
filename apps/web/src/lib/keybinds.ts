/**
 * Centralized keybind definitions and matching utilities.
 *
 * This file is the single source of truth for all keyboard shortcuts in the
 * application. When adding or modifying keybinds:
 * 1. Add the definition to the `KEYBINDS` constant below
 * 2. The terminal bypass logic in terminal-pane.tsx intercepts matching keys
 *    after giving terminal-native input overrides priority.
 *
 * Design follows the Mux pattern:
 * - `Keybind` type describes a shortcut declaratively
 * - `matchesKeybind()` checks a KeyboardEvent against a Keybind
 * - `KEYBINDS` constant enumerates every app-level shortcut
 * - Terminal clipboard and terminal-find shortcuts are defined separately
 *   since they are handled within the terminal rather than bubbled to the app
 *
 * @see apps/web/src/panes/terminal-pane.tsx — terminal key handler
 * @see apps/web/src/panels/panel-hotkeys.tsx — TanStack Hotkeys registration
 */

// ---------------------------------------------------------------------------
// Keybind type
// ---------------------------------------------------------------------------

/**
 * Declarative keyboard shortcut definition.
 *
 * Modifier booleans default to `false` when omitted. The `macCtrlBehavior`
 * field controls how `ctrl: true` is interpreted on macOS:
 * - `"either"` (default): accept Ctrl or Cmd
 * - `"command"`: require Cmd specifically
 * - `"control"`: require the physical Control key
 */
interface Keybind {
  /**
   * Allow Shift even when this keybind doesn't require it.
   * Useful for keyboard layouts where producing a character requires Shift.
   */
  readonly allowShift?: boolean
  readonly alt?: boolean
  /**
   * Optional physical key identifier (`KeyboardEvent.code`).
   * Use for shifted punctuation where `event.key` varies by layout.
   */
  readonly code?: string
  readonly ctrl?: boolean
  /** The `KeyboardEvent.key` value to match (case-insensitive). */
  readonly key: string
  /**
   * On macOS, Ctrl-based shortcuts traditionally use Cmd instead.
   * - `"either"` (default): accept Ctrl or Cmd
   * - `"command"`: require Cmd specifically
   * - `"control"`: require the physical Control key
   */
  readonly macCtrlBehavior?: 'either' | 'command' | 'control'
  readonly meta?: boolean
  readonly shift?: boolean
}

// ---------------------------------------------------------------------------
// Platform detection (module-level, evaluated once)
// ---------------------------------------------------------------------------

const IS_MAC =
  typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
const IS_WINDOWS =
  typeof navigator !== 'undefined' && navigator.platform.includes('Win')

// ---------------------------------------------------------------------------
// Keybind matching
// ---------------------------------------------------------------------------

/** Check if the event's key or code matches the keybind's expected key/code. */
function matchesKey(event: KeyboardEvent, keybind: Keybind): boolean {
  const expectedCode = keybind.code?.trim()
  if (expectedCode) {
    return (
      Boolean(event.code) &&
      event.code.toLowerCase() === expectedCode.toLowerCase()
    )
  }
  if (!event.key) {
    return false
  }
  return event.key.toLowerCase() === keybind.key.toLowerCase()
}

/**
 * Resolved modifier requirements after platform-specific Ctrl/Meta resolution.
 */
interface ModifierState {
  readonly ctrlAllowed: boolean
  readonly ctrlRequired: boolean
  readonly metaAllowed: boolean
  readonly metaRequired: boolean
}

/**
 * Resolve Ctrl/Meta modifier requirements from a keybind definition,
 * applying macOS-specific behavior based on `macCtrlBehavior`.
 */
function resolveCtrlMetaRequirements(keybind: Keybind): ModifierState {
  const base = keybind.meta ?? false

  if (!keybind.ctrl) {
    return {
      ctrlRequired: false,
      ctrlAllowed: false,
      metaRequired: base,
      metaAllowed: base,
    }
  }

  if (!IS_MAC) {
    return {
      ctrlRequired: true,
      ctrlAllowed: true,
      metaRequired: base,
      metaAllowed: base,
    }
  }

  const behavior = keybind.macCtrlBehavior ?? 'either'

  if (behavior === 'control') {
    return {
      ctrlRequired: true,
      ctrlAllowed: true,
      metaRequired: base,
      metaAllowed: base,
    }
  }

  if (behavior === 'command') {
    return {
      ctrlRequired: false,
      ctrlAllowed: true,
      metaRequired: true,
      metaAllowed: true,
    }
  }

  // "either" — accept Ctrl or Cmd on macOS
  return {
    ctrlRequired: false,
    ctrlAllowed: true,
    metaRequired: false,
    metaAllowed: true,
  }
}

/**
 * Check if the event's Ctrl and Meta state matches the keybind's requirements.
 */
function matchesCtrlMeta(event: KeyboardEvent, keybind: Keybind): boolean {
  const state = resolveCtrlMetaRequirements(keybind)

  // For "either" on macOS, at least one of Ctrl/Meta must be pressed
  const behavior = keybind.macCtrlBehavior ?? 'either'
  if (
    IS_MAC &&
    keybind.ctrl &&
    behavior === 'either' &&
    !(event.ctrlKey || event.metaKey)
  ) {
    return false
  }

  if (state.ctrlRequired && !event.ctrlKey) {
    return false
  }
  if (!state.ctrlAllowed && event.ctrlKey) {
    return false
  }
  if (state.metaRequired && !event.metaKey) {
    return false
  }
  if (!state.metaAllowed && event.metaKey) {
    return false
  }

  return true
}

/**
 * Check if a keyboard event matches a keybind definition.
 *
 * On macOS, `ctrl: true` defaults to matching either Ctrl or Cmd unless
 * overridden via `macCtrlBehavior`.
 */
function matchesKeybind(event: KeyboardEvent, keybind: Keybind): boolean {
  if (!matchesKey(event, keybind)) {
    return false
  }
  if (!matchesCtrlMeta(event, keybind)) {
    return false
  }

  // --- Shift ---
  const allowShift = keybind.allowShift ?? false
  if (keybind.shift && !event.shiftKey) {
    return false
  }
  if (!(keybind.shift || allowShift) && event.shiftKey) {
    return false
  }

  // --- Alt ---
  if (keybind.alt && !event.altKey) {
    return false
  }
  if (!keybind.alt && event.altKey) {
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// App-level keybind definitions
// ---------------------------------------------------------------------------

/**
 * All app-level keyboard shortcuts.
 *
 * These are the shortcuts registered in panel-hotkeys.tsx via TanStack
 * Hotkeys. The terminal key handler uses this list to decide which keys
 * should bypass xterm.js and bubble to the global hotkey layer.
 *
 * Prefix-key sequences (Ctrl+B then action) are registered at the app level.
 * A focused terminal gives Ctrl+B to the PTY for Emacs/readline navigation;
 * the prefix remains available when focus is outside terminal input.
 */
const KEYBINDS = {
  // -- Panel splits --
  /** Cmd+D — split horizontal (shows type picker) */
  SPLIT_HORIZONTAL: { key: 'd', meta: true },
  /** Cmd+Shift+D — split vertical (shows type picker) */
  SPLIT_VERTICAL: { key: 'd', meta: true, shift: true },

  // -- Close --
  /** Cmd+W — progressive close chain */
  CLOSE: { key: 'w', meta: true },
  /** Cmd+Shift+W — close window tab */
  CLOSE_WINDOW_TAB: { key: 'w', meta: true, shift: true },

  // -- Fullscreen --
  /** Cmd+Shift+Enter — toggle fullscreen pane */
  TOGGLE_FULLSCREEN: { key: 'Enter', meta: true, shift: true },

  // -- Kanban board overlay --
  /** Cmd+K — toggle the kanban board overlay over the main panel area */
  TOGGLE_BOARD: { key: 'k', meta: true },

  // -- Push/Pull workspace --
  /** Cmd+P — push workspace */
  PUSH_WORKSPACE: { key: 'p', meta: true },
  /** Cmd+Shift+P — pull workspace */
  PULL_WORKSPACE: { key: 'p', meta: true, shift: true },

  // -- Window tabs --
  /** Cmd+T — new window tab */
  NEW_WINDOW_TAB: { key: 't', meta: true },
  /** Cmd+1-9 — switch window tab by index */
  WINDOW_TAB_1: { key: '1', meta: true },
  WINDOW_TAB_2: { key: '2', meta: true },
  WINDOW_TAB_3: { key: '3', meta: true },
  WINDOW_TAB_4: { key: '4', meta: true },
  WINDOW_TAB_5: { key: '5', meta: true },
  WINDOW_TAB_6: { key: '6', meta: true },
  WINDOW_TAB_7: { key: '7', meta: true },
  WINDOW_TAB_8: { key: '8', meta: true },
  WINDOW_TAB_9: { key: '9', meta: true },
  /** Cmd+Shift+[ / Cmd+Shift+] — cycle window tabs */
  WINDOW_TAB_PREV: {
    key: '{',
    code: 'BracketLeft',
    meta: true,
    shift: true,
    allowShift: true,
  },
  WINDOW_TAB_NEXT: {
    key: '}',
    code: 'BracketRight',
    meta: true,
    shift: true,
    allowShift: true,
  },

  // -- Directional pane navigation --
  /** Cmd+Option+Arrow — navigate to adjacent pane */
  NAV_LEFT: { key: 'ArrowLeft', meta: true, alt: true },
  NAV_RIGHT: { key: 'ArrowRight', meta: true, alt: true },
  NAV_UP: { key: 'ArrowUp', meta: true, alt: true },
  NAV_DOWN: { key: 'ArrowDown', meta: true, alt: true },

  // -- Prefix key --
  /** Ctrl+B — tmux-style prefix key (enters prefix mode) */
  PREFIX: { key: 'b', ctrl: true, macCtrlBehavior: 'control' as const },

  // -- Panel tabs --
  /** Ctrl+T — new panel tab (shows type picker) */
  NEW_PANEL_TAB: { key: 't', ctrl: true, macCtrlBehavior: 'control' as const },
  /** Ctrl+1-9 — switch panel tab by index */
  PANEL_TAB_1: { key: '1', ctrl: true, macCtrlBehavior: 'control' as const },
  PANEL_TAB_2: { key: '2', ctrl: true, macCtrlBehavior: 'control' as const },
  PANEL_TAB_3: { key: '3', ctrl: true, macCtrlBehavior: 'control' as const },
  PANEL_TAB_4: { key: '4', ctrl: true, macCtrlBehavior: 'control' as const },
  PANEL_TAB_5: { key: '5', ctrl: true, macCtrlBehavior: 'control' as const },
  PANEL_TAB_6: { key: '6', ctrl: true, macCtrlBehavior: 'control' as const },
  PANEL_TAB_7: { key: '7', ctrl: true, macCtrlBehavior: 'control' as const },
  PANEL_TAB_8: { key: '8', ctrl: true, macCtrlBehavior: 'control' as const },
  PANEL_TAB_9: { key: '9', ctrl: true, macCtrlBehavior: 'control' as const },
  /** Ctrl+Shift+[ / Ctrl+Shift+] — cycle panel tabs */
  PANEL_TAB_PREV: {
    key: '{',
    code: 'BracketLeft',
    ctrl: true,
    shift: true,
    allowShift: true,
    macCtrlBehavior: 'control' as const,
  },
  PANEL_TAB_NEXT: {
    key: '}',
    code: 'BracketRight',
    ctrl: true,
    shift: true,
    allowShift: true,
    macCtrlBehavior: 'control' as const,
  },
} as const satisfies Record<string, Keybind>

/**
 * All app-level keybinds as an array, for iteration in the terminal
 * bypass check. Computed once at module load.
 */
const APP_KEYBINDS: readonly Keybind[] = Object.values(KEYBINDS)

// ---------------------------------------------------------------------------
// Terminal clipboard keybinds
// ---------------------------------------------------------------------------

/**
 * Clipboard shortcuts handled by the terminal itself (not bubbled to the
 * app layer). These follow VS Code's integrated terminal conventions:
 * - macOS: Cmd+C/V
 * - Linux: Ctrl+Shift+C/V (Ctrl+C is SIGINT)
 * - Windows: Ctrl+C/V (copy only when selection exists)
 *
 * @see https://code.visualstudio.com/docs/terminal/basics#_copy-paste
 */
const CLIPBOARD_KEYBINDS = {
  PASTE_MAC: { key: 'v', meta: true },
  PASTE_LINUX: {
    key: 'v',
    ctrl: true,
    shift: true,
    macCtrlBehavior: 'control' as const,
  },
  PASTE_WINDOWS: { key: 'v', ctrl: true, macCtrlBehavior: 'control' as const },

  COPY_MAC: { key: 'c', meta: true },
  COPY_LINUX: {
    key: 'c',
    ctrl: true,
    shift: true,
    macCtrlBehavior: 'control' as const,
  },
  COPY_WINDOWS: { key: 'c', ctrl: true, macCtrlBehavior: 'control' as const },
} as const satisfies Record<string, Keybind>

// ---------------------------------------------------------------------------
// Terminal find keybinds
// ---------------------------------------------------------------------------

/**
 * Terminal-local find shortcuts handled directly inside terminal-pane.tsx.
 *
 * These intentionally do NOT bypass to the app-level hotkey layer because the
 * terminal pane owns the full interaction: open/focus the inline find bar and
 * navigate matches within the active xterm buffer.
 */
const TERMINAL_FIND_KEYBINDS = {
  FIND: { key: 'f', ctrl: true, macCtrlBehavior: 'command' as const },
  FIND_NEXT: { key: 'g', ctrl: true, macCtrlBehavior: 'command' as const },
  FIND_PREVIOUS: {
    key: 'g',
    ctrl: true,
    shift: true,
    macCtrlBehavior: 'command' as const,
  },
} as const satisfies Record<string, Keybind>

// ---------------------------------------------------------------------------
// Terminal-facing helpers
// ---------------------------------------------------------------------------

/**
 * Check if a keyboard event matches any app-level keybind that should
 * bypass the terminal and bubble to the global hotkey layer.
 */
function shouldBypassTerminal(event: KeyboardEvent): boolean {
  return APP_KEYBINDS.some((keybind) => matchesKeybind(event, keybind))
}

/** Check if the event is the tmux-style prefix key (Ctrl+B). */
function isPrefixKey(event: KeyboardEvent): boolean {
  return matchesKeybind(event, KEYBINDS.PREFIX)
}

/** Check if the event is a platform-appropriate paste shortcut. */
function isPasteShortcut(event: KeyboardEvent): boolean {
  if (IS_MAC) {
    return matchesKeybind(event, CLIPBOARD_KEYBINDS.PASTE_MAC)
  }
  if (IS_WINDOWS) {
    return matchesKeybind(event, CLIPBOARD_KEYBINDS.PASTE_WINDOWS)
  }
  return matchesKeybind(event, CLIPBOARD_KEYBINDS.PASTE_LINUX)
}

/**
 * Detect platform-appropriate copy shortcut.
 *
 * Returns `'linux'` when the event matches Ctrl+Shift+C on Linux (always
 * consumed to prevent SIGINT), `'copy'` for Mac/Windows copy shortcuts,
 * or `false` if no copy shortcut matched.
 */
function detectCopyShortcut(event: KeyboardEvent): 'linux' | 'copy' | false {
  if (IS_MAC && matchesKeybind(event, CLIPBOARD_KEYBINDS.COPY_MAC)) {
    return 'copy'
  }
  if (
    !(IS_MAC || IS_WINDOWS) &&
    matchesKeybind(event, CLIPBOARD_KEYBINDS.COPY_LINUX)
  ) {
    return 'linux'
  }
  if (IS_WINDOWS && matchesKeybind(event, CLIPBOARD_KEYBINDS.COPY_WINDOWS)) {
    return 'copy'
  }
  return false
}

/** Check if the event opens the terminal-local find UI. */
function isTerminalFindShortcut(event: KeyboardEvent): boolean {
  return matchesKeybind(event, TERMINAL_FIND_KEYBINDS.FIND)
}

/** Check if the event navigates to the next terminal-local find match. */
function isTerminalFindNextShortcut(event: KeyboardEvent): boolean {
  return matchesKeybind(event, TERMINAL_FIND_KEYBINDS.FIND_NEXT)
}

/** Check if the event navigates to the previous terminal-local find match. */
function isTerminalFindPreviousShortcut(event: KeyboardEvent): boolean {
  return matchesKeybind(event, TERMINAL_FIND_KEYBINDS.FIND_PREVIOUS)
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type { Keybind }
export {
  APP_KEYBINDS,
  CLIPBOARD_KEYBINDS,
  detectCopyShortcut,
  IS_MAC,
  IS_WINDOWS,
  isPasteShortcut,
  isPrefixKey,
  isTerminalFindNextShortcut,
  isTerminalFindPreviousShortcut,
  isTerminalFindShortcut,
  KEYBINDS,
  matchesKeybind,
  shouldBypassTerminal,
  TERMINAL_FIND_KEYBINDS,
}
