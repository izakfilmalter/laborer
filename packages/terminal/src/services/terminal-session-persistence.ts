/**
 * Terminal Session Persistence
 *
 * Provides terminal session persistence across utility process restarts
 * (both dev hot reload and crash recovery). Implements three components:
 *
 * 1. **Replay buffer** — A circular buffer per terminal that stores recent
 *    output. When the utility process restarts, the renderer receives
 *    replay data so terminals appear to continue seamlessly.
 *
 * 2. **Graceful shutdown serialization** — On SIGTERM, serializes active
 *    terminal metadata (id, command, args, cwd, env, workspaceId, cols,
 *    rows, replay buffer contents) to a temporary file.
 *
 * 3. **Startup restoration** — On startup, reads serialized state,
 *    respawns PTY processes with the same configuration, and provides
 *    replay data to the renderer via the data channel.
 *
 * On ungraceful termination (crash, SIGKILL), terminals are marked as
 * stopped in the renderer. The renderer retains its local xterm buffer,
 * showing last-known output even without replay.
 *
 * Follows VS Code's `PersistentTerminalProcess` pattern:
 * @see .reference/vscode/src/vs/platform/terminal/node/ptyService.ts line 343
 * @see Issue #18: Terminal session persistence across restarts
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default replay buffer size in bytes per terminal.
 * ~200KB is sufficient for ~1000 lines of typical terminal output.
 */
const DEFAULT_REPLAY_BUFFER_SIZE = 200 * 1024

/**
 * Environment variable to override the replay buffer size (in bytes).
 */
const REPLAY_BUFFER_SIZE_ENV = 'LABORER_TERMINAL_REPLAY_BUFFER_SIZE'

/**
 * Directory for persisted terminal state files.
 * Uses a subdirectory of the OS temp directory.
 */
const PERSISTENCE_DIR = join(tmpdir(), 'laborer-terminal-persistence')

/**
 * File name for the serialized terminal state.
 */
const STATE_FILE = 'terminal-state.json'

// ---------------------------------------------------------------------------
// Replay Buffer
// ---------------------------------------------------------------------------

/**
 * Circular replay buffer that stores recent terminal output.
 *
 * Uses a simple string accumulator with a max byte size. When the buffer
 * exceeds the max size, older content is trimmed from the front.
 *
 * This is simpler than a ring buffer of chunks because terminal output
 * is UTF-8 text and we need the full string for replay anyway.
 */
class ReplayBuffer {
  private buffer = ''
  private readonly maxSize: number

  constructor(maxSize: number = DEFAULT_REPLAY_BUFFER_SIZE) {
    this.maxSize = maxSize
  }

  /**
   * Append output data to the replay buffer.
   * If the buffer exceeds maxSize, older content is trimmed.
   */
  write(data: string): void {
    this.buffer += data

    if (this.buffer.length > this.maxSize) {
      // Trim from the front, keeping the most recent output.
      // Find a newline boundary to avoid splitting mid-line.
      const excess = this.buffer.length - this.maxSize
      const newlineIndex = this.buffer.indexOf('\n', excess)
      if (newlineIndex !== -1) {
        this.buffer = this.buffer.slice(newlineIndex + 1)
      } else {
        // No newline found — just trim to maxSize
        this.buffer = this.buffer.slice(excess)
      }
    }
  }

  /**
   * Get the current replay buffer contents.
   */
  getContents(): string {
    return this.buffer
  }

  /**
   * Clear the replay buffer.
   */
  clear(): void {
    this.buffer = ''
  }

  /**
   * Get the current buffer size in characters.
   */
  get size(): number {
    return this.buffer.length
  }
}

interface ReplayRecorderEntry {
  cols: number
  data: string[]
  rows: number
}

/**
 * Tracks replay output across resize boundaries, mirroring VS Code's
 * terminal recorder shape so restored terminals can rehydrate with the
 * same sequence of size changes that produced the buffer.
 */
class ReplayRecorder {
  private capabilities: SerializedCapabilityStore | undefined = undefined
  private commands: SerializedCommandDetectionCapability | undefined = undefined
  private entries: ReplayRecorderEntry[]
  private readonly maxSize: number
  private totalDataLength = 0

