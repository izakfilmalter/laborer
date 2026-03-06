/**
 * PTY Host — Isolated child process for managing node-pty instances.
 *
 * This script runs as a standalone Node.js subprocess, completely isolated
 * from the main Bun HTTP server process. It communicates via newline-delimited
 * JSON over stdin (commands) and stdout (events). stderr is used for debug
 * logging.
 *
 * Why Node.js instead of Bun: node-pty creates tty.ReadStream on PTY master
 * file descriptors. Bun's tty.ReadStream implementation does not fire data
 * events for these streams, so `onData` never fires — even in an isolated
 * subprocess. Node.js handles tty.ReadStream correctly, so the PTY Host runs
 * under Node.js while the main server continues to run under Bun.
 *
 * Architecture rationale: Running node-pty inside the main HTTP server process
 * causes SIGHUP to kill interactive shells within milliseconds due to event
 * loop and signal handling interference. Process isolation eliminates this.
 *
 * See PRD-pty-host.md for full design details.
 * See PRD-terminal-perf.md for the data coalescing design (Issue #137).
 *
 * IPC Protocol:
 *
 * Commands (stdin, server -> PTY Host):
 *   { type: "spawn", id, shell, args, cwd, env, cols, rows }
 *   { type: "write", id, data }
 *   { type: "resize", id, cols, rows }
 *   { type: "kill", id }
 *   { type: "ack", id, chars }  — flow control acknowledgement (Issue #141)
 *
 * Events (stdout, PTY Host -> server):
 *   { type: "ready" }
 *   { type: "data", id, data }  — data is raw UTF-8 (may be coalesced)
 *   { type: "exit", id, exitCode, signal }
 *   { type: "error", id?, message }
 *   { type: "paused", id }      — PTY paused due to flow control (Issue #141)
 *   { type: "resumed", id }     — PTY resumed after flow control ack (Issue #141)
 */

import { createRequire } from 'node:module'

// Local type declarations for node-pty to avoid a compile-time dependency.
// node-pty is loaded at runtime via createRequire because this script runs
// under Node.js (not Bun). The package may not be installed in all environments.

interface IDisposable {
  dispose(): void
}

interface IPty {
  kill(signal?: string): void
  onData(callback: (data: string) => void): IDisposable
  onExit(
    callback: (exitStatus: { exitCode: number; signal: number }) => void
  ): IDisposable
  pause(): void
  readonly pid: number
  resize(columns: number, rows: number): void
  resume(): void
  write(data: string): void
}

interface INodePtyModule {
  spawn(
    file: string,
    args: readonly string[] | string[],
    options: {
      readonly cols: number
      readonly cwd: string
      readonly env: Record<string, string>
      readonly name: string
      readonly rows: number
    }
  ): IPty
}

// createRequire is needed because this script runs under Node.js as ESM
// (the package has "type": "module"), where bare `require()` is unavailable.
const require_ = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpawnCommand {
  readonly args: readonly string[]
  readonly cols: number
  readonly cwd: string
  readonly env: Record<string, string>
  readonly id: string
  readonly rows: number
  readonly shell: string
  readonly type: 'spawn'
}

interface WriteCommand {
  readonly data: string
  readonly id: string
  readonly type: 'write'
}

interface ResizeCommand {
  readonly cols: number
  readonly id: string
  readonly rows: number
  readonly type: 'resize'
}

interface KillCommand {
  readonly id: string
  readonly type: 'kill'
}

interface AckCommand {
  readonly chars: number
  readonly id: string
  readonly type: 'ack'
}

type Command =
  | SpawnCommand
  | WriteCommand
  | ResizeCommand
  | KillCommand
  | AckCommand

interface ReadyEvent {
  readonly type: 'ready'
}

interface DataEvent {
  readonly data: string // raw UTF-8
  readonly id: string
  readonly type: 'data'
}

interface ExitEvent {
  readonly exitCode: number
  readonly id: string
  readonly signal: number
  readonly type: 'exit'
}

interface ErrorEvent {
  readonly id?: string
  readonly message: string
  readonly type: 'error'
}

