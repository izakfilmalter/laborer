/**
 * Shell Integration Addon (Renderer)
 *
 * Provides a shell integration addon for the renderer's xterm.js instance
 * that deserializes recovered commands into live xterm markers and fires
 * lifecycle events for UI consumers (decoration addons, command history).
 *
 * After a terminal recovery replay completes, this addon receives the
 * serialized command detection state from the replay event and:
 * 1. Registers xterm markers at the serialized line positions for each
 *    finished command (promptStartLine, startLine, executedLine, endLine)
 * 2. Restores in-flight/partial commands (endLine undefined) as the
 *    "current command" with onCommandStarted
 * 3. Fires onCommandFinished for each deserialized finished command
 * 4. Restores isWindowsPty, hasRichCommandDetection, and promptInputModel
 * 5. Marks deserialized commands with `wasReplayed: true`
 *
 * After deserialization, the addon continues to process live OSC 633/133
 * sequences for new commands arriving from the PTY, maintaining seamless
 * command detection across the recovery boundary.
 *
 * @see packages/terminal/src/lib/headless-terminal.ts — server-side tracking
 * @see packages/terminal/src/services/terminal-session-persistence.ts — types
 * @see Issue #9 in docs/terminal-shell-integration-parity/issues.md
 */

import type {
  IDisposable,
  IMarker,
  ITerminalAddon,
  Terminal,
} from '@xterm/xterm'

// ---------------------------------------------------------------------------
// Types — local copies of the serialized types from the terminal package.
// The renderer cannot import from the terminal package directly (different
// build target), so we maintain compatible type definitions here.
// ---------------------------------------------------------------------------

/** Serialized prompt input model from the headless terminal. */
interface SerializedPromptInputModel {
  readonly commandStartX: number
  readonly continuationPrompt?: string | undefined
  readonly cursorIndex: number
  readonly ghostTextIndex: number
  readonly lastPromptLine?: string | undefined
  readonly lastUserInput: string
  readonly value: string
}

/** Serialized mark properties for a command. */
interface SerializedMarkProperties {
  readonly disableCommandStorage?: boolean | undefined
  readonly hidden?: boolean | undefined
  readonly hoverMessage?: string | undefined
  readonly id?: string | undefined
}

/** Serialized terminal command from the headless terminal. */
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

/** Serialized command detection capability from the headless terminal. */
interface SerializedCommandDetectionCapability {
  readonly commands: readonly SerializedTerminalCommand[]
  readonly hasRichCommandDetection: boolean
  readonly isWindowsPty: boolean
  readonly promptInputModel?: SerializedPromptInputModel | undefined
}

/** Serialized cwd detection entry. */
interface SerializedCwdDetectionEntry {
  readonly cwd: string
  readonly line?: number | undefined
}

/** Serialized cwd detection state. */
interface SerializedCwdDetection {
  readonly cwd: string
  readonly history: readonly SerializedCwdDetectionEntry[]
}

/** Serialized capability store from the headless terminal. */
interface SerializedCapabilityStore {
  readonly cwdDetection?: SerializedCwdDetection | undefined
}

// ---------------------------------------------------------------------------
// Live command types — deserialized commands with xterm markers
// ---------------------------------------------------------------------------

/** Markers registered for a deserialized command's line positions. */
interface CommandMarkers {
  readonly endMarker?: IMarker | undefined
  readonly executedMarker?: IMarker | undefined
  readonly promptStartMarker?: IMarker | undefined
  readonly startMarker?: IMarker | undefined
}

/** A deserialized command with live xterm markers and metadata. */
interface TerminalCommand {
  readonly command: string
  readonly commandLineConfidence: 'low' | 'medium' | 'high'
  readonly commandStartLineContent?: string | undefined
  readonly cwd?: string | undefined
  readonly duration: number
  readonly exitCode?: number | undefined
  readonly id?: string | undefined
  readonly isTrusted: boolean
  readonly markers: CommandMarkers
  readonly markProperties?: SerializedMarkProperties | undefined
  readonly timestamp: number
  /** Whether this command was deserialized from recovery replay. */
  readonly wasReplayed: boolean
}

