/**
 * Headless Terminal State Manager
 *
 * Manages headless xterm instances (one per terminal session) that mirror
 * all PTY output. Provides compact screen state serialization (~4KB) via
 * `@xterm/addon-serialize`, replacing the 5MB ring buffer replay for
 * reconnection.
 *
 * Each headless terminal:
 * - Receives all PTY output in parallel with live subscribers
 * - Responds to device queries (DA1/DSR) by forwarding responses to the PTY
 * - Is resized in sync with the real PTY
 * - Provides `getScreenState()` for compact VT escape sequence serialization
 *
 * @see PRD-ghostty-web-migration.md — Module 1: Backend: Headless Terminal State Manager
 * @see Issue #7: Backend: Headless terminal state manager
 */

import { SerializeAddon } from '@xterm/addon-serialize'
import XtermHeadless from '@xterm/headless'

const { Terminal } = XtermHeadless

/**
 * Per-terminal headless state. Tracks the headless xterm instance,
 * serialization addon, and the disposable for the onData handler
 * (device query responses).
 */
interface HeadlessTerminalState {
  readonly onDataDisposable: { dispose: () => void }
  readonly serializeAddon: SerializeAddon
  readonly terminal: InstanceType<typeof Terminal>
}

/**
 * Callback for writing device query responses back to the PTY.
 * Called when the headless terminal generates responses to DA1/DSR queries.
 */
type PtyWriteCallback = (data: string) => void

/**
 * Manages headless xterm terminal instances for screen state serialization
 * and backend device query handling.
 *
 * Usage:
 * ```ts
 * const manager = createHeadlessTerminalManager()
 * manager.create('term-1', 80, 24, (data) => ptyWrite(termId, data))
 * manager.write('term-1', ptyOutputData)
 * const screenState = manager.getScreenState('term-1')
 * manager.resize('term-1', 120, 40)
 * manager.dispose('term-1')
 * ```
 */
interface HeadlessTerminalManager {
  /**
   * Create a headless terminal for the given terminal ID.
   * Initializes `@xterm/headless` with `@xterm/addon-serialize` and
   * wires the `onData` handler to forward device query responses
   * (DA1/DSR) back to the PTY.
   */
  readonly create: (
    terminalId: string,
    cols: number,
    rows: number,
    ptyWrite: PtyWriteCallback
  ) => void

  /**
   * Dispose and remove the headless terminal for the given terminal ID.
   * Cleans up the xterm instance, serialize addon, and onData handler.
   * No-op if the terminal does not exist.
   */
  readonly dispose: (terminalId: string) => void

  /**
   * Dispose all headless terminals. Called during shutdown.
   */
  readonly disposeAll: () => void

  /**
   * Get the serialized screen state for a terminal as a VT escape
   * sequence string. Returns an empty string if the terminal does not
   * exist or has no output.
   *
   * The serialized state is ~4KB (vs 5MB raw ring buffer) and includes:
   * - Current screen content with colors and attributes
   * - Cursor position
   * - Alternate screen mode switch (`\x1b[?1049h`) if active
   */
  readonly getScreenState: (terminalId: string) => string

  /**
   * Resize the headless terminal to match new PTY dimensions.
   * Must be called whenever the real PTY is resized to keep the
   * serialized state dimensionally accurate.
   * No-op if the terminal does not exist.
   */
  readonly resize: (terminalId: string, cols: number, rows: number) => void

  /**
   * Write PTY output data to the headless terminal.
   * The headless terminal parses the data to maintain screen state.
   * No-op if the terminal does not exist.
   */
  readonly write: (terminalId: string, data: string) => void
}

/**
 * Create a new HeadlessTerminalManager instance.
 *
 * The manager maintains headless xterm instances in an internal Map.
 * Each instance mirrors PTY output for screen state serialization and
 * responds to device queries on the backend.
 */
const createHeadlessTerminalManager = (): HeadlessTerminalManager => {
  const terminals = new Map<string, HeadlessTerminalState>()

  const create = (
    terminalId: string,
    cols: number,
    rows: number,
    ptyWrite: PtyWriteCallback
  ): void => {
    // Dispose existing instance if present (e.g., on restart)
    const existing = terminals.get(terminalId)
    if (existing !== undefined) {
      existing.onDataDisposable.dispose()
      existing.terminal.dispose()
    }

    const terminal = new Terminal({
      allowProposedApi: true,
      cols,
      rows,
    })

    // Forward device query responses (DA1/DSR) from the headless
    // terminal back to the PTY. TUI applications send these queries
    // to detect terminal capabilities; the headless terminal provides
    // responses even before the frontend renderer mounts.
    const onDataDisposable = terminal.onData((data: string) => {
      ptyWrite(data)
    })

    const serializeAddon = new SerializeAddon()
    terminal.loadAddon(serializeAddon)

    terminals.set(terminalId, {
      terminal,
      serializeAddon,
      onDataDisposable,
    })
  }

  const write = (terminalId: string, data: string): void => {
    const state = terminals.get(terminalId)
    if (state !== undefined) {
      state.terminal.write(data)
    }
  }

  const getScreenState = (terminalId: string): string => {
    const state = terminals.get(terminalId)
    if (state === undefined) {
      return ''
    }
    return state.serializeAddon.serialize()
  }

  const resize = (terminalId: string, cols: number, rows: number): void => {
    const state = terminals.get(terminalId)
    if (state !== undefined) {
      state.terminal.resize(cols, rows)
    }
  }

  const dispose = (terminalId: string): void => {
    const state = terminals.get(terminalId)
    if (state !== undefined) {
      state.onDataDisposable.dispose()
      state.terminal.dispose()
      terminals.delete(terminalId)
    }
  }

  const disposeAll = (): void => {
    for (const [terminalId, state] of terminals) {
      state.onDataDisposable.dispose()
      state.terminal.dispose()
      terminals.delete(terminalId)
    }
  }

  return {
    create,
    write,
    getScreenState,
    resize,
    dispose,
    disposeAll,
  }
}

export { createHeadlessTerminalManager }
export type { HeadlessTerminalManager, PtyWriteCallback }
