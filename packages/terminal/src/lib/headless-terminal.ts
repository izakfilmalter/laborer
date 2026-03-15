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
 * - Detects terminal title changes via OSC 0/2 escape sequences for
 *   process activity tracking (idle vs running)
 * - Detects semantic prompt markers via OSC 133 (FinalTerm protocol)
 *   for instant idle/running detection in compatible shells
 *
 * OSC-based activity detection follows the Mux pattern
 * (.reference/mux/src/node/services/terminalService.ts):
 * - OSC 0/2 title changes are classified as idle (shell name, cwd, user@host)
 *   or running (command name like "vim", "opencode", etc.)
 * - OSC 133 semantic prompt markers (A = prompt start = idle,
 *   C = command start = running) provide precise idle/running transitions
 * - Uses `parser.registerOscHandler()` instead of `onTitleChange` because
 *   xterm v6's headless mode doesn't reliably fire the onTitleChange event
 *
 * @see PRD-ghostty-web-migration.md — Module 1: Backend: Headless Terminal State Manager
 * @see Issue #7: Backend: Headless terminal state manager
 * @see .reference/mux/src/node/services/terminalService.ts — OSC title detection
 */

import { SerializeAddon } from '@xterm/addon-serialize'
import XtermHeadless from '@xterm/headless'

const { Terminal } = XtermHeadless

/**
 * Per-terminal headless state. Tracks the headless xterm instance,
 * serialization addon, and disposables for the onData handler
 * (device query responses) and OSC title/prompt handlers.
 */
interface HeadlessTerminalState {
  readonly onDataDisposable: { dispose: () => void }
  readonly oscDisposable: { dispose: () => void }
  readonly serializeAddon: SerializeAddon
  readonly terminal: InstanceType<typeof Terminal>
}

/**
 * Callback for writing device query responses back to the PTY.
 * Called when the headless terminal generates responses to DA1/DSR queries.
 */
type PtyWriteCallback = (data: string) => void

/**
 * Callback for terminal title changes detected via OSC 0/2 escape sequences.
 * Called when the shell or a running program sets the terminal title.
 * The title string is the raw value from the OSC sequence.
 */
type TitleChangeCallback = (terminalId: string, title: string) => void

/**
 * Callback for semantic prompt markers detected via OSC 133 escape sequences.
 * Called when a compatible shell (fish, zsh with plugins) emits FinalTerm
 * prompt protocol markers.
 *
 * - `'idle'` — marker A (prompt start): shell is waiting for input
 * - `'running'` — marker C (command start): a command is executing
 */
type PromptStateCallback = (
  terminalId: string,
  state: 'idle' | 'running'
) => void

/**
 * Manages headless xterm terminal instances for screen state serialization,
 * backend device query handling, and OSC-based activity detection.
 *
 * Usage:
 * ```ts
 * const manager = createHeadlessTerminalManager({
 *   onTitleChange: (terminalId, title) => { ... },
 *   onPromptState: (terminalId, state) => { ... },
 * })
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
   * Initializes `@xterm/headless` with `@xterm/addon-serialize`,
   * wires the `onData` handler to forward device query responses
   * (DA1/DSR) back to the PTY, and registers OSC handlers for
   * title changes (OSC 0/2) and semantic prompt markers (OSC 133).
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
 * Options for the HeadlessTerminalManager factory.
 */
interface HeadlessTerminalManagerOptions {
  /**
   * Called when an OSC 133 semantic prompt marker is detected.
   * Compatible shells (fish, zsh with plugins) emit these markers to
   * indicate prompt start (idle) or command start (running).
   */
  readonly onPromptState?: PromptStateCallback | undefined
  /**
   * Called when an OSC 0/2 title change is detected in the headless terminal.
   * The title string is the raw value from the escape sequence, e.g. "opencode"
   * when running OpenCode, or "~/project" when idle at a shell prompt.
   */
  readonly onTitleChange?: TitleChangeCallback | undefined
}

/**
 * Create a new HeadlessTerminalManager instance.
 *
 * The manager maintains headless xterm instances in an internal Map.
 * Each instance mirrors PTY output for screen state serialization,
 * responds to device queries on the backend, and detects terminal
 * title changes and semantic prompt markers via OSC escape sequences.
 *
 * @param options - Optional callbacks for title changes and prompt state
 */
const createHeadlessTerminalManager = (
  options?: HeadlessTerminalManagerOptions
): HeadlessTerminalManager => {
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
      existing.oscDisposable.dispose()
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

    // Register OSC handlers for title changes and semantic prompt
    // markers. Uses parser.registerOscHandler() instead of onTitleChange
    // because xterm v6's headless mode doesn't reliably fire the
    // onTitleChange event (see Mux's comment in terminalService.ts).
    const oscDisposables: Array<{ dispose: () => void }> = []

    if (options?.onTitleChange !== undefined) {
      const titleCallback = options.onTitleChange
      const handleTitleOsc = (data: string): boolean => {
        titleCallback(terminalId, data)
        return false // don't consume — let xterm's internal handler also process
      }
      oscDisposables.push(terminal.parser.registerOscHandler(0, handleTitleOsc))
      oscDisposables.push(terminal.parser.registerOscHandler(2, handleTitleOsc))
    }

    if (options?.onPromptState !== undefined) {
      const promptCallback = options.onPromptState
      const handlePromptOsc = (data: string): boolean => {
        // OSC 133 markers: A = prompt start (idle), C = command start (running)
        const marker = data.split(';', 1)[0]?.trim()
        if (marker === 'A') {
          promptCallback(terminalId, 'idle')
        } else if (marker === 'C') {
          promptCallback(terminalId, 'running')
        }
        return false
      }
      oscDisposables.push(
        terminal.parser.registerOscHandler(133, handlePromptOsc)
      )
    }

    const oscDisposable = {
      dispose: () => {
        for (const d of oscDisposables) {
          d.dispose()
        }
      },
    }

    const serializeAddon = new SerializeAddon()
    terminal.loadAddon(serializeAddon)

    terminals.set(terminalId, {
      terminal,
      serializeAddon,
      onDataDisposable,
      oscDisposable,
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
      state.oscDisposable.dispose()
      state.terminal.dispose()
      terminals.delete(terminalId)
    }
  }

  const disposeAll = (): void => {
    for (const [terminalId, state] of terminals) {
      state.onDataDisposable.dispose()
      state.oscDisposable.dispose()
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
export type {
  HeadlessTerminalManager,
  HeadlessTerminalManagerOptions,
  PromptStateCallback,
  PtyWriteCallback,
  TitleChangeCallback,
}