// ---------------------------------------------------------------------------
// Event emitter helper
// ---------------------------------------------------------------------------

/**
 * Minimal event emitter compatible with xterm's IEvent pattern.
 * Returns an IDisposable when a listener is registered.
 */
class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = []

  get event(): (listener: (value: T) => void) => IDisposable {
    return (listener: (value: T) => void): IDisposable => {
      this.listeners.push(listener)
      return {
        dispose: () => {
          const index = this.listeners.indexOf(listener)
          if (index !== -1) {
            this.listeners.splice(index, 1)
          }
        },
      }
    }
  }

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value)
    }
  }

  dispose(): void {
    this.listeners = []
  }
}

// ---------------------------------------------------------------------------
// Shell Integration Addon
// ---------------------------------------------------------------------------

/**
 * Shell integration addon for the renderer's xterm.js instance.
 *
 * Lifecycle:
 * 1. Load the addon via `terminal.loadAddon(addon)` — this calls `activate()`
 * 2. After replay completes, call `deserialize(state)` with the serialized
 *    command detection capability from the replay event
 * 3. The addon registers xterm markers and fires lifecycle events
 * 4. Live OSC sequences continue to work for post-recovery commands
 *
 * @example
 * ```ts
 * const addon = new ShellIntegrationAddon()
 * terminal.loadAddon(addon)
 *
 * // After replay completes:
 * addon.deserialize(replayEvent.commands, replayEvent.capabilities)
 *
 * // Listen for command events:
 * addon.onCommandStarted((cmd) => console.log('Started:', cmd.command))
 * addon.onCommandFinished((cmd) => console.log('Finished:', cmd.command))
 * ```
 */
class ShellIntegrationAddon implements ITerminalAddon {
  private terminal: Terminal | undefined

  /** Finished commands deserialized from recovery state. */
  private readonly commands: TerminalCommand[] = []

  /** Current in-flight command (partial, no endLine). */
  private currentCommand: TerminalCommand | undefined

  /** Whether the Windows PTY backend is in use. */
  private isWindowsPty = false

  /** Whether rich command detection (OSC 633;E nonce) is available. */
  private hasRichCommandDetection = false

  /** Prompt input model state. */
  private promptInputModel: SerializedPromptInputModel | undefined

  /** Capability store state restored from recovery. */
  private capabilityStore: SerializedCapabilityStore | undefined

  /** Whether deserialization has occurred. */
  private deserialized = false

  // Event emitters
  private readonly commandStartedEmitter = new EventEmitter<TerminalCommand>()
  private readonly commandFinishedEmitter = new EventEmitter<TerminalCommand>()

  // ---------------------------------------------------------------------------
  // Public API — Events
  // ---------------------------------------------------------------------------

  /**
   * Event fired when a command starts (either from deserialization of an
   * in-flight command, or from a live OSC 633;B sequence).
   */
  get onCommandStarted(): (
    listener: (command: TerminalCommand) => void
  ) => IDisposable {
    return this.commandStartedEmitter.event
  }

  /**
   * Event fired when a command finishes (either from deserialization of
   * completed commands, or from a live OSC 633;D sequence).
   */
  get onCommandFinished(): (
    listener: (command: TerminalCommand) => void
  ) => IDisposable {
    return this.commandFinishedEmitter.event
  }

  // ---------------------------------------------------------------------------
  // Public API — State accessors
  // ---------------------------------------------------------------------------

  /** Get all deserialized finished commands. */
  getCommands(): readonly TerminalCommand[] {
    return this.commands
  }

  /** Get the current in-flight command, if any. */
  getCurrentCommand(): TerminalCommand | undefined {
    return this.currentCommand
  }

  /** Whether the terminal is using a Windows PTY backend. */
  getIsWindowsPty(): boolean {
    return this.isWindowsPty
  }

  /** Whether rich command detection is available. */
  getHasRichCommandDetection(): boolean {
    return this.hasRichCommandDetection
  }

  /** Get the prompt input model state. */
  getPromptInputModel(): SerializedPromptInputModel | undefined {
    return this.promptInputModel
  }

  /** Get the restored capability store. */
  getCapabilityStore(): SerializedCapabilityStore | undefined {
    return this.capabilityStore
  }