interface PausedEvent {
  readonly id: string
  readonly type: 'paused'
}

interface ResumedEvent {
  readonly id: string
  readonly type: 'resumed'
}

type PtyEvent =
  | ReadyEvent
  | DataEvent
  | ExitEvent
  | ErrorEvent
  | PausedEvent
  | ResumedEvent

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ptys = new Map<string, IPty>()

/**
 * Data coalescing buffers per PTY instance.
 *
 * Matches VS Code's `TerminalDataBufferer` pattern (Issue #137,
 * PRD-terminal-perf.md "Data Coalescing in the PTY Host").
 *
 * When `pty.onData` fires: if no buffer exists for that PTY, create one
 * (an array of strings) and start a 5ms `setTimeout`. If a buffer already
 * exists, push the data onto it (the timer is already running). When the
 * timer fires, join all buffered strings, emit a single `data` event,
 * and delete the buffer.
 *
 * This reduces the number of IPC messages by an order of magnitude for
 * burst output while adding imperceptible latency (~5ms) for interactive
 * typing.
 */
const COALESCE_INTERVAL_MS = 5

interface CoalesceBuffer {
  readonly chunks: string[]
  readonly timer: ReturnType<typeof setTimeout>
}

const coalesceBuffers = new Map<string, CoalesceBuffer>()

/**
 * Character-count flow control per PTY instance.
 *
 * Matches VS Code's flow control model (Issue #141,
 * PRD-terminal-perf.md "Character-Count Flow Control").
 *
 * The PTY host tracks `unacknowledgedCharCount` per PTY. Each emitted
 * `data` event increases it by the character count. When it exceeds
 * `HIGH_WATERMARK_CHARS`, `pty.pause()` is called to stop reading from
 * the PTY file descriptor. The OS kernel then applies backpressure to
 * the producing process via the pipe buffer.
 *
 * The web client sends `ack` frames for every `CHAR_COUNT_ACK_SIZE`
 * characters processed. The server forwards these as `{ type: "ack", id, chars }`
 * commands. The PTY host decrements `unacknowledgedCharCount` and resumes
 * the PTY when it drops below `LOW_WATERMARK_CHARS`.
 */
const HIGH_WATERMARK_CHARS = 100_000
const LOW_WATERMARK_CHARS = 5000

interface FlowControlState {
  readonly paused: boolean
  unacknowledgedCharCount: number
}

