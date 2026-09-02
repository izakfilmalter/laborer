/**
 * What a focused terminal claims before the app's global hotkeys see a key.
 *
 * Ghostty's key encoder handles nearly everything: Kitty progressive
 * enhancement, legacy CSI, Ctrl chords, IME. Two macOS gestures fall outside
 * it, because they are conventions of the *host* rather than of the terminal
 * protocol:
 *
 * - Option+Arrow and Cmd+Arrow, which Terminal.app and VS Code translate to
 *   readline word and line navigation. Ghostty's encoder emits modified CSI
 *   sequences (`ESC[1;3D`) that many shells and TUIs do not bind, and no
 *   sequence at all for Super, so the reading here is deliberate.
 * - Ctrl+B, which is Laborer's panel prefix everywhere except inside a focused
 *   terminal, where it is readline's backward-char. Ghostty encodes it
 *   correctly; it only has to be kept out of the app-level bypass.
 *
 * Find (Cmd/Ctrl+F, Cmd/Ctrl+G) is claimed here too. It belongs to the pane
 * that has focus rather than to the window, so it never reaches the app-level
 * hotkeys — and never reaches the PTY either.
 *
 * The result feeds `GhosttyTerminalSurface`'s `beforeKey`: `true` lets Ghostty
 * encode and send the key, `false` leaves it to bubble to the global hotkey
 * layer — or drops it, when this module has already sent something in its
 * place.
 *
 * @see apps/web/src/panes/terminal-pane.tsx — installs this as `beforeKey`
 * @see apps/web/src/lib/keybinds.ts — the app-level bypass list
 */

import {
  IS_MAC,
  isPrefixKey,
  isTerminalFindNextShortcut,
  isTerminalFindPreviousShortcut,
  isTerminalFindShortcut,
} from './keybinds'

const BEGINNING_OF_LINE = '\x01'
const END_OF_LINE = '\x05'
const BACKWARD_WORD = '\x1bb'
const FORWARD_WORD = '\x1bf'

const COMMAND_ARROW_INPUT: Readonly<Record<string, string>> = {
  ArrowLeft: BEGINNING_OF_LINE,
  ArrowRight: END_OF_LINE,
}
const OPTION_ARROW_INPUT: Readonly<Record<string, string>> = {
  ArrowLeft: BACKWARD_WORD,
  ArrowRight: FORWARD_WORD,
}

/**
 * Readline input for a macOS arrow chord, or `undefined` when the key belongs
 * to Ghostty's encoder.
 *
 * Cmd+Option+Arrow is Laborer's directional pane navigation, so each mapping
 * requires its own modifier and rejects the other.
 */
function getTerminalInputOverride(
  event: KeyboardEvent,
  isMac = IS_MAC
): string | undefined {
  if (!isMac || event.shiftKey) {
    return undefined
  }

  if (event.metaKey && !(event.altKey || event.ctrlKey)) {
    return COMMAND_ARROW_INPUT[event.key]
  }

  if (event.altKey && !(event.ctrlKey || event.metaKey)) {
    return OPTION_ARROW_INPUT[event.key]
  }

  return undefined
}

/** What a find shortcut asks the pane's find bar to do. */
type TerminalFindRequest = 'open' | 'next' | 'previous'

interface TerminalKeyEventHandlers {
  readonly isRunning: boolean
  /**
   * The pane's find bar. Find is terminal-local — it never reaches the global
   * hotkey layer — so a pane without one leaves the keys to Ghostty.
   */
  readonly onFind?: ((request: TerminalFindRequest) => void) | undefined
  readonly send: (data: string) => void
  readonly shouldBypass: (event: KeyboardEvent) => boolean
}

/**
 * The find request a keydown carries, if any. Previous is checked first: it is
 * the next-match chord plus Shift.
 */
function getTerminalFindRequest(
  event: KeyboardEvent
): TerminalFindRequest | undefined {
  if (isTerminalFindShortcut(event)) {
    return 'open'
  }
  if (isTerminalFindPreviousShortcut(event)) {
    return 'previous'
  }
  if (isTerminalFindNextShortcut(event)) {
    return 'next'
  }
  return undefined
}

/**
 * Decide who owns a keydown over a focused terminal.
 *
 * Returns `true` when Ghostty should encode and send it, `false` when the
 * terminal must not — either because this module already sent a replacement,
 * or because the key is an app-level shortcut that has to reach the document.
 */
function handleTerminalKeyEvent(
  event: KeyboardEvent,
  handlers: TerminalKeyEventHandlers,
  isMac = IS_MAC
): boolean {
  const input = getTerminalInputOverride(event, isMac)
  if (input !== undefined) {
    event.preventDefault()
    event.stopPropagation()
    if (handlers.isRunning) {
      handlers.send(input)
    }
    return false
  }

  const find = handlers.onFind ? getTerminalFindRequest(event) : undefined
  if (find !== undefined) {
    event.preventDefault()
    event.stopPropagation()
    handlers.onFind?.(find)
    return false
  }

  // The panel prefix belongs to the terminal while the terminal has focus, so
  // it is asked about before the bypass list it appears on.
  if (isPrefixKey(event)) {
    return true
  }

  return !handlers.shouldBypass(event)
}

export type { TerminalFindRequest, TerminalKeyEventHandlers }
export {
  getTerminalFindRequest,
  getTerminalInputOverride,
  handleTerminalKeyEvent,
}
