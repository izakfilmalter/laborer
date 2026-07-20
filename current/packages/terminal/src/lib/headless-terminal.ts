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
 * - Uses `disableStdin: true` to suppress device query responses
 *   (DA1/DSR) — only the renderer xterm.js handles these (matches
 *   VS Code's pattern where the headless XtermSerializer never
 *   subscribes to onData)
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
import type {
  SerializedCommandDetectionCapability,
  SerializedPromptInputModel,
  SerializedTerminalCommand,
} from '../services/terminal-session-persistence.js'

const { Terminal } = XtermHeadless

interface InFlightCommand {
  command: string
  commandLineConfidence: 'low' | 'medium' | 'high'
  cwd?: string | undefined
  isTrusted: boolean
  timestamp: number
}

interface HeadlessCommandState {
  commands: SerializedTerminalCommand[]
  currentCommand?: InFlightCommand | undefined
  cwd?: string | undefined
  hasRichCommandDetection: boolean
  isWindowsPty: boolean
  promptInputModel?:
    | {
        continuationPrompt?: string | undefined
        cursorIndex: number
        lastPromptLine?: string | undefined
        value: string
      }
    | undefined
}

const ESCAPE_CHARACTER = String.fromCharCode(0x1b)
const ANSI_SGR_SEQUENCE_REGEX = new RegExp(
  `${ESCAPE_CHARACTER}\\[[0-9;]*m`,
  'g'
)

const getPromptTerminator = (prompt: string): string => {
  const sanitizedPrompt = prompt.replace(ANSI_SGR_SEQUENCE_REGEX, '')
  const lastPromptLine = sanitizedPrompt.slice(
    sanitizedPrompt.lastIndexOf('\n') + 1
  )
  const trimmedLastPromptLine = lastPromptLine.trim()

  if (trimmedLastPromptLine.length <= 1) {
    return lastPromptLine
  }

  const trimmedPromptLine = lastPromptLine.trimEnd()
  const lastSpaceIndex = trimmedPromptLine.lastIndexOf(' ')
  return lastSpaceIndex === -1
    ? lastPromptLine
    : lastPromptLine.slice(lastSpaceIndex)
}

const deserializeVsCodeOscValue = (value: string): string =>
  value.replace(/\\(x[0-9a-fA-F]{2}|\\)/g, (match, escaped) => {
    if (escaped === '\\') {
      return '\\'
    }

    if (typeof escaped === 'string' && escaped.startsWith('x')) {
      return String.fromCharCode(Number.parseInt(escaped.slice(1), 16))
    }

    return match
  })

const createEmptyCommandState = (): HeadlessCommandState => ({
  commands: [],
  hasRichCommandDetection: false,
  isWindowsPty: false,
})

const parseBooleanOscProperty = (value: string): boolean => value === 'True'

const updatePromptInputModel = (
  commandState: HeadlessCommandState,
  updates: Partial<NonNullable<HeadlessCommandState['promptInputModel']>>
): void => {
  commandState.promptInputModel = {
    value: updates.value ?? commandState.promptInputModel?.value ?? '',
    cursorIndex:
      updates.cursorIndex ?? commandState.promptInputModel?.cursorIndex ?? 0,
    continuationPrompt:
      updates.continuationPrompt ??
      commandState.promptInputModel?.continuationPrompt,
    lastPromptLine:
      updates.lastPromptLine ?? commandState.promptInputModel?.lastPromptLine,
  }
}

const serializePromptInputModel = (
  promptInputModel: HeadlessCommandState['promptInputModel']
): SerializedPromptInputModel | undefined => {
  if (promptInputModel === undefined) {
    return undefined
  }

  return {
    value: promptInputModel.value,
    cursorIndex: promptInputModel.cursorIndex,
    ...(promptInputModel.continuationPrompt === undefined
      ? {}
      : { continuationPrompt: promptInputModel.continuationPrompt }),
    ...(promptInputModel.lastPromptLine === undefined
      ? {}
      : { lastPromptLine: promptInputModel.lastPromptLine }),
  }
}

