/**
 * TerminalManager — Effect Service (Terminal Package)
 *
 * Manages terminal instances with in-memory-only state. No LiveStore
 * dependency, no WorkspaceProvider dependency. All spawn parameters
 * (command, args, cwd, env, cols, rows) are provided at call time.
 *
 * Key differences from the server's TerminalManager:
 * - No LiveStore: terminal state is ephemeral, in-memory only
 * - No WorkspaceProvider: env vars and cwd are passed at spawn time
 * - Stopped terminal retention: when a PTY exits, the terminal entry
 *   remains in memory with status "stopped" (preserving command and config
 *   for restart)
 * - Lifecycle event emission via Effect PubSub — consumers (RPC streaming,
 *   WebSocket control messages) subscribe to lifecycle events
 *
 * @see PRD-terminal-extraction.md — Modified Module: TerminalManager
 * @see Issue #138: Move + simplify TerminalManager
 */

import { execSync } from 'node:child_process'
import { TerminalRpcError } from '@laborer/shared/rpc'
import { Cause, Context, Effect, Layer, PubSub, Ref, Runtime } from 'effect'
import { RingBuffer } from '../lib/ring-buffer.js'
import { PtyHostClient } from './pty-host-client.js'

/** Logger tag used for structured Effect.log output in this module. */
const logPrefix = 'TerminalManager'

/**
 * Default ring buffer capacity: 5MB per terminal for scrollback.
 *
 * At ~80 chars/line, 5MB holds ~62,500 lines of raw text output.
 * Combined with xterm.js's 100,000-line client-side scrollback buffer,
 * this ensures reconnection restores a substantial portion of terminal
 * history for long-running AI agent sessions.
 */
const RING_BUFFER_CAPACITY = 5_242_880

/** Default grace period for disconnected/orphaned terminals (60 seconds). */
const DEFAULT_TERMINAL_GRACE_PERIOD_MS = 60_000

/** UTF-8 text encoder shared across all terminal data callbacks. */
const textEncoder = new TextEncoder()

const parseGracePeriodMs = (): number => {
  const raw = process.env.TERMINAL_GRACE_PERIOD_MS
  if (raw === undefined || raw === '') {
    return DEFAULT_TERMINAL_GRACE_PERIOD_MS
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TERMINAL_GRACE_PERIOD_MS
  }

  return parsed
}

/**
 * Callback type for WebSocket subscribers to terminal output.
 * Receives raw UTF-8 terminal output strings.
 */
type OutputSubscriber = (data: string) => void

/**
 * Internal representation of a managed terminal.
 * Tracks metadata and state. In the terminal package, stopped terminals
 * are retained in memory (not deleted on exit) so restart works without
 * a database.
 */
interface ManagedTerminal {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly id: string
  /**
   * PID of the shell process inside the PTY. Set when the PTY Host
   * confirms the spawn. Used to detect whether the shell has child
   * processes running (e.g., vim, dev server, opencode).
   */
  readonly shellPid: number | undefined
  readonly status: 'running' | 'stopped'
  readonly workspaceId: string
}

/**
 * Per-terminal scrollback and subscriber state.
 * Ring buffers survive terminal exit (retained until explicit removal)
 * so reconnecting clients can see output of stopped terminals.
 */
interface TerminalBufferState {
  readonly ringBuffer: RingBuffer
  readonly subscribers: Map<string, OutputSubscriber>
}

/**
 * Shape of a terminal record returned by the manager.
 * Matches the TerminalInfo RPC schema fields.
 */
interface TerminalRecord {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  /**
   * Whether the shell has child processes running. True when processes
   * like vim, dev servers, or AI agents are active inside the terminal.
   * False when the shell is idle at a prompt.
   */
  readonly hasChildProcess: boolean
  readonly id: string
  readonly status: 'running' | 'stopped'
  readonly workspaceId: string
}

/**
 * Spawn payload accepted by the new terminal manager.
 * All parameters are provided by the caller — no workspace resolution.
 */
