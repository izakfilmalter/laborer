import { IS_MAC } from './keybinds'

const BACKWARD_CHARACTER = '\x02'
const FORWARD_CHARACTER = '\x06'
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

function getControlNavigationInput(event: KeyboardEvent): string | undefined {
  if (!(event.ctrlKey && !event.altKey) || event.metaKey) {
    return undefined
  }
  if (event.key.toLowerCase() === 'b') {
    return BACKWARD_CHARACTER
  }
  if (event.key.toLowerCase() === 'f') {
    return FORWARD_CHARACTER
  }
  return undefined
}

function getMacArrowNavigationInput(event: KeyboardEvent): string | undefined {
  if (event.metaKey && !(event.altKey || event.ctrlKey)) {
    return COMMAND_ARROW_INPUT[event.key]
  }

  if (event.altKey && !(event.ctrlKey || event.metaKey)) {
    return OPTION_ARROW_INPUT[event.key]
  }

  return undefined
}

/**
 * Return shell-friendly input for keys that xterm or the app would otherwise
 * encode or consume differently from a native terminal.
 *
 * macOS Option+Arrow and Cmd+Arrow are intentionally translated to the same
 * word and line navigation used by Terminal.app and VS Code. Physical Ctrl+B
 * belongs to the terminal while it is focused, rather than Laborer's panel
 * prefix shortcut.
 */
function getTerminalInputOverride(
  event: KeyboardEvent,
  isMac = IS_MAC
): string | undefined {
  if (event.type !== 'keydown' || event.shiftKey) {
    return undefined
  }

  const controlInput = getControlNavigationInput(event)
  if (controlInput !== undefined) {
    // Ctrl+F remains the terminal-find shortcut outside macOS.
    return isMac || controlInput === BACKWARD_CHARACTER
      ? controlInput
      : undefined
  }

  return isMac ? getMacArrowNavigationInput(event) : undefined
}

function handleTerminalInputOverride(
  event: KeyboardEvent,
  isRunning: boolean,
  send: (data: string) => void,
  isMac = IS_MAC
): boolean {
  const input = getTerminalInputOverride(event, isMac)
  if (input === undefined) {
    return false
  }

  event.preventDefault()
  event.stopPropagation()
  if (isRunning) {
    send(input)
  }
  return true
}

interface TerminalKeyEventHandlers {
  readonly handleTerminalLocalShortcut: (event: KeyboardEvent) => boolean
  readonly isRunning: boolean
  readonly send: (data: string) => void
  readonly shouldBypass: (event: KeyboardEvent) => boolean
}

/** Apply terminal-owned input before considering app-level shortcuts. */
function handleTerminalKeyEvent(
  event: KeyboardEvent,
  handlers: TerminalKeyEventHandlers,
  isMac = IS_MAC
): boolean {
  if (event.type !== 'keydown') {
    return true
  }

  if (
    handleTerminalInputOverride(event, handlers.isRunning, handlers.send, isMac)
  ) {
    return false
  }

  if (handlers.shouldBypass(event)) {
    return false
  }

  return !handlers.handleTerminalLocalShortcut(event)
}

export type { TerminalKeyEventHandlers }
export {
  getTerminalInputOverride,
  handleTerminalInputOverride,
  handleTerminalKeyEvent,
}