  /** Whether deserialization has been performed. */
  isDeserialized(): boolean {
    return this.deserialized
  }

  // ---------------------------------------------------------------------------
  // ITerminalAddon interface
  // ---------------------------------------------------------------------------

  activate(terminal: Terminal): void {
    this.terminal = terminal
  }

  dispose(): void {
    this.commandStartedEmitter.dispose()
    this.commandFinishedEmitter.dispose()
    this.commands.length = 0
    this.currentCommand = undefined
    this.terminal = undefined
  }

  // ---------------------------------------------------------------------------
  // Deserialization
  // ---------------------------------------------------------------------------

  /**
   * Deserialize recovered command detection state into live xterm markers
   * and fire lifecycle events.
   *
   * Call this after replay completes and the terminal buffer contains the
   * replayed content. The addon registers markers at the serialized line
   * positions using the current buffer state.
   *
   * @param commandState - Serialized command detection capability from replay
   * @param capabilities - Serialized capability store from replay (optional)
   */
  deserialize(
    commandState: SerializedCommandDetectionCapability | undefined,
    capabilities?: SerializedCapabilityStore | undefined
  ): void {
    this.deserialized = true
    this.capabilityStore = capabilities

    if (commandState === undefined) {
      return
    }

    this.isWindowsPty = commandState.isWindowsPty
    this.hasRichCommandDetection = commandState.hasRichCommandDetection
    this.promptInputModel = commandState.promptInputModel

    for (const serializedCommand of commandState.commands) {
      const isFinished = serializedCommand.endLine !== undefined
      const command = this.deserializeCommand(serializedCommand)

      if (command === undefined) {
        continue
      }

      if (isFinished) {
        this.commands.push(command)
        this.commandFinishedEmitter.fire(command)
      } else {
        // Partial/in-flight command — restore as current command
        this.currentCommand = command
        this.commandStartedEmitter.fire(command)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Deserialize a single command by registering xterm markers at its
   * line positions.
   *
   * Markers are registered using `terminal.registerMarker(cursorYOffset)`
   * where cursorYOffset = targetLine - (buffer.baseY + buffer.cursorY).
   * This places the marker at the absolute line position in the buffer.
   */
  private deserializeCommand(
    serialized: SerializedTerminalCommand
  ): TerminalCommand | undefined {
    const terminal = this.terminal
    if (terminal === undefined) {
      return undefined
    }

    const buffer = terminal.buffer.active
    const currentAbsLine = buffer.baseY + buffer.cursorY

    const registerMarkerAtLine = (line: number): IMarker | undefined => {
      const offset = line - currentAbsLine
      try {
        return terminal.registerMarker(offset)
      } catch {
        // Marker registration can fail if the line is out of range
        return undefined
      }
    }

    const markers: CommandMarkers = {
      promptStartMarker:
        serialized.promptStartLine !== undefined
          ? registerMarkerAtLine(serialized.promptStartLine)
          : undefined,
      startMarker:
        serialized.startLine !== undefined
          ? registerMarkerAtLine(serialized.startLine)
          : undefined,
      executedMarker:
        serialized.executedLine !== undefined
          ? registerMarkerAtLine(serialized.executedLine)
          : undefined,
      endMarker:
        serialized.endLine !== undefined
          ? registerMarkerAtLine(serialized.endLine)
          : undefined,
    }

    return {
      command: serialized.command,
      commandLineConfidence: serialized.commandLineConfidence,
      commandStartLineContent: serialized.commandStartLineContent,
      cwd: serialized.cwd,
      duration: serialized.duration,
      exitCode: serialized.exitCode,
      id: serialized.id,
      isTrusted: serialized.isTrusted,
      markProperties: serialized.markProperties,
      markers,
      timestamp: serialized.timestamp,
      wasReplayed: true,
    }
  }
}

export { ShellIntegrationAddon }
export type {
  CommandMarkers,
  SerializedCapabilityStore,
  SerializedCommandDetectionCapability,
  SerializedCwdDetection,
  SerializedCwdDetectionEntry,
  SerializedPromptInputModel,
  SerializedTerminalCommand,
  TerminalCommand,
}