  constructor(
    cols: number,
    rows: number,
    maxSize: number = DEFAULT_REPLAY_BUFFER_SIZE
  ) {
    this.entries = [{ cols, rows, data: [] }]
    this.maxSize = maxSize
  }

  handleData(data: string): void {
    const lastEntry = this.entries.at(-1)
    if (lastEntry === undefined) {
      return
    }

    lastEntry.data.push(data)
    this.totalDataLength += data.length

    while (this.totalDataLength > this.maxSize) {
      const firstEntry = this.entries[0]
      const firstChunk = firstEntry?.data[0]
      if (firstEntry === undefined || firstChunk === undefined) {
        break
      }

      const remainingToDelete = this.totalDataLength - this.maxSize
      if (remainingToDelete >= firstChunk.length) {
        this.totalDataLength -= firstChunk.length
        firstEntry.data.shift()
        if (firstEntry.data.length === 0 && this.entries.length > 1) {
          this.entries.shift()
        }
        continue
      }

      firstEntry.data[0] = firstChunk.slice(remainingToDelete)
      this.totalDataLength -= remainingToDelete
    }
  }

  handleResize(cols: number, rows: number): void {
    const lastEntry = this.entries.at(-1)
    if (lastEntry === undefined) {
      this.entries.push({ cols, rows, data: [] })
      return
    }

    if (lastEntry.data.length === 0) {
      if (this.entries.length === 1) {
        lastEntry.cols = cols
        lastEntry.rows = rows
        return
      }

      this.entries.pop()
    }

    const nextLastEntry = this.entries.at(-1)
    if (
      nextLastEntry !== undefined &&
      nextLastEntry.cols === cols &&
      nextLastEntry.rows === rows
    ) {
      return
    }

    this.entries.push({ cols, rows, data: [] })
  }

  loadReplayEvent(replayEvent: SerializedReplayEvent): void {
    this.capabilities = replayEvent.capabilities
    this.commands = replayEvent.commands
    this.entries = replayEvent.events.map((event) => ({
      cols: event.cols,
      rows: event.rows,
      data: event.data.length > 0 ? [event.data] : [],
    }))
    this.totalDataLength = replayEvent.events.reduce(
      (total, event) => total + event.data.length,
      0
    )

    if (this.entries.length === 0) {
      this.entries = [{ cols: 0, rows: 0, data: [] }]
    }
  }