const flowControlStates = new Map<string, FlowControlState>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a JSON event to stdout (one line per event). */
function emit(event: PtyEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/** Log to stderr for debugging (not part of IPC protocol). */
function debug(message: string, ...args: unknown[]): void {
  console.error(`[pty-host] ${message}`, ...args)
}

// ---------------------------------------------------------------------------
// Data coalescing helpers
// ---------------------------------------------------------------------------

/**
 * Flush any pending coalesced data for a PTY, emitting a single `data` event
 * with all buffered chunks joined together. Updates flow control state
 * (unacknowledgedCharCount) and pauses the PTY if the high watermark is exceeded.
 *
 * Called by:
 * - The coalescing timer (normal flush after 5ms of quiet)
 * - handleResize (flush before resize to preserve dimension association)
 * - pty.onExit (flush remaining data before exit event)
 * - handleKill (flush before kill in case there's pending data)
 */
function flushCoalesceBuffer(id: string): void {
  const buf = coalesceBuffers.get(id)
  if (buf === undefined) {
    return
  }
  clearTimeout(buf.timer)
  coalesceBuffers.delete(id)

  const joined = buf.chunks.join('')
  if (joined.length > 0) {
    emit({ type: 'data', id, data: joined })

    // Update flow control: track unacknowledged characters
    const fcState = flowControlStates.get(id)
    if (fcState !== undefined) {
      fcState.unacknowledgedCharCount += joined.length

      // Pause PTY if high watermark exceeded (Issue #141)
      if (
        !fcState.paused &&
        fcState.unacknowledgedCharCount > HIGH_WATERMARK_CHARS
      ) {
        const pty = ptys.get(id)
        if (pty !== undefined) {
          pty.pause()
          ;(fcState as { paused: boolean }).paused = true
          emit({ type: 'paused', id })
          debug(
            'Flow control: paused PTY id=%s (unacked=%d)',
            id,
            fcState.unacknowledgedCharCount
          )
        }
      }
    }
  }
}

/**
 * Buffer a chunk of PTY output data for coalesced emission.
 *
 * If no buffer exists, creates one and starts a 5ms timer.
 * If a buffer already exists, pushes the chunk onto it.
 * When the timer fires, all buffered chunks are joined and emitted
 * as a single `data` event.
 */
function bufferData(id: string, data: string): void {
  const existing = coalesceBuffers.get(id)
  if (existing !== undefined) {
    existing.chunks.push(data)
    return
  }

  const chunks = [data]
  const timer = setTimeout(() => {
    flushCoalesceBuffer(id)
  }, COALESCE_INTERVAL_MS)

  coalesceBuffers.set(id, { chunks, timer })
}

// ---------------------------------------------------------------------------
// Spawn-helper permission check
// ---------------------------------------------------------------------------

/**
 * Ensure spawn-helper binaries have execute permissions.
 *
 * After `bun install`, the spawn-helper files in node-pty prebuilds may
 * lose their execute bit. This function finds and fixes them on startup,
 * replacing the need for a postinstall script.
 */
async function fixSpawnHelperPermissions(): Promise<void> {
  const { readdir, chmod, stat } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')

  // Resolve the node-pty package directory using the top-level require_
  let nodePtyDir: string
  try {
    const nodePtyMain = require_.resolve('node-pty')
    nodePtyDir = dirname(nodePtyMain)
    // Walk up to the package root (node-pty/lib/index.js -> node-pty/)
    while (nodePtyDir !== '/' && !nodePtyDir.endsWith('node-pty')) {
      nodePtyDir = dirname(nodePtyDir)
    }
  } catch {
    debug('Could not resolve node-pty package path, skipping permission fix')
    return
  }

  const prebuildsDir = join(nodePtyDir, 'prebuilds')

  try {
    const platforms = await readdir(prebuildsDir)
    for (const platform of platforms) {
      const helperPath = join(prebuildsDir, platform, 'spawn-helper')
      try {
        const st = await stat(helperPath)
        // Check if execute bit is missing for owner
        const isExecutable = Boolean(
          // biome-ignore lint/suspicious/noBitwiseOperators: bitwise check for file permissions
          (st.mode ?? 0) & 0o100
        )
        if (!isExecutable) {
          await chmod(helperPath, 0o755)
          debug('Fixed execute permission on %s', helperPath)
        }
      } catch {
        // spawn-helper doesn't exist for this platform, skip
      }
    }
  } catch {
    debug('No prebuilds directory found at %s, skipping', prebuildsDir)
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function handleSpawn(cmd: SpawnCommand): void {
  if (ptys.has(cmd.id)) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `PTY with id "${cmd.id}" already exists`,
    })
    return
  }

  try {
    // Import node-pty synchronously via createRequire (this script runs as
    // ESM under Node.js, so bare require() is not available)
    const nodePty = require_('node-pty') as INodePtyModule

    const pty = nodePty.spawn(cmd.shell, cmd.args as string[], {
      name: 'xterm-256color',
      cols: cmd.cols,
      rows: cmd.rows,
      cwd: cmd.cwd,
      env: cmd.env,
    })

    ptys.set(cmd.id, pty)

    // Initialize flow control state for this PTY (Issue #141)
    flowControlStates.set(cmd.id, {
      unacknowledgedCharCount: 0,
      paused: false,
    })

    // Forward PTY output through the coalescing buffer (Issue #137).
    // node-pty's onData can fire for as little as a single character during
    // interactive typing. The coalescing buffer accumulates chunks and emits
    // a single IPC data event after 5ms of quiet, reducing IPC message count
    // by an order of magnitude for burst output while adding imperceptible
    // latency for interactive use.
    pty.onData((data: string) => {
      bufferData(cmd.id, data)
    })

    // Forward PTY exit — flush any remaining coalesced data first
    pty.onExit(({ exitCode, signal }) => {
      const code = exitCode ?? -1
      const sig = signal ?? -1
      debug('PTY exited id=%s code=%d signal=%d', cmd.id, code, sig)
      // Flush any pending coalesced output before the exit event so
      // consumers see all output before the process is marked as exited.
      flushCoalesceBuffer(cmd.id)
      ptys.delete(cmd.id)
      // Clean up flow control state (Issue #141)
      flowControlStates.delete(cmd.id)
      emit({ type: 'exit', id: cmd.id, exitCode: code, signal: sig })
    })

    debug('Spawned PTY id=%s pid=%d shell=%s', cmd.id, pty.pid, cmd.shell)
  } catch (error) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `Failed to spawn PTY: ${String(error)}`,
    })
  }
}