const serializeCurrentCommand = (
  currentCommand: InFlightCommand | undefined
): SerializedTerminalCommand | undefined => {
  if (currentCommand === undefined) {
    return undefined
  }

  return {
    command: currentCommand.command,
    commandLineConfidence: currentCommand.commandLineConfidence,
    duration: 0,
    isTrusted: currentCommand.isTrusted,
    timestamp: currentCommand.timestamp,
    ...(currentCommand.cwd === undefined ? {} : { cwd: currentCommand.cwd }),
  }
}

const handleVsCodeOscSequence = (
  commandState: HeadlessCommandState,
  data: string,
  shellIntegrationNonce?: string | undefined
): void => {
  const argsIndex = data.indexOf(';')
  const command = argsIndex === -1 ? data : data.slice(0, argsIndex)
  const args = argsIndex === -1 ? [] : data.slice(argsIndex + 1).split(';')

  switch (command) {
    case 'B': {
      updatePromptInputModel(commandState, {
        value: '',
        cursorIndex: 0,
      })
      commandState.currentCommand = {
        command: '',
        commandLineConfidence: 'low',
        cwd: commandState.cwd,
        isTrusted: false,
        timestamp: Date.now(),
      }
      return
    }

    case 'D': {
      const currentCommand = commandState.currentCommand
      if (currentCommand === undefined) {
        return
      }

      const [exitCodeRaw] = args
      commandState.commands.push({
        command: currentCommand.command,
        commandLineConfidence: currentCommand.commandLineConfidence,
        cwd: currentCommand.cwd,
        duration: Math.max(0, Date.now() - currentCommand.timestamp),
        exitCode:
          exitCodeRaw === undefined
            ? undefined
            : Number.parseInt(exitCodeRaw, 10),
        isTrusted: currentCommand.isTrusted,
        timestamp: currentCommand.timestamp,
      })
      commandState.currentCommand = undefined
      return
    }

    case 'E': {
      const [commandLineRaw, nonce] = args
      const currentCommand =
        commandState.currentCommand ??
        ({
          command: '',
          commandLineConfidence: 'low',
          cwd: commandState.cwd,
          isTrusted: false,
          timestamp: Date.now(),
        } satisfies InFlightCommand)

      currentCommand.command =
        commandLineRaw === undefined
          ? ''
          : deserializeVsCodeOscValue(commandLineRaw)
      currentCommand.commandLineConfidence = 'high'
      currentCommand.isTrusted =
        shellIntegrationNonce !== undefined && nonce === shellIntegrationNonce
      updatePromptInputModel(commandState, {
        value: currentCommand.command,
        cursorIndex: currentCommand.command.length,
      })
      commandState.currentCommand = currentCommand
      return
    }

    case 'P': {
      const [propertyAssignment] = args
      if (propertyAssignment === undefined) {
        return
      }

      const equalsIndex = propertyAssignment.indexOf('=')
      if (equalsIndex === -1) {
        return
      }

      const property = propertyAssignment.slice(0, equalsIndex)
      const value = deserializeVsCodeOscValue(
        propertyAssignment.slice(equalsIndex + 1)
      )

      switch (property) {
        case 'Cwd': {
          commandState.cwd = value
          if (commandState.currentCommand !== undefined) {
            commandState.currentCommand.cwd = commandState.cwd
          }
          return
        }

        case 'ContinuationPrompt': {
          updatePromptInputModel(commandState, { continuationPrompt: value })
          return
        }

        case 'HasRichCommandDetection': {
          commandState.hasRichCommandDetection = parseBooleanOscProperty(value)
          return
        }

        case 'IsWindows': {
          commandState.isWindowsPty = parseBooleanOscProperty(value)
          return
        }

        case 'Prompt': {
          updatePromptInputModel(commandState, {
            lastPromptLine: getPromptTerminator(value),
          })
          return
        }

        default:
          return
      }
    }

    default:
      return
  }
}

/**
 * Per-terminal headless state. Tracks the headless xterm instance,
 * serialization addon, and disposables for OSC title/prompt handlers.
 *
 * The headless terminal uses `disableStdin: true` to suppress device
 * query responses (DA1/DSR). This matches VS Code's pattern where only
 * the renderer xterm.js generates responses — the headless terminal is
 * a passive mirror. Without this, both the headless and renderer xterm
 * would respond to DA1/DSR queries, causing duplicate responses that
 * corrupt TUI rendering.
 */