  toReplayEvent(): SerializedReplayEvent {
    return {
      capabilities: this.capabilities,
      commands: this.commands,
      events: this.entries.map((entry) => ({
        cols: entry.cols,
        rows: entry.rows,
        data: entry.data.join(''),
      })) as [SerializedReplayFrame, ...SerializedReplayFrame[]],
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization Types
// ---------------------------------------------------------------------------

/**
 * Serialized terminal metadata for persistence.
 * Contains everything needed to respawn a terminal with the same config.
 */
interface SerializedTerminal {
  readonly args: readonly string[]
  readonly cols: number
  readonly command: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly id: string
  readonly replayBuffer: string
  readonly replayEvent: SerializedReplayEvent
  readonly rows: number
  readonly screenState: string
  readonly workspaceId: string
}

interface SerializedCwdDetectionEntry {
  readonly cwd: string
  readonly line?: number | undefined
}

interface SerializedCwdDetection {
  readonly cwd: string
  readonly history: readonly SerializedCwdDetectionEntry[]
}

interface SerializedCapabilityStore {
  readonly cwdDetection?: SerializedCwdDetection | undefined
}

interface SerializedReplayEvent {
  readonly capabilities?: SerializedCapabilityStore | undefined
  readonly commands?: SerializedCommandDetectionCapability | undefined
  readonly events: readonly [SerializedReplayFrame, ...SerializedReplayFrame[]]
}

interface SerializedMarkProperties {
  readonly disableCommandStorage?: boolean | undefined
  readonly hidden?: boolean | undefined
  readonly hoverMessage?: string | undefined
  readonly id?: string | undefined
}

interface SerializedTerminalCommand {
  readonly command: string
  readonly commandLineConfidence: 'low' | 'medium' | 'high'
  readonly commandStartLineContent?: string | undefined
  readonly cwd?: string | undefined
  readonly duration: number
  readonly endLine?: number | undefined
  readonly executedLine?: number | undefined
  readonly executedX?: number | undefined
  readonly exitCode?: number | undefined
  readonly id?: string | undefined
  readonly isTrusted: boolean
  readonly markProperties?: SerializedMarkProperties | undefined
  readonly promptStartLine?: number | undefined
  readonly startLine?: number | undefined
  readonly startX?: number | undefined
  readonly timestamp: number
}

interface SerializedPromptInputModel {
  readonly commandStartX: number
  readonly continuationPrompt?: string | undefined
  readonly cursorIndex: number
  readonly ghostTextIndex: number
  readonly lastPromptLine?: string | undefined
  readonly lastUserInput: string
  readonly value: string
}

interface SerializedCommandDetectionCapability {
  readonly commands: readonly SerializedTerminalCommand[]
  readonly hasRichCommandDetection: boolean
  readonly isWindowsPty: boolean
  readonly promptInputModel?: SerializedPromptInputModel | undefined
}

interface SerializedReplayFrame {
  readonly cols: number
  readonly data: string
  readonly rows: number
}

/**
 * Complete serialized state file format.
 */
interface SerializedState {
  readonly terminals: readonly SerializedTerminal[]
  readonly timestamp: number
  readonly version: 3
}

/**
 * Information about a terminal's dimensions, needed for serialization.
 * The TerminalManager tracks command/args/cwd/env but not cols/rows,
 * so we track dimensions separately.
 */
interface TerminalDimensions {
  readonly cols: number
  readonly rows: number
}

// ---------------------------------------------------------------------------
// Terminal Session Persistence Manager
// ---------------------------------------------------------------------------

/**
 * Manages replay buffers and session persistence for all terminals.
 *
 * Usage:
 * ```ts
 * const persistence = createTerminalSessionPersistence()
 *
 * // When a terminal is spawned, register it with initial dimensions
 * persistence.registerTerminal('term-1', 80, 24)
 *
 * // Feed PTY output to the replay buffer
 * persistence.writeOutput('term-1', 'Hello, world!\r\n')
 *
 * // When terminal is resized, update stored dimensions
 * persistence.updateDimensions('term-1', 120, 40)
 *
 * // On graceful shutdown, serialize state
 * persistence.serializeState(getTerminalMetadata, getScreenState)
 *
 * // On next startup, restore state
 * const restored = persistence.loadPersistedState()
 * ```
 */
interface TerminalSessionPersistence {
  /**
   * Clear all replay buffers and dimensions.
   */
  readonly clear: () => void

  /**
   * Get stored dimensions for a terminal.
   */
  readonly getDimensions: (terminalId: string) => TerminalDimensions | undefined

  /**
   * Get the replay buffer contents for a terminal.
   * Used by the data channel to replay output after a restart.
   */
  readonly getReplayBuffer: (terminalId: string) => string | undefined

  /** Get the structured replay event for a terminal. */
  readonly getReplayEvent: (
    terminalId: string
  ) => SerializedReplayEvent | undefined

  /**
   * Load previously persisted terminal state from disk.
   * Returns null if no state file exists or if it's invalid/stale.
   * The state file is deleted after loading (one-time restoration).
   */
  readonly loadPersistedState: () => SerializedState | null
  /**
   * Register a terminal for replay buffer tracking.
   * Call this when a terminal is spawned.
   */
  readonly registerTerminal: (
    terminalId: string,
    cols: number,
    rows: number
  ) => void

  /** Restore a previously persisted replay event for a terminal. */
  readonly restoreReplayEvent: (
    terminalId: string,
    replayEvent: SerializedReplayEvent
  ) => void

  /**
   * Serialize the current terminal state to disk for graceful shutdown.
   *
   * @param getTerminalMeta - Function to get terminal metadata (id, command, args, cwd, env, workspaceId)
   * @param getScreenState - Function to get headless terminal screen state
   * @param getCommandDetectionState - Function to get command detection state
   * @param getCapabilityState - Function to get capability store state
   */
  readonly serializeState: (
    getTerminalMeta: () => ReadonlyArray<{
      readonly id: string
      readonly workspaceId: string
      readonly command: string
      readonly args: readonly string[]
      readonly cwd: string
      readonly env: Record<string, string>
      readonly status: 'running' | 'stopped'
    }>,
    getScreenState: (terminalId: string) => string,
    getCommandDetectionState?: (
      terminalId: string
    ) => SerializedCommandDetectionCapability | undefined,
    getCapabilityState?: (
      terminalId: string
    ) => SerializedCapabilityStore | undefined
  ) => void

  /**
   * Unregister a terminal (e.g., when removed).
   * Clears the replay buffer and dimensions.
   */
  readonly unregisterTerminal: (terminalId: string) => void

  /**
   * Update stored dimensions for a terminal.
   * Call this when the terminal is resized.
   */
  readonly updateDimensions: (
    terminalId: string,
    cols: number,
    rows: number
  ) => void

  /**
   * Write PTY output data to the terminal's replay buffer.
   * Call this from the data callback pipeline.
   */
  readonly writeOutput: (terminalId: string, data: string) => void
}

/**
 * Maximum age (in ms) for a persisted state file to be considered valid.
 * State files older than this are discarded on startup.
 * 5 minutes is generous — typical restart is < 1 second.
 */
const MAX_STATE_AGE_MS = 5 * 60 * 1000

/**
 * Parse the replay buffer size from environment, falling back to the default.
 */
function parseReplayBufferSize(): number {
  const raw = process.env[REPLAY_BUFFER_SIZE_ENV]
  if (raw === undefined || raw === '') {
    return DEFAULT_REPLAY_BUFFER_SIZE
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REPLAY_BUFFER_SIZE
  }

  return parsed
}

/**
 * Create a TerminalSessionPersistence manager.
 */
function createTerminalSessionPersistence(): TerminalSessionPersistence {
  const replayBuffers = new Map<string, ReplayBuffer>()
  const replayRecorders = new Map<string, ReplayRecorder>()
  const dimensions = new Map<string, TerminalDimensions>()
  const bufferSize = parseReplayBufferSize()

  return {
    registerTerminal(terminalId: string, cols: number, rows: number): void {
      if (!replayBuffers.has(terminalId)) {
        replayBuffers.set(terminalId, new ReplayBuffer(bufferSize))
      }
      if (!replayRecorders.has(terminalId)) {
        replayRecorders.set(
          terminalId,
          new ReplayRecorder(cols, rows, bufferSize)
        )
      }
      dimensions.set(terminalId, { cols, rows })
    },

    unregisterTerminal(terminalId: string): void {
      replayBuffers.delete(terminalId)
      replayRecorders.delete(terminalId)
      dimensions.delete(terminalId)
    },

    writeOutput(terminalId: string, data: string): void {
      replayBuffers.get(terminalId)?.write(data)
      replayRecorders.get(terminalId)?.handleData(data)
    },

    updateDimensions(terminalId: string, cols: number, rows: number): void {
      if (dimensions.has(terminalId)) {
        dimensions.set(terminalId, { cols, rows })
      }
      replayRecorders.get(terminalId)?.handleResize(cols, rows)
    },

    getReplayBuffer(terminalId: string): string | undefined {
      return replayBuffers.get(terminalId)?.getContents()
    },

    getReplayEvent(terminalId: string): SerializedReplayEvent | undefined {
      return replayRecorders.get(terminalId)?.toReplayEvent()
    },

    getDimensions(terminalId: string): TerminalDimensions | undefined {
      return dimensions.get(terminalId)
    },

    restoreReplayEvent(
      terminalId: string,
      replayEvent: SerializedReplayEvent
    ): void {
      const buffer = replayBuffers.get(terminalId)
      const recorder = replayRecorders.get(terminalId)
      if (!(buffer && recorder)) {
        return
      }

      buffer.clear()
      for (const event of replayEvent.events) {
        if (event.data.length > 0) {
          buffer.write(event.data)
        }
      }

      recorder.loadReplayEvent(replayEvent)

      const lastEvent = replayEvent.events.at(-1)
      if (lastEvent !== undefined) {
        dimensions.set(terminalId, {
          cols: lastEvent.cols,
          rows: lastEvent.rows,
        })
      }
    },

    serializeState(
      getTerminalMeta: () => ReadonlyArray<{
        readonly id: string
        readonly workspaceId: string
        readonly command: string
        readonly args: readonly string[]
        readonly cwd: string
        readonly env: Record<string, string>
        readonly status: 'running' | 'stopped'
      }>,
      getScreenState: (terminalId: string) => string,
      getCommandDetectionState?: (
        terminalId: string
      ) => SerializedCommandDetectionCapability | undefined,
      getCapabilityState?: (
        terminalId: string
      ) => SerializedCapabilityStore | undefined
    ): void {
      const terminals = getTerminalMeta()

      // Only serialize running terminals — stopped ones don't need restoration
      const runningTerminals = terminals.filter((t) => t.status === 'running')

      if (runningTerminals.length === 0) {
        // Nothing to persist
        return
      }

      const serialized: SerializedState = {
        version: 3,
        timestamp: Date.now(),
        terminals: runningTerminals.map((t) => {
          const dims = dimensions.get(t.id)
          const cols = dims?.cols ?? 80
          const rows = dims?.rows ?? 24
          const replayBuffer = replayBuffers.get(t.id)?.getContents() ?? ''
          const replayEvent = replayRecorders.get(t.id)?.toReplayEvent() ?? {
            events: [{ cols, rows, data: replayBuffer }],
          }
          const liveCommandState = getCommandDetectionState?.(t.id)
          const liveCapabilityState = getCapabilityState?.(t.id)

          return {
            id: t.id,
            workspaceId: t.workspaceId,
            command: t.command,
            args: [...t.args],
            cwd: t.cwd,
            env: { ...t.env },
            cols,
            rows,
            replayBuffer,
            replayEvent: {
              ...replayEvent,
              ...(liveCommandState !== undefined
                ? { commands: liveCommandState }
                : {}),
              ...(liveCapabilityState !== undefined
                ? { capabilities: liveCapabilityState }
                : {}),
            },
            screenState: getScreenState(t.id),
          }
        }),
      }

      try {
        mkdirSync(PERSISTENCE_DIR, { recursive: true })
        const filePath = join(PERSISTENCE_DIR, STATE_FILE)
        writeFileSync(filePath, JSON.stringify(serialized), 'utf-8')
        console.log(
          `[terminal-persistence] Serialized ${serialized.terminals.length} terminal(s) to ${filePath}`
        )
      } catch (error) {
        console.error(
          `[terminal-persistence] Failed to serialize state: ${String(error)}`
        )
      }
    },

    loadPersistedState(): SerializedState | null {
      const filePath = join(PERSISTENCE_DIR, STATE_FILE)

      try {
        if (!existsSync(filePath)) {
          return null
        }

        const raw = readFileSync(filePath, 'utf-8')

        // Delete the file immediately — one-time restoration
        try {
          unlinkSync(filePath)
        } catch {
          // Best effort cleanup
        }

        const state = JSON.parse(raw) as SerializedState

        // Validate version
        if (state.version !== 3) {
          console.log(
            `[terminal-persistence] Unsupported state version: ${String(state.version)}`
          )
          return null
        }

        // Check staleness
        const age = Date.now() - state.timestamp
        if (age > MAX_STATE_AGE_MS) {
          console.log(
            `[terminal-persistence] State file is stale (${Math.round(age / 1000)}s old), discarding`
          )
          return null
        }

        // Validate terminals array
        if (!Array.isArray(state.terminals) || state.terminals.length === 0) {
          return null
        }

        console.log(
          `[terminal-persistence] Loaded ${state.terminals.length} persisted terminal(s)`
        )
        return state
      } catch (error) {
        console.error(
          `[terminal-persistence] Failed to load persisted state: ${String(error)}`
        )

        // Clean up corrupt file
        try {
          unlinkSync(filePath)
        } catch {
          // Best effort
        }

        return null
      }
    },

    clear(): void {
      replayBuffers.clear()
      replayRecorders.clear()
      dimensions.clear()
    },
  }
}

export {
  createTerminalSessionPersistence,
  DEFAULT_REPLAY_BUFFER_SIZE,
  MAX_STATE_AGE_MS,
  PERSISTENCE_DIR,
  ReplayRecorder,
  ReplayBuffer,
  STATE_FILE,
}
export type {
  SerializedCapabilityStore,
  SerializedCommandDetectionCapability,
  SerializedCwdDetection,
  SerializedCwdDetectionEntry,
  SerializedMarkProperties,
  SerializedPromptInputModel,
  SerializedReplayEvent,
  SerializedReplayFrame,
  SerializedState,
  SerializedTerminal,
  SerializedTerminalCommand,
  TerminalDimensions,
  TerminalSessionPersistence,
}