interface SpawnPayload {
  readonly args?: readonly string[] | undefined
  readonly cols: number
  readonly command: string
  readonly cwd: string
  readonly env?: Record<string, string> | undefined
  readonly rows: number
  readonly workspaceId: string
}

/**
 * Check if a process has child processes by using `pgrep -P <pid>`.
 *
 * Returns true if the shell process has at least one child process
 * (e.g., vim, node, cargo, opencode). Returns false if the shell is
 * idle at a prompt or if the PID is unknown/invalid.
 *
 * Uses `pgrep` which is available on macOS and Linux. The call is
 * synchronous but extremely fast (~1-2ms per check).
 */
const checkHasChildProcess = (shellPid: number | undefined): boolean => {
  if (shellPid === undefined) {
    return false
  }
  try {
    // pgrep -P <pid> exits with 0 if children found, 1 if none
    execSync(`pgrep -P ${shellPid}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Lifecycle Events
// ---------------------------------------------------------------------------

interface TerminalSpawnedEvent {
  readonly _tag: 'Spawned'
  readonly terminal: TerminalRecord
}

interface TerminalStatusChangedEvent {
  readonly _tag: 'StatusChanged'
  readonly id: string
  readonly status: 'running' | 'stopped'
}

interface TerminalExitedEvent {
  readonly _tag: 'Exited'
  readonly exitCode: number
  readonly id: string
  readonly signal: number
}

interface TerminalRemovedEvent {
  readonly _tag: 'Removed'
  readonly id: string
}

interface TerminalRestartedEvent {
  readonly _tag: 'Restarted'
  readonly terminal: TerminalRecord
}

type TerminalLifecycleEvent =
  | TerminalSpawnedEvent
  | TerminalStatusChangedEvent
  | TerminalExitedEvent
  | TerminalRemovedEvent
  | TerminalRestartedEvent

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

class TerminalManager extends Context.Tag('@laborer/terminal/TerminalManager')<
  TerminalManager,
  {
    /**
     * Spawn a new PTY with the given payload.
     * All parameters (command, args, cwd, env, cols, rows, workspaceId)
     * are provided by the caller.
     */
    readonly spawn: (
      payload: SpawnPayload
    ) => Effect.Effect<TerminalRecord, TerminalRpcError>

    /** Write data to a terminal's stdin. */
    readonly write: (
      terminalId: string,
      data: string
    ) => Effect.Effect<void, TerminalRpcError>

    /** Resize a terminal's PTY dimensions. */
    readonly resize: (
      terminalId: string,
      cols: number,
      rows: number
    ) => Effect.Effect<void, TerminalRpcError>

    /** Kill a terminal's PTY process. Terminal is retained as "stopped". */
    readonly kill: (terminalId: string) => Effect.Effect<void, TerminalRpcError>

    /**
     * List all terminals (running and stopped).
     * If workspaceId is provided, filters to that workspace.
     */
    readonly listTerminals: (
      workspaceId?: string
    ) => Effect.Effect<readonly TerminalRecord[], TerminalRpcError>

    /** Remove a terminal completely — kills PTY if running, deletes from memory. */
    readonly remove: (
      terminalId: string
    ) => Effect.Effect<void, TerminalRpcError>

    /** Restart a terminal — kills existing PTY and respawns with same config. */
    readonly restart: (
      terminalId: string
    ) => Effect.Effect<TerminalRecord, TerminalRpcError>

    /** Kill all terminals belonging to a workspace. Returns count killed. */
    readonly killAllForWorkspace: (
      workspaceId: string
    ) => Effect.Effect<number, never>

    /**
     * Subscribe to live terminal output for a WebSocket connection.
     * Returns ring buffer scrollback and a subscriber ID.
     */
    readonly subscribe: (
      terminalId: string,
      callback: (data: string) => void
    ) => Effect.Effect<
      { readonly scrollback: string; readonly subscriberId: string },
      TerminalRpcError
    >

    /** Unsubscribe a WebSocket connection from terminal output. */
    readonly unsubscribe: (
      terminalId: string,
      subscriberId: string
    ) => Effect.Effect<void>

    /** Check if a terminal exists (running or stopped). */
    readonly terminalExists: (terminalId: string) => Effect.Effect<boolean>

    /** The PubSub for lifecycle events. Consumers subscribe to receive events. */
    readonly lifecycleEvents: PubSub.PubSub<TerminalLifecycleEvent>
  }
>() {
  static readonly layer = Layer.scoped(
    TerminalManager,
    Effect.gen(function* () {
      const ptyHostClient = yield* PtyHostClient
      const gracePeriodMs = parseGracePeriodMs()

      const runtime = yield* Effect.runtime<never>()
      const runSync = Runtime.runSync(runtime)
      const runFork = Runtime.runFork(runtime)

      // In-memory map of terminal ID → ManagedTerminal.
      // Both running AND stopped terminals are stored here.
      const terminalsRef = yield* Ref.make(new Map<string, ManagedTerminal>())

      // Per-terminal ring buffer and subscriber state.
      const bufferStates = new Map<string, TerminalBufferState>()
      const graceTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

      // Lifecycle event PubSub — unbounded so publishers never block.
      const lifecyclePubSub = yield* PubSub.unbounded<TerminalLifecycleEvent>()

      /** Publish a lifecycle event (fire-and-forget). */
      const emitEvent = (event: TerminalLifecycleEvent): void => {
        runFork(lifecyclePubSub.publish(event))
      }

      const getOrCreateBufferState = (
        terminalId: string
      ): TerminalBufferState => {
        let state = bufferStates.get(terminalId)
        if (state === undefined) {
          state = {
            ringBuffer: new RingBuffer(RING_BUFFER_CAPACITY),
            subscribers: new Map(),
          }
          bufferStates.set(terminalId, state)
        }
        return state
      }

      const clearGraceTimeout = (terminalId: string): void => {
        const timeoutId = graceTimeouts.get(terminalId)
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId)
          graceTimeouts.delete(terminalId)
        }
      }

      const scheduleGraceTimeout = (
        terminalId: string,
        reason: 'orphan' | 'disconnect' | 'restart'
      ): void => {
        clearGraceTimeout(terminalId)

        const timeoutId = setTimeout(() => {
          runFork(
            Effect.gen(function* () {
              const map = yield* Ref.get(terminalsRef)
              const terminal = map.get(terminalId)

              if (terminal === undefined || terminal.status !== 'running') {
                return
              }

              const state = bufferStates.get(terminalId)
              if ((state?.subscribers.size ?? 0) > 0) {
                return
              }

              ptyHostClient.kill(terminalId)

              yield* Ref.update(terminalsRef, (existingMap) => {
                const next = new Map(existingMap)
                const existing = next.get(terminalId)
                if (existing !== undefined) {
                  next.set(terminalId, {
                    ...existing,
                    status: 'stopped' as const,
                  })
                }
                return next
              })

              emitEvent({
                _tag: 'StatusChanged',
                id: terminalId,
                status: 'stopped',
              })

              yield* Effect.log(
                `Grace period expired (${gracePeriodMs}ms, reason=${reason}) — killed terminal ${terminalId}`
              ).pipe(Effect.annotateLogs('module', logPrefix))
            }).pipe(
              Effect.tapDefect((cause) =>
                Effect.logWarning(
                  `Failed grace-period cleanup for terminal ${terminalId}: ${Cause.pretty(cause)}`
                ).pipe(Effect.annotateLogs('module', logPrefix))
              )
            )
          )
        }, gracePeriodMs)

        graceTimeouts.set(terminalId, timeoutId)
      }

      // ---------------------------------------------------------------
      // PTY Host crash handler
      // ---------------------------------------------------------------
      ptyHostClient.onCrash(() => {
        runSync(
          Effect.gen(function* () {
            const map = yield* Ref.get(terminalsRef)
            const runningIds: string[] = []

            for (const [id, terminal] of map) {
              if (terminal.status === 'running') {
                runningIds.push(id)
              }
            }

            if (runningIds.length === 0) {
              return
            }

            // Mark all running terminals as stopped
            yield* Ref.update(terminalsRef, (m) => {
              const next = new Map(m)
              for (const id of runningIds) {
                const t = next.get(id)
                if (t !== undefined) {
                  next.set(id, { ...t, status: 'stopped' as const })
                }
              }
              return next
            })

            for (const id of runningIds) {
              clearGraceTimeout(id)
              emitEvent({ _tag: 'StatusChanged', id, status: 'stopped' })
            }

            yield* Effect.log(
              `PTY Host crashed — marked ${runningIds.length} terminal(s) as stopped`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          })
        )
      })

      const defaultShell = process.env.SHELL ?? '/bin/sh'

      // ---------------------------------------------------------------
      // spawn
      // ---------------------------------------------------------------
      const spawn = Effect.fn('TerminalManager.spawn')(function* (
        payload: SpawnPayload
      ) {
        const {
          command,
          args = [],
          cwd,
          env = {},
          cols,
          rows,
          workspaceId,
        } = payload

        const id = crypto.randomUUID()

        // Parse command into shell + args for PTY Host.
        // If args are provided, use the command directly with args.
        // If no args provided, run the command via the shell with -c.
        const shellPath = args.length > 0 ? command : defaultShell
        const shellArgs = args.length > 0 ? [...args] : ['-c', command]

        const managedTerminal: ManagedTerminal = {
          id,
          workspaceId,
          command,
          args: [...args],
          cwd,
          env: { ...env },
          shellPid: undefined,
          status: 'running',
        }

        yield* Ref.update(terminalsRef, (map) => {
          const next = new Map(map)
          next.set(id, managedTerminal)
          return next
        })

        const bufferState = getOrCreateBufferState(id)

        ptyHostClient.spawn(
          {
            id,
            shell: shellPath,
            args: shellArgs,
            cwd,
            env: {
              ...process.env,
              ...env,
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
            } as Record<string, string>,
            cols,
            rows,
          },
          // Data callback: write to ring buffer + notify subscribers
          (data: string) => {
            bufferState.ringBuffer.write(textEncoder.encode(data))

            for (const subscriber of bufferState.subscribers.values()) {
              try {
                subscriber(data)
              } catch {
                // Subscriber errors silently ignored
              }
            }
          },
          // Exit callback: mark as stopped (retain in memory)
          (exitCode: number, signal: number) => {
            clearGraceTimeout(id)

            runSync(
              Ref.update(terminalsRef, (map) => {
                const next = new Map(map)
                const existing = next.get(id)
                if (existing !== undefined) {
                  next.set(id, { ...existing, status: 'stopped' as const })
                }
                return next
              })
            )

            emitEvent({ _tag: 'StatusChanged', id, status: 'stopped' })
            emitEvent({ _tag: 'Exited', id, exitCode, signal })
          },
          // Spawned callback: store the shell PID for child process detection
          (pid: number) => {
            runSync(
              Ref.update(terminalsRef, (map) => {
                const next = new Map(map)
                const existing = next.get(id)
                if (existing !== undefined) {
                  next.set(id, { ...existing, shellPid: pid })
                }
                return next
              })
            )
          }
        )

        const record: TerminalRecord = {
          id,
          workspaceId,
          command,
          args: [...args],
          cwd,
          hasChildProcess: false,
          status: 'running',
        }

        emitEvent({ _tag: 'Spawned', terminal: record })
        scheduleGraceTimeout(id, 'orphan')

        return record
      })

      // ---------------------------------------------------------------
      // write
      // ---------------------------------------------------------------
      const write = Effect.fn('TerminalManager.write')(function* (
        terminalId: string,
        data: string
      ) {
        const map = yield* Ref.get(terminalsRef)
        const terminal = map.get(terminalId)

        if (terminal === undefined) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        if (terminal.status !== 'running') {
          return yield* new TerminalRpcError({
            message: `Terminal ${terminalId} is stopped — cannot write`,
            code: 'TERMINAL_ALREADY_STOPPED',
          })
        }

        ptyHostClient.write(terminalId, data)
      })

      // ---------------------------------------------------------------
      // resize
      // ---------------------------------------------------------------
      const resize = Effect.fn('TerminalManager.resize')(function* (
        terminalId: string,
        cols: number,
        rows: number
      ) {
        const map = yield* Ref.get(terminalsRef)
        const terminal = map.get(terminalId)

        if (terminal === undefined) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        if (terminal.status !== 'running') {
          return yield* new TerminalRpcError({
            message: `Terminal ${terminalId} is stopped — cannot resize`,
            code: 'TERMINAL_ALREADY_STOPPED',
          })
        }

        ptyHostClient.resize(terminalId, cols, rows)
      })

      // ---------------------------------------------------------------
      // kill — marks as stopped, retains in memory
      // ---------------------------------------------------------------
      const kill = Effect.fn('TerminalManager.kill')(function* (
        terminalId: string
      ) {
        const map = yield* Ref.get(terminalsRef)
        const terminal = map.get(terminalId)

        if (terminal === undefined) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        if (terminal.status !== 'running') {
          return yield* new TerminalRpcError({
            message: `Terminal ${terminalId} is already stopped`,
            code: 'TERMINAL_ALREADY_STOPPED',
          })
        }

        ptyHostClient.kill(terminalId)
        clearGraceTimeout(terminalId)

        // Retain terminal in memory as stopped
        yield* Ref.update(terminalsRef, (m) => {
          const next = new Map(m)
          const existing = next.get(terminalId)
          if (existing !== undefined) {
            next.set(terminalId, {
              ...existing,
              status: 'stopped' as const,
            })
          }
          return next
        })

        emitEvent({ _tag: 'StatusChanged', id: terminalId, status: 'stopped' })
      })

      // ---------------------------------------------------------------
      // remove — fully delete from memory
      // ---------------------------------------------------------------
      const remove = Effect.fn('TerminalManager.remove')(function* (
        terminalId: string
      ) {
        const map = yield* Ref.get(terminalsRef)
        const terminal = map.get(terminalId)

        if (terminal === undefined) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        // If running, kill first
        if (terminal.status === 'running') {
          ptyHostClient.kill(terminalId)
        }
        clearGraceTimeout(terminalId)

        yield* Ref.update(terminalsRef, (m) => {
          const next = new Map(m)
          next.delete(terminalId)
          return next
        })

        bufferStates.delete(terminalId)

        emitEvent({ _tag: 'Removed', id: terminalId })

        yield* Effect.log(`Removed terminal ${terminalId}`).pipe(
          Effect.annotateLogs('module', logPrefix)
        )
      })

      // ---------------------------------------------------------------
      // listTerminals
      // ---------------------------------------------------------------
      const listTerminals = Effect.fn('TerminalManager.listTerminals')(
        function* (workspaceId?: string) {
          const map = yield* Ref.get(terminalsRef)
          const results: TerminalRecord[] = []

          for (const terminal of map.values()) {
            if (
              workspaceId === undefined ||
              terminal.workspaceId === workspaceId
            ) {
              results.push({
                id: terminal.id,
                workspaceId: terminal.workspaceId,
                command: terminal.command,
                args: [...terminal.args],
                cwd: terminal.cwd,
                hasChildProcess:
                  terminal.status === 'running'
                    ? checkHasChildProcess(terminal.shellPid)
                    : false,
                status: terminal.status,
              })
            }
          }

          return results
        }
      )

      // ---------------------------------------------------------------
      // restart
      // ---------------------------------------------------------------
      const restart = Effect.fn('TerminalManager.restart')(function* (
        terminalId: string
      ) {
        const map = yield* Ref.get(terminalsRef)
        const terminal = map.get(terminalId)

        if (terminal === undefined) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        // If running, kill existing PTY
        if (terminal.status === 'running') {
          ptyHostClient.kill(terminalId)
        }
        clearGraceTimeout(terminalId)

        // Determine shell + args (same logic as spawn)
        const shellPath =
          terminal.args.length > 0 ? terminal.command : defaultShell
        const shellArgs =
          terminal.args.length > 0
            ? [...terminal.args]
            : ['-c', terminal.command]

        // Update status to running, reset shellPid (will be set by spawned callback)
        const updated: ManagedTerminal = {
          ...terminal,
          shellPid: undefined,
          status: 'running' as const,
        }

        yield* Ref.update(terminalsRef, (m) => {
          const next = new Map(m)
          next.set(terminalId, updated)
          return next
        })

        // Clear and re-initialize ring buffer
        const restartBufferState = getOrCreateBufferState(terminalId)
        restartBufferState.ringBuffer.clear()

        // Respawn PTY
        ptyHostClient.spawn(
          {
            id: terminalId,
            shell: shellPath,
            args: shellArgs,
            cwd: terminal.cwd,
            env: {
              ...process.env,
              ...terminal.env,
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
            } as Record<string, string>,
            cols: 80,
            rows: 24,
          },
          (data: string) => {
            restartBufferState.ringBuffer.write(textEncoder.encode(data))

            for (const subscriber of restartBufferState.subscribers.values()) {
              try {
                subscriber(data)
              } catch {
                // Subscriber errors silently ignored
              }
            }
          },
          (exitCode: number, signal: number) => {
            clearGraceTimeout(terminalId)

            runSync(
              Ref.update(terminalsRef, (m) => {
                const next = new Map(m)
                const existing = next.get(terminalId)
                if (existing !== undefined) {
                  next.set(terminalId, {
                    ...existing,
                    status: 'stopped' as const,
                  })
                }
                return next
              })
            )

            emitEvent({
              _tag: 'StatusChanged',
              id: terminalId,
              status: 'stopped',
            })
            emitEvent({ _tag: 'Exited', id: terminalId, exitCode, signal })
          },
          // Spawned callback: store the shell PID for child process detection
          (pid: number) => {
            runSync(
              Ref.update(terminalsRef, (m) => {
                const next = new Map(m)
                const existing = next.get(terminalId)
                if (existing !== undefined) {
                  next.set(terminalId, { ...existing, shellPid: pid })
                }
                return next
              })
            )
          }
        )

        const record: TerminalRecord = {
          id: terminalId,
          workspaceId: terminal.workspaceId,
          command: terminal.command,
          args: [...terminal.args],
          cwd: terminal.cwd,
          hasChildProcess: false,
          status: 'running',
        }

        emitEvent({ _tag: 'Restarted', terminal: record })

        const restartState = bufferStates.get(terminalId)
        if ((restartState?.subscribers.size ?? 0) === 0) {
          scheduleGraceTimeout(terminalId, 'restart')
        }

        yield* Effect.log(`Restarted terminal ${terminalId}`).pipe(
          Effect.annotateLogs('module', logPrefix)
        )

        return record
      })

      // ---------------------------------------------------------------
      // killAllForWorkspace
      // ---------------------------------------------------------------
      const killAllForWorkspace = Effect.fn(
        'TerminalManager.killAllForWorkspace'
      )(function* (workspaceId: string) {
        const map = yield* Ref.get(terminalsRef)

        const runningTerminals: ManagedTerminal[] = []
        for (const terminal of map.values()) {
          if (
            terminal.workspaceId === workspaceId &&
            terminal.status === 'running'
          ) {
            runningTerminals.push(terminal)
          }
        }

        if (runningTerminals.length === 0) {
          return 0
        }

        let killedCount = 0
        yield* Effect.forEach(
          runningTerminals,
          (terminal) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => ptyHostClient.kill(terminal.id))

              yield* Ref.update(terminalsRef, (m) => {
                const next = new Map(m)
                const existing = next.get(terminal.id)
                if (existing !== undefined) {
                  next.set(terminal.id, {
                    ...existing,
                    status: 'stopped' as const,
                  })
                }
                return next
              })

              emitEvent({
                _tag: 'StatusChanged',
                id: terminal.id,
                status: 'stopped',
              })
              clearGraceTimeout(terminal.id)

              killedCount += 1
            }).pipe(
              Effect.tapDefect((cause) =>
                Effect.logWarning(
                  `Failed to kill terminal ${terminal.id} during workspace cleanup: ${Cause.pretty(cause)}`
                )
              )
            ),
          { discard: true }
        )

        yield* Effect.log(
          `Killed ${killedCount}/${runningTerminals.length} terminals for workspace ${workspaceId}`
        )

        return killedCount
      })

      // ---------------------------------------------------------------
      // Graceful shutdown finalizer
      // ---------------------------------------------------------------
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const map = yield* Ref.get(terminalsRef)
          const runningTerminals: ManagedTerminal[] = []

          for (const terminal of map.values()) {
            if (terminal.status === 'running') {
              runningTerminals.push(terminal)
            }
          }

          if (runningTerminals.length === 0) {
            yield* Effect.log('Shutdown: no active terminals to clean up').pipe(
              Effect.annotateLogs('module', logPrefix)
            )
            return
          }

          yield* Effect.log(
            `Shutdown: killing ${runningTerminals.length} active terminal(s)...`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          let killedCount = 0
          yield* Effect.forEach(
            runningTerminals,
            (terminal) =>
              Effect.gen(function* () {
                yield* Effect.sync(() => ptyHostClient.kill(terminal.id))
                killedCount += 1
              }).pipe(
                Effect.tapDefect((cause) =>
                  Effect.logWarning(
                    `Shutdown: failed to kill terminal ${terminal.id}: ${Cause.pretty(cause)}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                )
              ),
            { discard: true }
          )

          yield* Ref.set(terminalsRef, new Map<string, ManagedTerminal>())

          for (const timeoutId of graceTimeouts.values()) {
            clearTimeout(timeoutId)
          }
          graceTimeouts.clear()

          yield* Effect.log(
            `Shutdown: killed ${killedCount}/${runningTerminals.length} terminal(s)`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        })
      )

      // ---------------------------------------------------------------
      // WebSocket subscriber management
      // ---------------------------------------------------------------

      const subscribe = Effect.fn('TerminalManager.subscribe')(function* (
        terminalId: string,
        callback: (data: string) => void
      ) {
        const map = yield* Ref.get(terminalsRef)
        const terminal = map.get(terminalId)

        if (terminal === undefined) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        const state = getOrCreateBufferState(terminalId)
        const subscriberId = crypto.randomUUID()
        state.subscribers.set(subscriberId, callback)
        clearGraceTimeout(terminalId)

        const scrollback = state.ringBuffer.readString()

        yield* Effect.log(
          `WebSocket subscribed to terminal ${terminalId} (subscriber=${subscriberId}, scrollback=${scrollback.length} chars)`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        return { scrollback, subscriberId }
      })

      const unsubscribe = Effect.fn('TerminalManager.unsubscribe')(function* (
        terminalId: string,
        subscriberId: string
      ) {
        const state = bufferStates.get(terminalId)
        if (state !== undefined) {
          state.subscribers.delete(subscriberId)
          if (state.subscribers.size === 0) {
            scheduleGraceTimeout(terminalId, 'disconnect')
          }
        }

        yield* Effect.log(
          `WebSocket unsubscribed from terminal ${terminalId} (subscriber=${subscriberId})`
        ).pipe(Effect.annotateLogs('module', logPrefix))
      })

      const terminalExists = Effect.fn('TerminalManager.terminalExists')(
        function* (terminalId: string) {
          const map = yield* Ref.get(terminalsRef)
          return map.has(terminalId)
        }
      )

      return TerminalManager.of({
        spawn,
        write,
        resize,
        kill,
        remove,
        restart,
        listTerminals,
        killAllForWorkspace,
        subscribe,
        unsubscribe,
        terminalExists,
        lifecycleEvents: lifecyclePubSub,
      })
    })
  )
}

export { TerminalManager }
export type {
  ManagedTerminal,
  OutputSubscriber,
  SpawnPayload,
  TerminalBufferState,
  TerminalExitedEvent,
  TerminalLifecycleEvent,
  TerminalRecord,
  TerminalRemovedEvent,
  TerminalRestartedEvent,
  TerminalSpawnedEvent,
  TerminalStatusChangedEvent,
}