function handleWrite(cmd: WriteCommand): void {
  const pty = ptys.get(cmd.id)
  if (pty === undefined) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `PTY not found: ${cmd.id}`,
    })
    return
  }

  try {
    pty.write(cmd.data)
  } catch (error) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `Failed to write to PTY: ${String(error)}`,
    })
  }
}

function handleResize(cmd: ResizeCommand): void {
  const pty = ptys.get(cmd.id)
  if (pty === undefined) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `PTY not found: ${cmd.id}`,
    })
    return
  }

  try {
    // Flush any pending coalesced data BEFORE applying the resize.
    // This ensures output is associated with the correct terminal
    // dimensions, matching VS Code's behavior (PRD-terminal-perf.md).
    flushCoalesceBuffer(cmd.id)
    pty.resize(cmd.cols, cmd.rows)
    debug('Resized PTY id=%s cols=%d rows=%d', cmd.id, cmd.cols, cmd.rows)
  } catch (error) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `Failed to resize PTY: ${String(error)}`,
    })
  }
}

function handleKill(cmd: KillCommand): void {
  const pty = ptys.get(cmd.id)
  if (pty === undefined) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `PTY not found: ${cmd.id}`,
    })
    return
  }

  try {
    // Flush any pending coalesced data before killing so no output is lost.
    // The onExit handler also flushes, but flushing here ensures data is
    // emitted even if kill is synchronous on some platforms.
    flushCoalesceBuffer(cmd.id)
    pty.kill()
    debug('Killed PTY id=%s', cmd.id)
    // Note: the onExit handler will emit the exit event and clean up the map
  } catch (error) {
    emit({
      type: 'error',
      id: cmd.id,
      message: `Failed to kill PTY: ${String(error)}`,
    })
  }
}

/**
 * Handle a flow control acknowledgement command (Issue #141).
 *
 * Decrements the unacknowledged character count for the PTY.
 * If the count drops below LOW_WATERMARK_CHARS and the PTY is paused,
 * resumes the PTY so output continues.
 */