interface HeadlessTerminalState {
  readonly commandState: HeadlessCommandState
  readonly oscDisposable: { dispose: () => void }
  readonly serializeAddon: SerializeAddon
  readonly terminal: InstanceType<typeof Terminal>
}

/**
 * @deprecated No longer used — the headless terminal no longer generates
 * device query responses. Kept for API compatibility with existing callers
 * until they are updated.
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
   * Initializes `@xterm/headless` with `@xterm/addon-serialize` and
   * `disableStdin: true` (no device query responses), and registers
   * OSC handlers for title changes (OSC 0/2) and semantic prompt
   * markers (OSC 133).
   *
   * The `ptyWrite` parameter is accepted for API compatibility but
   * is no longer used — device query responses are handled exclusively
   * by the renderer xterm.js (matching VS Code's pattern).
   */
  readonly create: (
    terminalId: string,
    cols: number,
    rows: number,
    ptyWrite?: PtyWriteCallback
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

  /** Get serialized command detection state inferred from shell integration. */
  readonly getCommandDetectionState: (
    terminalId: string
  ) => SerializedCommandDetectionCapability | undefined

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
  /** Optional nonce used to verify trusted VS Code shell integration command lines. */
  readonly shellIntegrationNonce?: string | undefined
}

/**
 * Create a new HeadlessTerminalManager instance.
 *
 * The manager maintains headless xterm instances in an internal Map.
 * Each instance mirrors PTY output for screen state serialization
 * and detects terminal title changes and semantic prompt markers
 * via OSC escape sequences. Device query responses (DA1/DSR) are
 * suppressed via `disableStdin: true` — only the renderer xterm.js
 * handles them.
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
    _ptyWrite?: PtyWriteCallback
  ): void => {
    // Dispose existing instance if present (e.g., on restart)
    const existing = terminals.get(terminalId)
    if (existing !== undefined) {
      existing.oscDisposable.dispose()
      existing.terminal.dispose()
    }

    const terminal = new Terminal({
      allowProposedApi: true,
      cols,
      rows,
      // Suppress device query responses (DA1/DSR). The renderer
      // xterm.js handles these exclusively. Without this, both
      // headless and renderer xterm would respond to DA1/DSR
      // queries, causing duplicate responses that corrupt TUI
      // rendering (e.g., OpenCode's alternate screen redraws).
      // This matches VS Code's pattern where the headless xterm
      // (XtermSerializer) never subscribes to onData.
      disableStdin: true,
    })

    // Register OSC handlers for title changes and semantic prompt
    // markers. Uses parser.registerOscHandler() instead of onTitleChange
    // because xterm v6's headless mode doesn't reliably fire the
    // onTitleChange event (see Mux's comment in terminalService.ts).
    const oscDisposables: Array<{ dispose: () => void }> = []
    const commandState = createEmptyCommandState()

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

    oscDisposables.push(
      terminal.parser.registerOscHandler(633, (data: string): boolean => {
        handleVsCodeOscSequence(
          commandState,
          data,
          options?.shellIntegrationNonce
        )
        return false
      })
    )

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
      commandState,
      terminal,
      serializeAddon,
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

  const getCommandDetectionState = (
    terminalId: string
  ): SerializedCommandDetectionCapability | undefined => {
    const state = terminals.get(terminalId)
    if (state === undefined) {
      return undefined
    }

    return {
      isWindowsPty: state.commandState.isWindowsPty,
      hasRichCommandDetection: state.commandState.hasRichCommandDetection,
      commands: [
        ...state.commandState.commands,
        ...(() => {
          const currentCommand = serializeCurrentCommand(
            state.commandState.currentCommand
          )
          return currentCommand === undefined ? [] : [currentCommand]
        })(),
      ],
      promptInputModel: serializePromptInputModel(
        state.commandState.promptInputModel
      ),
    }
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
      state.oscDisposable.dispose()
      state.terminal.dispose()
      terminals.delete(terminalId)
    }
  }

  const disposeAll = (): void => {
    for (const [terminalId, state] of terminals) {
      state.oscDisposable.dispose()
      state.terminal.dispose()
      terminals.delete(terminalId)
    }
  }

  return {
    create,
    write,
    getScreenState,
    getCommandDetectionState,
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
