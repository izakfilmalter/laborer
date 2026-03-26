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
  readonly rows: number
  readonly screenState: string
  readonly workspaceId: string
}

/**
 * Complete serialized state file format.
 */
interface SerializedState {
  readonly terminals: readonly SerializedTerminal[]
  readonly timestamp: number
  readonly version: 1
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

  /**
   * Serialize the current terminal state to disk for graceful shutdown.
   *
   * @param getTerminalMeta - Function to get terminal metadata (id, command, args, cwd, env, workspaceId)
   * @param getScreenState - Function to get headless terminal screen state
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
    getScreenState: (terminalId: string) => string
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
  const dimensions = new Map<string, TerminalDimensions>()
  const bufferSize = parseReplayBufferSize()

  return {
    registerTerminal(terminalId: string, cols: number, rows: number): void {
      if (!replayBuffers.has(terminalId)) {
        replayBuffers.set(terminalId, new ReplayBuffer(bufferSize))
      }
      dimensions.set(terminalId, { cols, rows })
    },

    unregisterTerminal(terminalId: string): void {
      replayBuffers.delete(terminalId)
      dimensions.delete(terminalId)
    },

    writeOutput(terminalId: string, data: string): void {
      const buffer = replayBuffers.get(terminalId)
      if (buffer !== undefined) {
        buffer.write(data)
      }
    },

    updateDimensions(terminalId: string, cols: number, rows: number): void {
      if (dimensions.has(terminalId)) {
        dimensions.set(terminalId, { cols, rows })
      }
    },

    getReplayBuffer(terminalId: string): string | undefined {
      return replayBuffers.get(terminalId)?.getContents()
    },

    getDimensions(terminalId: string): TerminalDimensions | undefined {
      return dimensions.get(terminalId)
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
      getScreenState: (terminalId: string) => string
    ): void {
      const terminals = getTerminalMeta()

      // Only serialize running terminals — stopped ones don't need restoration
      const runningTerminals = terminals.filter((t) => t.status === 'running')

      if (runningTerminals.length === 0) {
        // Nothing to persist
        return
      }

      const serialized: SerializedState = {
        version: 1,
        timestamp: Date.now(),
        terminals: runningTerminals.map((t) => {
          const dims = dimensions.get(t.id)
          const buffer = replayBuffers.get(t.id)

          return {
            id: t.id,
            workspaceId: t.workspaceId,
            command: t.command,
            args: [...t.args],
            cwd: t.cwd,
            env: { ...t.env },
            cols: dims?.cols ?? 80,
            rows: dims?.rows ?? 24,
            replayBuffer: buffer?.getContents() ?? '',
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
        if (state.version !== 1) {
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
      dimensions.clear()
    },
  }
}

export {
  createTerminalSessionPersistence,
  DEFAULT_REPLAY_BUFFER_SIZE,
  MAX_STATE_AGE_MS,
  PERSISTENCE_DIR,
  ReplayBuffer,
  STATE_FILE,
}
export type {
  SerializedState,
  SerializedTerminal,
  TerminalDimensions,
  TerminalSessionPersistence,
}