function handleAck(cmd: AckCommand): void {
  const fcState = flowControlStates.get(cmd.id)
  if (fcState === undefined) {
    // PTY may have already exited — silently ignore
    return
  }

  fcState.unacknowledgedCharCount = Math.max(
    0,
    fcState.unacknowledgedCharCount - cmd.chars
  )

  // Resume PTY if below low watermark (Issue #141)
  if (fcState.paused && fcState.unacknowledgedCharCount < LOW_WATERMARK_CHARS) {
    const pty = ptys.get(cmd.id)
    if (pty !== undefined) {
      pty.resume()
      ;(fcState as { paused: boolean }).paused = false
      emit({ type: 'resumed', id: cmd.id })
      debug(
        'Flow control: resumed PTY id=%s (unacked=%d)',
        cmd.id,
        fcState.unacknowledgedCharCount
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

function isValidCommand(parsed: unknown): parsed is Command {
  if (typeof parsed !== 'object' || parsed === null) {
    return false
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.type !== 'string') {
    return false
  }

  switch (obj.type) {
    case 'spawn':
      return (
        typeof obj.id === 'string' &&
        typeof obj.shell === 'string' &&
        Array.isArray(obj.args) &&
        typeof obj.cwd === 'string' &&
        typeof obj.env === 'object' &&
        obj.env !== null &&
        typeof obj.cols === 'number' &&
        typeof obj.rows === 'number'
      )
    case 'write':
      return typeof obj.id === 'string' && typeof obj.data === 'string'
    case 'resize':
      return (
        typeof obj.id === 'string' &&
        typeof obj.cols === 'number' &&
        typeof obj.rows === 'number'
      )
    case 'kill':
      return typeof obj.id === 'string'
    case 'ack':
      return typeof obj.id === 'string' && typeof obj.chars === 'number'
    default:
      return false
  }
}

function processLine(line: string): void {
  const trimmed = line.trim()
  if (trimmed === '') {
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    emit({
      type: 'error',
      message: `Invalid JSON: ${trimmed.slice(0, 100)}`,
    })
    return
  }

  if (!isValidCommand(parsed)) {
    emit({
      type: 'error',
      message: `Invalid command: ${trimmed.slice(0, 100)}`,
    })
    return
  }

  switch (parsed.type) {
    case 'spawn':
      handleSpawn(parsed)
      break
    case 'write':
      handleWrite(parsed)
      break
    case 'resize':
      handleResize(parsed)
      break
    case 'kill':
      handleKill(parsed)
      break
    case 'ack':
      handleAck(parsed)
      break
    default:
      // isValidCommand already filters to known types, but satisfy exhaustiveness
      emit({
        type: 'error',
        message: `Unknown command type: ${(parsed as unknown as Record<string, unknown>).type}`,
      })
      break
  }
}

// ---------------------------------------------------------------------------
// Stdin line reader
// ---------------------------------------------------------------------------

/**
 * Read stdin as newline-delimited text and process each line as a command.
 * Uses Node.js process.stdin stream (compatible with Node.js runtime).
 *
 * Uses an array-based accumulator to avoid O(n²) string copying from
 * repeated `buffer += chunk` concatenation under high throughput (Issue #136).
 * Incoming chunks are pushed onto an array and only joined when scanning
 * for newlines. The remainder after draining is kept as a single-element
 * array for the next iteration.
 */
async function readStdin(): Promise<void> {
  const bufferChunks: string[] = []

  for await (const chunk of process.stdin) {
    bufferChunks.push(
      typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf-8')
    )

    // Join accumulated chunks to scan for newlines
    const joined = bufferChunks.join('')
    bufferChunks.length = 0

    let searchStart = 0
    let newlineIdx = joined.indexOf('\n', searchStart)
    while (newlineIdx !== -1) {
      const line = joined.slice(searchStart, newlineIdx)
      processLine(line)
      searchStart = newlineIdx + 1
      newlineIdx = joined.indexOf('\n', searchStart)
    }

    // Keep the remainder (after the last newline) for the next chunk
    if (searchStart < joined.length) {
      bufferChunks.push(joined.slice(searchStart))
    }
  }

  // Process any remaining data after stdin closes
  const remaining = bufferChunks.join('').trim()
  if (remaining !== '') {
    processLine(remaining)
  }

  debug('stdin closed, shutting down')
  // Flush all coalescing buffers and kill all remaining PTYs on shutdown
  for (const [id, pty] of ptys) {
    debug('Cleaning up PTY id=%s on shutdown', id)
    flushCoalesceBuffer(id)
    try {
      pty.kill()
    } catch {
      // Best effort cleanup
    }
  }
  // Clean up any orphaned coalescing buffers (shouldn't happen, but defensive)
  for (const [id, buf] of coalesceBuffers) {
    clearTimeout(buf.timer)
    coalesceBuffers.delete(id)
  }
  ptys.clear()
  flowControlStates.clear()
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  debug('Starting PTY Host (pid=%d)', process.pid)

  // Fix spawn-helper permissions before anything else
  await fixSpawnHelperPermissions()

  // Signal readiness to the parent process
  emit({ type: 'ready' })
  debug('Ready')

  // Start reading commands from stdin
  await readStdin()
}

main().catch((error) => {
  debug('Fatal error: %s', String(error))
  emit({
    type: 'error',
    message: `PTY Host fatal error: ${String(error)}`,
  })
  process.exit(1)
})
