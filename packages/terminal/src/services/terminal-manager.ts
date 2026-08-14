/**
 * TerminalManager — Effect Service (Terminal Package)
 *
 * Manages terminal instances with in-memory-only state.
 * dependency, no WorkspaceProvider dependency. All spawn parameters
 * (command, args, cwd, env, cols, rows) are provided at call time.
 *
 * Key differences from the server's TerminalManager:
 * - Terminal state is ephemeral and in-memory only
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

import { exec } from 'node:child_process'
import {
  type ProcessTimeTimeout,
  scheduleProcessTimeTimeout,
} from '@laborer/shared/process-time-scheduler'
import {
  type AgentStatusReport,
  type AgentStatusSnapshot,
  type TerminalAttachEvent,
  type TerminalHostStatus,
  TerminalRpcError,
} from '@laborer/shared/rpc'
import { Context, Effect, Layer, PubSub, Ref, Schedule } from 'effect'
import { createHeadlessTerminalManager } from '../lib/headless-terminal.js'
import { PtyHostClient } from './pty-host-client.js'
import type {
  SerializedCommandDetectionCapability,
  SerializedReplayEvent,
} from './terminal-session-persistence.js'
import { TerminalStatusEngine } from './terminal-status-engine.js'
import {
  positiveIntegerFromEnv,
  splitByUtf8Bytes,
  TERMINAL_INPUT_PENDING_BYTES_DEFAULT,
  TERMINAL_INPUT_WRITE_BYTES_DEFAULT,
  TERMINAL_OUTPUT_CHUNK_BYTES_DEFAULT,
  TERMINAL_REPLAY_JOURNAL_BYTES_DEFAULT,
  TERMINAL_SNAPSHOT_BYTES_DEFAULT,
  TerminalCursorJournal,
  utf8Bytes,
} from './terminal-transport.js'

/** Logger tag used for structured Effect.log output in this module. */
const logPrefix = 'TerminalManager'

/**
 * Default grace period for orphaned terminals (60 seconds of awake time).
 *
 * Per ADR 0003 this is purely a *leak guard* for freshly spawned terminals
 * that were never claimed by any subscriber (e.g. the spawning client died
 * mid-spawn). A terminal that was claimed once is never an orphan: detached
 * terminals are first-class and must keep running unwatched, and restored
 * terminals proved their ownership in a previous life. Counted in
 * process-alive time so OS sleep never expires the window.
 */
const DEFAULT_TERMINAL_GRACE_PERIOD_MS = 60_000

/** Regex for splitting whitespace in ps output lines. Defined at module level for performance. */
const PS_WHITESPACE_REGEX = /\s+/

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

type AttachSubscriber = (event: TerminalAttachEvent) => boolean

interface TerminalTransportMetrics {
  readonly ackLatencyMs: number
  readonly backlogBytes: number
  readonly resetCount: number
  readonly wsBufferedBytes: number | null
}

/**
 * Internal representation of a managed terminal.
 * Tracks metadata and state. In the terminal package, stopped terminals
 * are retained in memory (not deleted on exit) so restart works without
 * a database.
 */
interface ManagedTerminal {
  readonly args: readonly string[]
  /**
   * Last known column count. Updated on resize so the terminal can
   * be restarted at the correct dimensions (instead of falling back
   * to 80x24).
   */
  readonly cols: number
  readonly command: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly id: string
  /**
   * Last known row count. Updated on resize so the terminal can be
   * restarted at the correct dimensions (instead of falling back
   * to 80x24).
   */
  readonly rows: number
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
 * Per-terminal subscriber state.
 * Subscribers are WebSocket connections receiving live terminal output.
 * State survives terminal exit (retained until explicit removal) so
 * reconnecting clients can receive screen state from the headless terminal.
 */
interface TerminalSubscriberState {
  /**
   * Buffer of raw PTY output captured before any subscriber connected.
   * Replayed to the first subscriber on connect, then set to null.
   *
   * This matches VS Code's `_initialDataEvents` pattern — no data is
   * lost between PTY spawn and the renderer's data channel connecting.
   */
  replayBuffer: string[] | null
  readonly subscribers: Map<string, OutputSubscriber>
}

/**
 * Shape of a terminal record returned by the manager. The RPC encoder strips
 * the internal process identity before records cross the public RPC boundary.
 */
interface TerminalRecord {
  /** Internal process identity used by the agent-status notification feed. */
  readonly agentProcessIds: readonly number[]
  readonly agentStatus: AgentStatusSnapshot | null
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  /**
   * Information about the foreground process running in the terminal.
   * Null when the shell is idle at a prompt or the terminal is stopped.
   */
  readonly foregroundProcess: ForegroundProcess | null
  /**
   * Whether the shell has child processes running. True when processes
   * like vim, dev servers, or AI agents are active inside the terminal.
   * False when the shell is idle at a prompt.
   */
  readonly hasChildProcess: boolean
  readonly id: string
  /**
   * Classified processes along the tree from the shell's first child
   * down to the deepest leaf. Used by the UI to show the full chain,
   * e.g. "OpenCode › biome". Empty when the shell is idle or stopped.
   */
  readonly processChain: readonly ForegroundProcess[]
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
  /**
   * Optional pre-generated terminal ID. When provided, the terminal
   * manager uses this ID instead of generating a new UUID. This allows
   * the caller to inject the terminal ID into the PTY's environment
   * variables before spawn (e.g., for agent hook scripts that need
   * to report back to the terminal service with their terminal ID).
   */
  readonly id?: string | undefined
  /**
   * Marks a spawn performed by session-persistence restoration after a
   * terminal-service restart. Restored terminals are exempt from the
   * orphan leak-guard (ADR 0003): they were claimed in a previous life
   * and must stay alive while waiting to be re-adopted by the renderer.
   */
  readonly restored?: boolean | undefined
  readonly rows: number
  readonly workspaceId: string
}

// ---------------------------------------------------------------------------
// Async Process Detection
// ---------------------------------------------------------------------------

/**
 * Known process categories for terminal sidebar display.
 *
 * - `agent` — AI coding agents (claude, opencode, codex, aider, goose, etc.)
 * - `editor` — Text editors (vim, nvim, nano, emacs, helix, etc.)
 * - `devServer` — Dev servers and build tools (node, bun, deno, python, ruby, etc.)
 * - `shell` — The shell itself (zsh, bash, fish, etc.) — means idle at prompt
 * - `unknown` — A process is running but we don't recognize it
 */
type ProcessCategory = 'agent' | 'editor' | 'devServer' | 'shell' | 'unknown'

/**
 * Information about the foreground process running in a terminal.
 * Returned alongside terminal records for sidebar display.
 */
interface ForegroundProcess {
  /** The category of the detected process. */
  readonly category: ProcessCategory
  /** Human-readable label for display (e.g., "Claude", "vim", "node"). */
  readonly label: string
  /** Raw process name from ps (e.g., "claude", "nvim", "node"). */
  readonly rawName: string
}

/**
 * Map of process names to their display info. The key is the basename
 * of the process (output of `ps -o comm=`). Order doesn't matter since
 * this is a lookup table.
 */
const KNOWN_PROCESSES: ReadonlyMap<
  string,
  { readonly category: ProcessCategory; readonly label: string }
> = new Map([
  // AI Agents
  ['claude', { category: 'agent', label: 'Claude' }],
  ['opencode', { category: 'agent', label: 'OpenCode' }],
  ['opencode2', { category: 'agent', label: 'OpenCode 2' }],
  ['codex', { category: 'agent', label: 'Codex' }],
  ['aider', { category: 'agent', label: 'Aider' }],
  ['goose', { category: 'agent', label: 'Goose' }],
  ['cursor', { category: 'agent', label: 'Cursor' }],
  ['cline', { category: 'agent', label: 'Cline' }],
  ['continue', { category: 'agent', label: 'Continue' }],
  ['amp', { category: 'agent', label: 'Amp' }],
  ['kilo-code', { category: 'agent', label: 'Kilo Code' }],
  ['roo-code', { category: 'agent', label: 'Roo Code' }],
  ['gemini', { category: 'agent', label: 'Gemini' }],

  // Editors
  ['vim', { category: 'editor', label: 'vim' }],
  ['nvim', { category: 'editor', label: 'Neovim' }],
  ['vi', { category: 'editor', label: 'vi' }],
  ['nano', { category: 'editor', label: 'nano' }],
  ['emacs', { category: 'editor', label: 'Emacs' }],
  ['helix', { category: 'editor', label: 'Helix' }],
  ['hx', { category: 'editor', label: 'Helix' }],
  ['micro', { category: 'editor', label: 'micro' }],
  ['kakoune', { category: 'editor', label: 'Kakoune' }],
  ['kak', { category: 'editor', label: 'Kakoune' }],
  ['code', { category: 'editor', label: 'VS Code' }],

  // Dev servers / runtimes / build tools
  ['node', { category: 'devServer', label: 'Node.js' }],
  ['bun', { category: 'devServer', label: 'Bun' }],
  ['deno', { category: 'devServer', label: 'Deno' }],
  ['python', { category: 'devServer', label: 'Python' }],
  ['python3', { category: 'devServer', label: 'Python' }],
  ['ruby', { category: 'devServer', label: 'Ruby' }],
  ['cargo', { category: 'devServer', label: 'Cargo' }],
  ['go', { category: 'devServer', label: 'Go' }],
  ['java', { category: 'devServer', label: 'Java' }],
  ['docker', { category: 'devServer', label: 'Docker' }],
  ['docker-compose', { category: 'devServer', label: 'Docker Compose' }],
  ['npm', { category: 'devServer', label: 'npm' }],
  ['npx', { category: 'devServer', label: 'npx' }],
  ['pnpm', { category: 'devServer', label: 'pnpm' }],
  ['yarn', { category: 'devServer', label: 'yarn' }],
  ['turbo', { category: 'devServer', label: 'Turbo' }],
  ['tsx', { category: 'devServer', label: 'tsx' }],
  ['ts-node', { category: 'devServer', label: 'ts-node' }],
  ['vite', { category: 'devServer', label: 'Vite' }],
  ['next', { category: 'devServer', label: 'Next.js' }],
  ['webpack', { category: 'devServer', label: 'Webpack' }],
  ['esbuild', { category: 'devServer', label: 'esbuild' }],
  ['rollup', { category: 'devServer', label: 'Rollup' }],
  ['jest', { category: 'devServer', label: 'Jest' }],
  ['vitest', { category: 'devServer', label: 'Vitest' }],
  ['pytest', { category: 'devServer', label: 'pytest' }],
  ['make', { category: 'devServer', label: 'make' }],

  // Git tools
  ['git', { category: 'devServer', label: 'git' }],
  ['lazygit', { category: 'devServer', label: 'Lazygit' }],
  ['tig', { category: 'devServer', label: 'tig' }],
  ['gh', { category: 'devServer', label: 'GitHub CLI' }],

  // System tools
  ['ssh', { category: 'devServer', label: 'SSH' }],
  ['htop', { category: 'devServer', label: 'htop' }],
  ['btop', { category: 'devServer', label: 'btop' }],
  ['top', { category: 'devServer', label: 'top' }],
  ['less', { category: 'devServer', label: 'less' }],
  ['man', { category: 'devServer', label: 'man' }],
  ['tmux', { category: 'devServer', label: 'tmux' }],

  // Shells (idle at prompt)
  ['zsh', { category: 'shell', label: 'zsh' }],
  ['bash', { category: 'shell', label: 'bash' }],
  ['fish', { category: 'shell', label: 'fish' }],
  ['sh', { category: 'shell', label: 'sh' }],
  ['dash', { category: 'shell', label: 'dash' }],
  ['nushell', { category: 'shell', label: 'Nushell' }],
  ['nu', { category: 'shell', label: 'Nushell' }],
  ['pwsh', { category: 'shell', label: 'PowerShell' }],
])

/**
 * Classify a process name into a ForegroundProcess descriptor.
 * Returns null if the name is empty.
 */
const classifyProcess = (processName: string): ForegroundProcess | null => {
  if (processName === '') {
    return null
  }

  // Extract basename (ps -o comm= may return full path on some systems)
  const basename = processName.split('/').pop() ?? processName

  // Normalize to lowercase for case-insensitive matching.
  // macOS `ps -o comm=` may report binaries with mixed case (e.g. "OpenCode")
  // depending on how the binary is named on disk. The KNOWN_PROCESSES map
  // and downstream icon lookups (AGENT_ICON_BY_RAW_NAME) use lowercase keys.
  const normalized = basename.toLowerCase()

  const known = KNOWN_PROCESSES.get(normalized)
  if (known !== undefined) {
    return {
      category: known.category,
      label: known.label,
      rawName: normalized,
    }
  }

  // Unknown process — use the original basename for the display label
  // but lowercase rawName so downstream lookups are consistent.
  return {
    category: 'unknown',
    label: basename,
    rawName: normalized,
  }
}

/**
 * Run a shell command asynchronously and return stdout.
 * Returns null if the command fails (e.g., pgrep with no matches exits 1).
 */
const execAsync = (command: string): Promise<string | null> =>
  new Promise((resolve) => {
    exec(command, { encoding: 'utf-8', timeout: 3000 }, (error, stdout) => {
      if (error !== null) {
        resolve(null)
        return
      }
      resolve(stdout.trim())
    })
  })

/**
 * Result of process detection for a single terminal.
 * Computed asynchronously and cached on the TerminalRecord.
 */
interface ProcessDetectionResult {
  /** PIDs of every recognized agent found in the bounded process-tree walk. */
  readonly agentProcessIds: readonly number[]
  readonly foregroundProcess: ForegroundProcess | null
  readonly hasChildProcess: boolean
  /**
   * Classified processes along the tree from the shell's first child
   * down to the deepest leaf. Used by the UI to show the full chain,
   * e.g. "OpenCode › biome". Only includes non-shell processes that
   * classified successfully; shells in the middle are skipped.
   */
  readonly processChain: readonly ForegroundProcess[]
}

/** Default detection result when process info is unavailable. */
const EMPTY_DETECTION: ProcessDetectionResult = {
  agentProcessIds: [],
  foregroundProcess: null,
  hasChildProcess: false,
  processChain: [],
}

/**
 * Parse `ps -eo pid=,ppid=,comm=` output into lookup maps.
 *
 * Returns a parent→children map and a pid→comm map for in-memory
 * process tree walking.
 */
const parsePsOutput = (
  psOutput: string
): {
  childrenByPid: Map<number, number[]>
  commByPid: Map<number, string>
} => {
  const childrenByPid = new Map<number, number[]>()
  const commByPid = new Map<number, string>()

  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }

    // Format: "  PID  PPID COMM" — fields are whitespace-separated
    // PID and PPID are numeric, COMM may contain spaces
    const parts = trimmed.split(PS_WHITESPACE_REGEX)
    if (parts.length < 3) {
      continue
    }

    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    // comm is everything after pid and ppid — rejoin in case of spaces
    const comm = parts.slice(2).join(' ')

    if (!(Number.isFinite(pid) && Number.isFinite(ppid))) {
      continue
    }

    commByPid.set(pid, comm)

    const existing = childrenByPid.get(ppid)
    if (existing !== undefined) {
      existing.push(pid)
    } else {
      childrenByPid.set(ppid, [pid])
    }
  }

  return { childrenByPid, commByPid }
}

/**
 * Classify a PID and push to chain if it's a non-shell process.
 */
const classifyAndCollect = (
  pid: number,
  commByPid: ReadonlyMap<number, string>,
  chain: ForegroundProcess[]
): ForegroundProcess | null => {
  const comm = commByPid.get(pid) ?? ''
  const classified = classifyProcess(comm)
  if (classified !== null && classified.category !== 'shell') {
    chain.push(classified)
  }
  return classified
}

/**
 * Walk every branch of a process tree with hard depth and width bounds.
 * The breadth-first order is stable because `ps` order is stable, and is
 * flattened for the existing process-chain presentation.
 */
const walkProcessTree = (
  startPids: readonly number[],
  childrenByPid: ReadonlyMap<number, number[]>,
  commByPid: ReadonlyMap<number, string>,
  chain: ForegroundProcess[],
  agentProcessIds: number[],
  visitedPids: Set<number>
): void => {
  const MAX_DEPTH = 10
  const MAX_PROCESSES = 256
  const queue: Array<{ readonly depth: number; readonly pid: number }> =
    startPids.slice(0, MAX_PROCESSES).map((pid) => ({ pid, depth: 0 }))

  while (queue.length > 0 && visitedPids.size < MAX_PROCESSES) {
    const next = queue.shift()
    if (next === undefined) {
      break
    }
    if (visitedPids.has(next.pid)) {
      continue
    }
    visitedPids.add(next.pid)
    const classified = classifyAndCollect(next.pid, commByPid, chain)
    if (classified?.category === 'agent') {
      agentProcessIds.push(next.pid)
    }
    if (next.depth >= MAX_DEPTH) {
      continue
    }
    for (const childPid of childrenByPid.get(next.pid) ?? []) {
      if (queue.length + visitedPids.size >= MAX_PROCESSES) {
        break
      }
      queue.push({ pid: childPid, depth: next.depth + 1 })
    }
  }
}

/**
 * Walk the process tree from a shell PID to find the deepest child and
 * classify it. Collects all classified non-shell processes along the
 * chain for display (e.g., "OpenCode › biome"). Uses the pre-built
 * maps from parsePsOutput.
 */
const detectForShellPid = (
  shellPid: number,
  childrenByPid: ReadonlyMap<number, number[]>,
  commByPid: ReadonlyMap<number, string>
): ProcessDetectionResult => {
  const children = childrenByPid.get(shellPid)
  const hasChildren = children !== undefined && children.length > 0

  // Check if the shell PID has been exec-replaced by a non-shell process.
  // This happens with `zsh -c opencode` where zsh exec's into opencode,
  // so the shellPid IS the agent process. We need to include it in the
  // chain so the UI shows e.g. "OpenCode › Node.js › biome" instead of
  // just "Node.js › biome".
  const shellComm = commByPid.get(shellPid) ?? ''
  const shellClassified = classifyProcess(shellComm)
  const isExecReplaced =
    shellClassified !== null && shellClassified.category !== 'shell'

  if (hasChildren) {
    const chain: ForegroundProcess[] = []
    const agentProcessIds: number[] = []
    const visitedPids = new Set<number>()

    // If the shell was exec-replaced (e.g., zsh → opencode), include the
    // exec'd process as the root of the chain before walking children.
    if (isExecReplaced) {
      chain.push(shellClassified)
      if (shellClassified.category === 'agent') {
        agentProcessIds.push(shellPid)
      }
    }

    // Seed one breadth-first walk with every direct child. Walking each root
    // separately would let a single wide first branch consume the process
    // bound before a later shallow branch (including an agent) was inspected.
    walkProcessTree(
      children,
      childrenByPid,
      commByPid,
      chain,
      agentProcessIds,
      visitedPids
    )

    return {
      agentProcessIds,
      foregroundProcess: chain.at(-1) ?? null,
      hasChildProcess: true,
      processChain: chain,
    }
  }

  if (!isExecReplaced) {
    return EMPTY_DETECTION
  }

  // Shell exec'd into another process (e.g., sh -c cat -> cat). There is no
  // child process beneath the original shell PID, but the terminal still has
  // an active foreground process and should require close confirmation.
  return {
    agentProcessIds: shellClassified.category === 'agent' ? [shellPid] : [],
    foregroundProcess: shellClassified,
    hasChildProcess: true,
    processChain: [shellClassified],
  }
}

/**
 * Detect foreground process and child process status for all given shell PIDs
 * using a single async `ps` call, then walk the process tree in memory.
 *
 * Instead of spawning N×12 synchronous `execSync` calls per terminal (which
 * blocks the event loop), this function:
 * 1. Collects all shell PIDs
 * 2. Runs ONE async `ps` to get the full process tree for all PIDs
 * 3. Builds a parent→children map in memory
 * 4. Walks the tree per terminal to find the deepest child
 *
 * This turns O(N×12) synchronous shell spawns into O(1) async shell spawn,
 * keeping the Node.js event loop free for terminal data throughput.
 */
interface ProcessDetectionBatch {
  readonly available: boolean
  readonly results: ReadonlyMap<string, ProcessDetectionResult>
}

const detectProcessesForPids = async (
  shellPids: ReadonlyMap<string, number>
): Promise<ProcessDetectionBatch> => {
  const results = new Map<string, ProcessDetectionResult>()

  if (shellPids.size === 0) {
    return { available: true, results }
  }

  // Single async ps call to get the full process table.
  // `ps -eo pid=,ppid=,comm=` is faster than multiple targeted calls
  // because it's a single fork+exec. We then filter in memory.
  const psOutput = await execAsync('ps -eo pid=,ppid=,comm=')

  if (psOutput === null) {
    return { available: false, results }
  }

  const { childrenByPid, commByPid } = parsePsOutput(psOutput)

  for (const [terminalId, shellPid] of shellPids) {
    results.set(
      terminalId,
      detectForShellPid(shellPid, childrenByPid, commByPid)
    )
  }

  return { available: true, results }
}

/**
 * Heuristic: classify whether a terminal title indicates an idle shell prompt.
 * Shells typically set title to shell name, cwd, or user@host:path when idle.
 *
 * Returns true for titles like:
 * - Empty string
 * - Paths starting with / or ~ (cwd)
 * - user@host:path patterns (SSH-style prompts)
 * - Shell names (bash, zsh, fish, sh, pwsh, powershell)
 *
 * Returns false for titles like "opencode", "vim main.ts", "npm run build"
 * (active command names).
 *
 * @see .reference/mux/src/node/services/terminalService.ts — isIdleTitle
 */
const IDLE_SHELL_REGEX = /^(bash|zsh|fish|sh|pwsh|powershell)$/i
const SSH_PROMPT_REGEX = /^[^\s@]+@[^\s:]+:/

const isIdleTitle = (title: string): boolean => {
  const trimmed = title.trim()
  if (trimmed.length === 0) {
    return true
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
    return true
  }
  if (SSH_PROMPT_REGEX.test(trimmed)) {
    return true
  }
  if (IDLE_SHELL_REGEX.test(trimmed)) {
    return true
  }
  return false
}

/**
 * Build a ProcessDetectionResult from an OSC title change.
 *
 * This function is the safety boundary between OSC-based (heuristic) and
 * ps-based (authoritative) process detection. The key invariant:
 *
 * **OSC detection may only UPGRADE hasChildProcess (false->true), never
 * DOWNGRADE it (true->false).** Only the ps-based detection fiber has
 * authority to set hasChildProcess=false because it actually checks
 * the OS process tree via `ps -eo pid=,ppid=,comm=`.
 *
 * When the title looks idle, we preserve hasChildProcess from the last
 * ps snapshot. If no snapshot exists yet, returns null to signal that
 * no emission should occur — let the ps fiber establish the baseline.
 *
 * @param title - The terminal title from OSC 0/2
 * @param previousSnapshot - The last ps-based detection result (may be undefined)
 * @returns Detection result, or null to skip emission
 */
const buildDetectionFromTitle = (
  title: string,
  previousSnapshot: ProcessDetectionResult | undefined
): ProcessDetectionResult | null => {
  const idle = isIdleTitle(title)

  if (idle) {
    // No ps snapshot yet — skip emission so the ps fiber establishes
    // the authoritative baseline first.
    if (previousSnapshot === undefined) {
      return null
    }
    // Preserve ps-based hasChildProcess — never downgrade to false.
    return {
      agentProcessIds: previousSnapshot.agentProcessIds,
      foregroundProcess: null,
      hasChildProcess: previousSnapshot.hasChildProcess,
      processChain: previousSnapshot.processChain,
    }
  }

  // Non-idle title — classify the process
  const classified = classifyProcess(title)
  if (classified !== null && classified.category !== 'shell') {
    return {
      agentProcessIds:
        classified.category === 'agent'
          ? (previousSnapshot?.agentProcessIds ?? [])
          : [],
      foregroundProcess: classified,
      hasChildProcess: true,
      processChain: [classified],
    }
  }

  // Unknown or shell process in title — upgrade but never downgrade
  const hasChild =
    classified !== null || (previousSnapshot?.hasChildProcess ?? false)
  return {
    agentProcessIds: previousSnapshot?.agentProcessIds ?? [],
    foregroundProcess: classified,
    hasChildProcess: hasChild,
    processChain:
      classified !== null
        ? [classified]
        : (previousSnapshot?.processChain ?? []),
  }
}

/**
 * Fallback timeout for non-OSC shells. When a terminal has not received
 * any OSC title or prompt signals, the newline-based "running" heuristic
 * auto-resets to idle after this duration. Prevents permanent false-running
 * state in shells that don't set the terminal title.
 *
 * @see .reference/mux/src/constants/terminalActivity.ts
 */
const NO_OSC_IDLE_FALLBACK_MS = 10_000

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

/**
 * Emitted by the background detection fiber when a terminal's process
 * state changes (foreground process, agent status, child process
 * presence, or process chain). Carries the full TerminalRecord so
 * subscribers can replace local state in one shot.
 */
interface TerminalProcessChangedEvent {
  readonly _tag: 'ProcessChanged'
  readonly terminal: TerminalRecord
}

type TerminalLifecycleEvent =
  | TerminalSpawnedEvent
  | TerminalStatusChangedEvent
  | TerminalExitedEvent
  | TerminalRemovedEvent
  | TerminalRestartedEvent
  | TerminalProcessChangedEvent

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

class TerminalManager extends Context.Service<
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

    readonly attach: (
      terminalId: string,
      options: {
        readonly cursor?: number
        readonly epoch?: string
        readonly leaseId?: string
      },
      subscriber: AttachSubscriber
    ) => Effect.Effect<{ readonly subscriberId: string }, TerminalRpcError>

    readonly acknowledge: (
      terminalId: string,
      leaseId: string,
      cursor: number
    ) => Effect.Effect<void, TerminalRpcError>

    readonly transportMetrics: (
      terminalId: string
    ) => Effect.Effect<TerminalTransportMetrics, TerminalRpcError>

    /** Detached host health. Direct/in-process managers are always healthy. */
    readonly hostStatus: () => Effect.Effect<
      TerminalHostStatus,
      TerminalRpcError
    >

    /** Explicitly checkpoint and restart the detached host. */
    readonly restartHost: () => Effect.Effect<
      TerminalHostStatus,
      TerminalRpcError
    >

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
     * Get the serialized screen state for a terminal as a compact VT
     * escape sequence string (~4KB). Used by the WebSocket attach
     * protocol for fast reconnection instead of replaying the full
     * ring buffer.
     *
     * Returns empty string if the terminal does not exist or has no output.
     */
    readonly getScreenState: (terminalId: string) => string

    /** Get serialized command detection state inferred from shell integration. */
    readonly getCommandDetectionState: (
      terminalId: string
    ) => SerializedCommandDetectionCapability | undefined

    /**
     * Subscribe to live terminal output for a WebSocket connection.
     * Returns a subscriber ID. The callback begins receiving live
     * output immediately after registration.
     *
     * For reconnection, callers should use `getScreenState()` to
     * obtain a compact screen state snapshot after subscribing
     * (subscribe-before-serialize pattern for race-free attach).
     */
    readonly subscribe: (
      terminalId: string,
      callback: (data: string) => void,
      options?: { readonly replay?: boolean }
    ) => Effect.Effect<{ readonly subscriberId: string }, TerminalRpcError>

    /** Unsubscribe a WebSocket connection from terminal output. */
    readonly unsubscribe: (
      terminalId: string,
      subscriberId: string
    ) => Effect.Effect<void>

    /**
     * Force a full screen redraw by re-issuing the PTY's current
     * dimensions. This triggers SIGWINCH, causing TUI applications
     * to perform a complete screen repaint. Used after a data channel
     * connects to ensure the renderer gets a full initial render
     * instead of just incremental updates.
     */
    readonly forceRedraw: (
      terminalId: string
    ) => Effect.Effect<void, TerminalRpcError>

    /** Check if a terminal exists (running or stopped). */
    readonly terminalExists: (terminalId: string) => Effect.Effect<boolean>

    /**
     * Set agent status for a terminal from an external hook.
     *
     * Agent CLIs (Claude Code, OpenCode, etc.) call this via the
     * `POST /hook/agent-status` HTTP endpoint to report lifecycle
     * transitions. Hook-reported status takes priority over the
     * ps-based detection in `listTerminals`.
     *
     * Reports carry a semantic status and a monotonically increasing
     * sequence. Their authority remains scoped to the detected agent process.
     */
    readonly setAgentStatusFromHook: (
      terminalId: string,
      report: AgentStatusReport
    ) => Effect.Effect<void, TerminalRpcError>

    /** Replace the set of workspaces visible in focused app windows. */
    readonly setObservedWorkspaces: (
      workspaceIds: ReadonlySet<string>
    ) => Effect.Effect<void>

    /** Refresh one RPC client's focused-workspace presence lease. */
    readonly reportWorkspacePresence: (
      clientId: string,
      sequence: number,
      workspaceIds: ReadonlySet<string>
    ) => Effect.Effect<void>

    /**
     * Get all terminal metadata without process detection.
     * Returns the raw ManagedTerminal data synchronously via an Effect.
     * Used for session persistence serialization on graceful shutdown.
     */
    readonly getTerminals: () => Effect.Effect<readonly ManagedTerminal[]>

    /** Store replay data to deliver when a revived terminal first attaches. */
    readonly setRevivedReplayEvent: (
      terminalId: string,
      replayEvent: SerializedReplayEvent
    ) => Effect.Effect<void, TerminalRpcError>

    /** Take the pending replay data for a revived terminal, if any. */
    readonly takeRevivedReplayEvent: (
      terminalId: string
    ) => Effect.Effect<SerializedReplayEvent | undefined, TerminalRpcError>

    /** The PubSub for lifecycle events. Consumers subscribe to receive events. */
    readonly lifecycleEvents: PubSub.PubSub<TerminalLifecycleEvent>
  }
>()('@laborer/terminal/TerminalManager') {
  static readonly layer = Layer.effect(
    TerminalManager,
    Effect.gen(function* () {
      const ptyHostClient = yield* PtyHostClient
      const gracePeriodMs = parseGracePeriodMs()
      const journalBytes = positiveIntegerFromEnv(
        'TERMINAL_REPLAY_JOURNAL_BYTES',
        TERMINAL_REPLAY_JOURNAL_BYTES_DEFAULT
      )
      const outputChunkBytes = positiveIntegerFromEnv(
        'TERMINAL_OUTPUT_CHUNK_BYTES',
        TERMINAL_OUTPUT_CHUNK_BYTES_DEFAULT
      )
      const snapshotBytes = positiveIntegerFromEnv(
        'TERMINAL_SNAPSHOT_BYTES',
        TERMINAL_SNAPSHOT_BYTES_DEFAULT
      )
      const inputWriteBytes = positiveIntegerFromEnv(
        'TERMINAL_INPUT_WRITE_BYTES',
        TERMINAL_INPUT_WRITE_BYTES_DEFAULT
      )
      const inputPendingBytes = positiveIntegerFromEnv(
        'TERMINAL_INPUT_PENDING_BYTES',
        TERMINAL_INPUT_PENDING_BYTES_DEFAULT
      )
      if (
        outputChunkBytes > journalBytes ||
        inputWriteBytes > inputPendingBytes
      ) {
        return yield* Effect.die(
          'Terminal transport bounds invalid: chunks must fit journals and writes must fit pending queues'
        )
      }

      const context = yield* Effect.context<never>()
      const runSync = Effect.runSyncWith(context)
      const runFork = Effect.runForkWith(context)

      // In-memory map of terminal ID → ManagedTerminal.
      // Both running AND stopped terminals are stored here.
      const terminalsRef = yield* Ref.make(new Map<string, ManagedTerminal>())

      const statusEngines = new Map<string, TerminalStatusEngine>()
      let observedWorkspaceIds: ReadonlySet<string> = new Set()
      const workspacePresence = new Map<
        string,
        {
          readonly sequence: number
          readonly timer: ReturnType<typeof setTimeout>
          readonly workspaceIds: ReadonlySet<string>
        }
      >()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const presence of workspacePresence.values()) {
            clearTimeout(presence.timer)
          }
          workspacePresence.clear()
        })
      )
      const getStatusEngine = (terminalId: string): TerminalStatusEngine => {
        let engine = statusEngines.get(terminalId)
        if (engine === undefined) {
          engine = new TerminalStatusEngine()
          const terminal = runSync(Ref.get(terminalsRef)).get(terminalId)
          engine.setObserved(
            terminal !== undefined &&
              observedWorkspaceIds.has(terminal.workspaceId)
          )
          statusEngines.set(terminalId, engine)
        }
        return engine
      }

      // Per-terminal subscriber state (WebSocket connections).
      const subscriberStates = new Map<string, TerminalSubscriberState>()
      const attachSubscribers = new Map<string, Map<string, AttachSubscriber>>()
      const journals = new Map<string, TerminalCursorJournal>()
      const transportEpochs = new Map<string, string>()
      const parsedCursors = new Map<string, number>()
      const acknowledgedCursors = new Map<string, number>()
      const leaseCursors = new Map<string, Map<string, number>>()
      const oldestUnackedAt = new Map<string, number>()
      const resetCounts = new Map<string, number>()
      const ackLatencies = new Map<string, number>()
      const revivedReplayEvents = new Map<string, SerializedReplayEvent>()
      const graceTimeouts = new Map<string, ProcessTimeTimeout>()

      // -------------------------------------------------------------------
      // OSC-based activity detection state (follows Mux pattern)
      //
      // Supplements the 200ms ps-based detection with instant title-based
      // detection. When a shell or program sets the terminal title via
      // OSC 0/2, the headless terminal fires the title callback. The
      // title is classified as idle or running and an immediate
      // ProcessChanged event is emitted so the sidebar updates instantly.
      //
      // Tracks which terminals have received OSC signals so we can skip
      // the fallback timer for OSC-capable shells.
      // -------------------------------------------------------------------
      const sessionsWithOscActivity = new Set<string>()
      const noOscIdleFallbacks = new Map<
        string,
        ReturnType<typeof setTimeout>
      >()

      /**
       * Per-terminal title derived from OSC 0/2 title changes.
       * Used to build a ForegroundProcess from the title when ps-based
       * detection hasn't run yet or the title provides better info.
       */
      const oscTitleMap = new Map<string, string>()

      /**
       * Per-terminal OSC prompt state from OSC 133 semantic markers.
       * When a compatible shell emits prompt markers, we know instantly
       * whether the terminal is idle or running a command.
       */
      const oscPromptState = new Map<string, 'idle' | 'running'>()

      /**
       * Handle an OSC title change. Classifies the title as idle or
       * running and immediately triggers a detection re-evaluation for
       * the terminal by directly emitting a ProcessChanged event.
       */
      const handleOscTitleChange = (
        terminalId: string,
        title: string
      ): void => {
        sessionsWithOscActivity.add(terminalId)
        // Clear any no-OSC fallback timer since this shell supports OSC
        const fallback = noOscIdleFallbacks.get(terminalId)
        if (fallback !== undefined) {
          clearTimeout(fallback)
          noOscIdleFallbacks.delete(terminalId)
        }

        oscTitleMap.set(terminalId, title)

        // Immediately trigger a detection re-evaluation by emitting
        // a ProcessChanged event with the title-derived process info.
        emitTitleBasedProcessChanged(terminalId, title)
      }

      /**
       * Handle an OSC 133 semantic prompt state change.
       */
      const handleOscPromptState = (
        terminalId: string,
        state: 'idle' | 'running'
      ): void => {
        sessionsWithOscActivity.add(terminalId)
        const fallback = noOscIdleFallbacks.get(terminalId)
        if (fallback !== undefined) {
          clearTimeout(fallback)
          noOscIdleFallbacks.delete(terminalId)
        }

        oscPromptState.set(terminalId, state)

        if (state === 'idle') {
          // When prompt returns to idle, clear the OSC title so the
          // ps-based detection takes over with its full process chain.
          oscTitleMap.delete(terminalId)
          emitTitleBasedProcessChanged(terminalId, '')
        }
      }

      /**
       * Emit a ProcessChanged event based on OSC title classification.
       * Called when the headless terminal detects a title change. Uses
       * the title to build a ForegroundProcess and immediately emits
       * so the sidebar updates without waiting for the next ps tick.
       *
       * Delegates to `buildDetectionFromTitle` which enforces the key
       * invariant: OSC may upgrade hasChildProcess but never downgrade it.
       */
      const emitTitleBasedProcessChanged = (
        terminalId: string,
        title: string
      ): void => {
        const map = runSync(Ref.get(terminalsRef))
        const terminal = map.get(terminalId)
        if (terminal === undefined || terminal.status !== 'running') {
          return
        }

        const previousSnapshot = lastProcessSnapshot.get(terminalId)
        const detected = buildDetectionFromTitle(title, previousSnapshot)

        // null means "skip emission" — no ps baseline yet
        if (detected === null) {
          return
        }

        // Update the snapshot so the next ps-based detection tick can
        // diff against the latest state. The ps tick will override
        // hasChildProcess with its own authoritative result.
        lastProcessSnapshot.set(terminalId, detected)

        const record = toTerminalRecord(terminal, detected)
        const json = JSON.stringify(record)
        const previous = lastRecordJson.get(terminalId)

        if (json !== previous) {
          lastRecordJson.set(terminalId, json)
          emitEvent({ _tag: 'ProcessChanged', terminal: record })
        }
      }

      const shellIntegrationNonce = crypto.randomUUID()

      // Headless terminal state manager for compact screen state
      // serialization (~4KB), backend device query handling, and
      // OSC-based title/prompt activity detection.
      const headlessManager = createHeadlessTerminalManager({
        onTitleChange: handleOscTitleChange,
        onPromptState: handleOscPromptState,
        shellIntegrationNonce,
      })

      // Lifecycle event PubSub — unbounded so publishers never block.
      const lifecyclePubSub = yield* PubSub.unbounded<TerminalLifecycleEvent>()

      /** Publish a lifecycle event (fire-and-forget). */
      const emitEvent = (event: TerminalLifecycleEvent): void => {
        runFork(PubSub.publish(lifecyclePubSub, event))
      }

      /** Emit semantic completion before the terminal stop clears status. */
      const emitAgentCompletionBeforeStop = (terminalId: string): void => {
        const engine = statusEngines.get(terminalId)
        const terminal = runSync(Ref.get(terminalsRef)).get(terminalId)
        if (terminal === undefined) {
          return
        }
        // Every exit invalidates the last live-process sample, including
        // explicit kills where the status engine was deliberately removed.
        // Otherwise list hydration can expose a stopped terminal with stale
        // child-process metadata until another process tick happens.
        lastProcessSnapshot.set(terminalId, EMPTY_DETECTION)
        if (engine === undefined || engine.processExited(Date.now()) === null) {
          return
        }
        emitEvent({
          _tag: 'ProcessChanged',
          // The PTY has already exited when this callback runs. Publish the
          // final status in the full replacement record as well as in the
          // following StatusChanged event, so independent PubSub scheduling
          // cannot leave a renderer showing this terminal as running.
          terminal: {
            ...toTerminalRecord(terminal, EMPTY_DETECTION),
            status: 'stopped',
          },
        })
      }

      const getOrCreateSubscriberState = (
        terminalId: string
      ): TerminalSubscriberState => {
        let state = subscriberStates.get(terminalId)
        if (state === undefined) {
          state = {
            subscribers: new Map(),
            // Start buffering PTY output until the first subscriber connects.
            // This matches VS Code's _initialDataEvents pattern.
            replayBuffer: [],
          }
          subscriberStates.set(terminalId, state)
        }
        return state
      }

      const journalFor = (terminalId: string): TerminalCursorJournal => {
        let journal = journals.get(terminalId)
        if (!journal) {
          journal = new TerminalCursorJournal(journalBytes)
          journals.set(terminalId, journal)
        }
        return journal
      }

      const transportEpochFor = (terminalId: string): string => {
        let epoch = transportEpochs.get(terminalId)
        if (epoch === undefined) {
          epoch = process.env.LABORER_PTY_HOST_EPOCH ?? crypto.randomUUID()
          transportEpochs.set(terminalId, epoch)
        }
        return epoch
      }

      const removeAttachSubscriber = (
        terminalId: string,
        subscriberId: string
      ): boolean => {
        const subscribers = attachSubscribers.get(terminalId)
        if (subscribers?.delete(subscriberId) !== true) {
          return false
        }
        ptyHostClient.detachFlowControlConsumer(terminalId)
        const cursors = leaseCursors.get(terminalId)
        cursors?.delete(subscriberId)
        if (cursors?.size === 0) {
          leaseCursors.delete(terminalId)
          acknowledgedCursors.set(terminalId, journalFor(terminalId).cursor)
        } else if (cursors !== undefined) {
          const journal = journalFor(terminalId)
          const previous =
            acknowledgedCursors.get(terminalId) ?? journal.minimumCursor
          const committed = Math.min(...cursors.values())
          const chars = journal.charactersBetween(previous, committed)
          if (chars > 0) {
            ptyHostClient.ack(terminalId, chars)
          }
          acknowledgedCursors.set(terminalId, committed)
        }
        if (subscribers.size === 0) {
          attachSubscribers.delete(terminalId)
        }
        return true
      }

      const publishAttachEvent = (
        terminalId: string,
        event: TerminalAttachEvent
      ): void => {
        const subscribers = attachSubscribers.get(terminalId)
        if (!subscribers) {
          return
        }
        for (const [id, subscriber] of subscribers) {
          if (!subscriber(event)) {
            removeAttachSubscriber(terminalId, id)
          }
        }
      }

      const processOutput = (
        terminalId: string,
        data: string,
        legacyState: TerminalSubscriberState
      ): void => {
        for (const chunk of splitByUtf8Bytes(data, outputChunkBytes)) {
          const journal = journalFor(terminalId)
          const cursor = journal.append(chunk)
          headlessManager.write(terminalId, chunk, () => {
            parsedCursors.set(terminalId, cursor)
          })
          if (legacyState.replayBuffer !== null) {
            legacyState.replayBuffer.push(chunk)
          }
          for (const subscriber of legacyState.subscribers.values()) {
            try {
              subscriber(chunk)
            } catch {
              // A failed compatibility subscriber is cleaned up by its owner.
            }
          }
          if ((attachSubscribers.get(terminalId)?.size ?? 0) > 0) {
            oldestUnackedAt.set(
              terminalId,
              oldestUnackedAt.get(terminalId) ?? Date.now()
            )
          }
          publishAttachEvent(terminalId, { _tag: 'Delta', cursor, data: chunk })
        }
      }

      const clearGraceTimeout = (terminalId: string): void => {
        const timeout = graceTimeouts.get(terminalId)
        if (timeout !== undefined) {
          timeout.cancel()
          graceTimeouts.delete(terminalId)
        }
      }

      /**
       * Arm the orphan leak-guard for a freshly spawned terminal.
       *
       * Per ADR 0003 this is the ONLY heuristic that may kill a terminal:
       * a fresh spawn that no subscriber ever claimed within the grace
       * window (the spawning client died mid-spawn). The first subscribe
       * disarms it permanently — a terminal that was claimed once is
       * never reaped again, no matter how long it runs unwatched.
       * Restored terminals are never armed (they were claimed in a
       * previous life). The countdown is in process-alive time, so OS
       * sleep never expires the window.
       */
      const scheduleOrphanTimeout = (terminalId: string): void => {
        clearGraceTimeout(terminalId)

        const timeout = scheduleProcessTimeTimeout(() => {
          runFork(
            Effect.gen(function* () {
              const map = yield* Ref.get(terminalsRef)
              const terminal = map.get(terminalId)

              if (terminal === undefined || terminal.status !== 'running') {
                return
              }

              const state = subscriberStates.get(terminalId)
              if ((state?.subscribers.size ?? 0) > 0) {
                return
              }

              // An orphan reap is an explicit lifecycle action, not evidence
              // that an agent completed. Clear advisory status before the PTY
              // exit callback runs so it cannot synthesize Done.
              statusEngines.delete(terminalId)
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
                `Orphan grace period expired (${gracePeriodMs}ms awake, never claimed) — killed terminal ${terminalId}`
              ).pipe(Effect.annotateLogs('module', logPrefix))
            }).pipe(
              Effect.tapDefect((cause) =>
                Effect.logWarning(
                  `Failed grace-period cleanup for terminal ${terminalId}: ${String(cause)}`
                ).pipe(Effect.annotateLogs('module', logPrefix))
              )
            )
          )
        }, gracePeriodMs)

        graceTimeouts.set(terminalId, timeout)
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
          id: providedId,
          rows,
          workspaceId,
        } = payload

        const id = providedId ?? crypto.randomUUID()

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
          cols,
          cwd,
          env: { ...env },
          rows,
          shellPid: undefined,
          status: 'running',
        }

        yield* Ref.update(terminalsRef, (map) => {
          const next = new Map(map)
          next.set(id, managedTerminal)
          return next
        })

        const subState = getOrCreateSubscriberState(id)

        // Create headless terminal for screen state serialization.
        // Device query responses (DA1/DSR) are handled exclusively by
        // the renderer xterm.js — the headless terminal uses
        // disableStdin: true to suppress them (matching VS Code).
        headlessManager.create(id, cols, rows)

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
              VSCODE_NONCE: shellIntegrationNonce,
            } as Record<string, string>,
            cols,
            rows,
          },
          // Data callback: write to headless terminal + notify subscribers.
          // No escape sequence buffering — xterm.js handles partial
          // sequences internally (matching VS Code's approach).
          //
          // PTY output flows to two destinations:
          // 1. replayBuffer — captures all output until the renderer's
          //    data channel subscribes with replay=true (which drains
          //    and nulls the buffer). This matches VS Code's
          //    _initialDataEvents pattern — no output is lost between
          //    PTY spawn and data channel connection.
          // 2. Live subscribers — internal consumers like session
          //    persistence that subscribe with replay=false. These
          //    receive data immediately without affecting the buffer.
          (data: string) => processOutput(id, data, subState),
          // Exit callback: mark as stopped (retain in memory)
          (exitCode: number, signal: number) => {
            clearGraceTimeout(id)
            emitAgentCompletionBeforeStop(id)

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
            publishAttachEvent(id, { _tag: 'Exit', exitCode, signal })
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
          agentProcessIds: [],
          id,
          workspaceId,
          command,
          args: [...args],
          cwd,
          agentStatus: null,
          foregroundProcess: null,
          hasChildProcess: false,
          processChain: [],
          status: 'running',
        }

        emitEvent({ _tag: 'Spawned', terminal: record })

        // Orphan leak-guard for fresh spawns only (ADR 0003). Restored
        // terminals proved their ownership in a previous life and must
        // never be reaped while waiting to be re-adopted.
        if (payload.restored !== true) {
          scheduleOrphanTimeout(id)
        }

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

        const bytes = utf8Bytes(data)
        if (bytes > inputWriteBytes || bytes > inputPendingBytes) {
          return yield* new TerminalRpcError({
            message: `Terminal input exceeds the ${inputWriteBytes}-byte write bound`,
            code: 'TERMINAL_INPUT_OVERFLOW',
          })
        }

        // PtyHostClient.write is synchronous in phase 1. Keeping all writes in
        // this manager-owned lane preserves RPC arrival order; phase 2 can put
        // the same byte budget around its asynchronous host queue.
        ptyHostClient.write(terminalId, data)

        // Mark the terminal as "running" when the user sends a newline
        // (submits a command). OSC handlers will flip it back to idle
        // when the prompt returns. For non-OSC shells, arm a fallback
        // timer that auto-resets to idle after NO_OSC_IDLE_FALLBACK_MS.
        // This follows the Mux pattern in sendInput().
        if (
          (data.includes('\r') || data.includes('\n')) &&
          !sessionsWithOscActivity.has(terminalId)
        ) {
          // Non-OSC shell: arm a fallback timer to prevent permanent
          // "running" state. If the shell eventually emits OSC signals,
          // the timer is cleared in handleOscTitleChange.
          const existingFallback = noOscIdleFallbacks.get(terminalId)
          if (existingFallback !== undefined) {
            clearTimeout(existingFallback)
          }
          noOscIdleFallbacks.set(
            terminalId,
            setTimeout(() => {
              noOscIdleFallbacks.delete(terminalId)
              if (!sessionsWithOscActivity.has(terminalId)) {
                emitTitleBasedProcessChanged(terminalId, '')
              }
            }, NO_OSC_IDLE_FALLBACK_MS)
          )
        }
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

        // Keep headless terminal in sync with the real PTY dimensions
        // so serialized screen state is always dimensionally accurate.
        headlessManager.resize(terminalId, cols, rows)

        // Store last known dimensions so restart uses the correct size.
        yield* Ref.update(terminalsRef, (m) => {
          const next = new Map(m)
          const existing = next.get(terminalId)
          if (existing !== undefined) {
            next.set(terminalId, { ...existing, cols, rows })
          }
          return next
        })
      })

      // ---------------------------------------------------------------
      // forceRedraw — re-issue current dimensions to trigger SIGWINCH
      // ---------------------------------------------------------------
      const forceRedraw = Effect.fn('TerminalManager.forceRedraw')(function* (
        terminalId: string
      ) {
        const map = yield* Ref.get(terminalsRef)
        const terminal = map.get(terminalId)

        if (terminal === undefined || terminal.status !== 'running') {
          return
        }

        // Re-issue the PTY's current dimensions. This triggers SIGWINCH
        // which causes TUI apps to perform a full screen redraw.
        ptyHostClient.resize(terminalId, terminal.cols, terminal.rows)
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

        // Explicit user termination must not be projected as agent Done.
        statusEngines.delete(terminalId)
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
          statusEngines.delete(terminalId)
          ptyHostClient.kill(terminalId)
        }
        clearGraceTimeout(terminalId)

        yield* Ref.update(terminalsRef, (m) => {
          const next = new Map(m)
          next.delete(terminalId)
          return next
        })

        subscriberStates.delete(terminalId)
        const activeAttachSubscribers = attachSubscribers.get(terminalId)
        if (activeAttachSubscribers !== undefined) {
          for (
            let index = 0;
            index < activeAttachSubscribers.size;
            index += 1
          ) {
            ptyHostClient.detachFlowControlConsumer(terminalId)
          }
        }
        attachSubscribers.delete(terminalId)
        journals.delete(terminalId)
        transportEpochs.delete(terminalId)
        parsedCursors.delete(terminalId)
        acknowledgedCursors.delete(terminalId)
        leaseCursors.delete(terminalId)
        oldestUnackedAt.delete(terminalId)
        resetCounts.delete(terminalId)
        ackLatencies.delete(terminalId)
        revivedReplayEvents.delete(terminalId)
        headlessManager.dispose(terminalId)
        statusEngines.delete(terminalId)

        // Clean up OSC activity tracking state
        sessionsWithOscActivity.delete(terminalId)
        oscTitleMap.delete(terminalId)
        oscPromptState.delete(terminalId)
        const oscFallback = noOscIdleFallbacks.get(terminalId)
        if (oscFallback !== undefined) {
          clearTimeout(oscFallback)
          noOscIdleFallbacks.delete(terminalId)
        }

        emitEvent({ _tag: 'Removed', id: terminalId })

        yield* Effect.log(`Removed terminal ${terminalId}`).pipe(
          Effect.annotateLogs('module', logPrefix)
        )
      })

      // ---------------------------------------------------------------
      // listTerminals
      // ---------------------------------------------------------------

      /** Build a TerminalRecord from internal state + detection results. */
      const toTerminalRecord = (
        terminal: ManagedTerminal,
        detected: ProcessDetectionResult | undefined
      ): TerminalRecord => {
        // Cached process inspection describes a live PTY only. A kill can
        // mark the terminal stopped before its exit callback clears that
        // cache, so enforce the stopped-terminal invariant at projection.
        const liveDetection =
          terminal.status === 'running' ? detected : undefined
        const foregroundProcess = liveDetection?.foregroundProcess ?? null
        const processChain = liveDetection?.processChain ?? []

        // Keep a naturally exited one-shot agent's idle snapshot available.
        // Done is derived from idle + unseen, and must survive the subsequent
        // StatusChanged event and list hydration until the operator sees it.
        const agentStatus = statusEngines.get(terminal.id)?.current ?? null

        return {
          agentProcessIds: liveDetection?.agentProcessIds ?? [],
          id: terminal.id,
          workspaceId: terminal.workspaceId,
          command: terminal.command,
          args: [...terminal.args],
          cwd: terminal.cwd,
          agentStatus,
          foregroundProcess,
          hasChildProcess: liveDetection?.hasChildProcess ?? false,
          processChain,
          status: terminal.status,
        }
      }

      /** Feed one batch observation through status arbitration and caching. */
      const observeProcessDetection = (
        terminal: ManagedTerminal,
        detectionBatch: ProcessDetectionBatch,
        sampledAt: number
      ): ProcessDetectionResult | undefined => {
        const freshDetection = detectionBatch.results.get(terminal.id)
        if (terminal.status === 'running' && terminal.shellPid !== undefined) {
          const engine = getStatusEngine(terminal.id)
          if (detectionBatch.available && freshDetection !== undefined) {
            engine.sample({
              agentProcesses: freshDetection.agentProcessIds.map((pid) => ({
                pid,
              })),
              // Nested shells are omitted from the presentation chain, but
              // they still mean another command has taken over.
              hasNonAgentProcess: freshDetection.hasChildProcess,
              sampledAt,
            })
          } else if (!detectionBatch.available) {
            engine.unavailable(sampledAt)
          }
        }

        if (freshDetection !== undefined) {
          lastProcessSnapshot.set(terminal.id, freshDetection)
        }
        return freshDetection ?? lastProcessSnapshot.get(terminal.id)
      }

      /**
       * List all terminals with process detection.
       *
       * Process detection is async — a single `ps -eo pid=,ppid=,comm=`
       * call fetches the full process tree, then walks it in memory per
       * terminal. This replaces the previous O(N×12) synchronous
       * `execSync` calls that blocked the event loop.
       */
      const listTerminals = Effect.fn('TerminalManager.listTerminals')(
        function* (workspaceId?: string) {
          const map = yield* Ref.get(terminalsRef)

          // Collect shell PIDs for all running terminals in scope
          const shellPids = new Map<string, number>()
          const terminalsInScope: ManagedTerminal[] = []

          for (const terminal of map.values()) {
            if (
              workspaceId !== undefined &&
              terminal.workspaceId !== workspaceId
            ) {
              continue
            }
            terminalsInScope.push(terminal)
            if (
              terminal.status === 'running' &&
              terminal.shellPid !== undefined
            ) {
              shellPids.set(terminal.id, terminal.shellPid)
            }
          }

          // Single async ps call for all terminals at once
          const detectionBatch = yield* Effect.promise(() =>
            detectProcessesForPids(shellPids)
          )

          const now = Date.now()
          const observed = new Map<string, ProcessDetectionResult | undefined>()
          for (const terminal of terminalsInScope) {
            observed.set(
              terminal.id,
              observeProcessDetection(terminal, detectionBatch, now)
            )
          }

          return terminalsInScope.map((terminal) =>
            toTerminalRecord(terminal, observed.get(terminal.id))
          )
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
          // Restart is explicit replacement, not agent completion. Reset the
          // old generation before its PTY exit callback can publish Done.
          statusEngines.delete(terminalId)
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

        // Get or create subscriber state for the restarted terminal
        const restartSubState = getOrCreateSubscriberState(terminalId)

        // Reset OSC activity tracking for the restarted terminal
        sessionsWithOscActivity.delete(terminalId)
        oscTitleMap.delete(terminalId)
        oscPromptState.delete(terminalId)
        const restartFallback = noOscIdleFallbacks.get(terminalId)
        if (restartFallback !== undefined) {
          clearTimeout(restartFallback)
          noOscIdleFallbacks.delete(terminalId)
        }

        // Use last known dimensions (stored on resize) instead of
        // hardcoded 80x24. This ensures restarted TUIs render at the
        // correct size immediately.
        const restartCols = terminal.cols
        const restartRows = terminal.rows

        // Re-create headless terminal for the restarted PTY.
        // This disposes the old instance and creates a fresh one.
        headlessManager.create(terminalId, restartCols, restartRows)

        // A restarted terminal is a new output generation with the same
        // durable terminal identity. Invalidate old resume cursors before the
        // replacement PTY can emit output, then re-bootstrap every attached
        // pane from the fresh (empty) headless screen.
        const restartedEpoch = crypto.randomUUID()
        transportEpochs.set(terminalId, restartedEpoch)
        journals.delete(terminalId)
        parsedCursors.delete(terminalId)
        acknowledgedCursors.set(terminalId, 0)
        const restartedLeaseCursors = leaseCursors.get(terminalId)
        if (restartedLeaseCursors !== undefined) {
          for (const leaseId of restartedLeaseCursors.keys()) {
            restartedLeaseCursors.set(leaseId, 0)
          }
        }
        oldestUnackedAt.delete(terminalId)
        ackLatencies.delete(terminalId)
        resetCounts.set(terminalId, (resetCounts.get(terminalId) ?? 0) + 1)
        publishAttachEvent(terminalId, {
          _tag: 'Reset',
          epoch: restartedEpoch,
          reason: 'epoch_changed',
        })
        publishAttachEvent(terminalId, {
          _tag: 'Snapshot',
          cursor: 0,
          data: '',
        })
        publishAttachEvent(terminalId, {
          _tag: 'Meta',
          epoch: restartedEpoch,
          status: 'running',
        })
        publishAttachEvent(terminalId, { _tag: 'ReplayComplete' })

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
              VSCODE_NONCE: shellIntegrationNonce,
            } as Record<string, string>,
            cols: restartCols,
            rows: restartRows,
          },
          // Data callback: write to headless terminal + notify subscribers.
          // Same buffering pattern as spawn — if somehow no subscribers
          // exist at restart time, data is captured until one connects.
          (data: string) => processOutput(terminalId, data, restartSubState),
          (exitCode: number, signal: number) => {
            clearGraceTimeout(terminalId)
            emitAgentCompletionBeforeStop(terminalId)

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
            publishAttachEvent(terminalId, {
              _tag: 'Exit',
              exitCode,
              signal,
            })
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

        // Restart creates a new process generation. This also handles a
        // previously stopped terminal, for which no kill occurred above.
        statusEngines.delete(terminalId)

        const record: TerminalRecord = {
          agentProcessIds: [],
          id: terminalId,
          workspaceId: terminal.workspaceId,
          command: terminal.command,
          args: [...terminal.args],
          cwd: terminal.cwd,
          agentStatus: null,
          foregroundProcess: null,
          hasChildProcess: false,
          processChain: [],
          status: 'running',
        }

        emitEvent({ _tag: 'Restarted', terminal: record })

        // No grace timer: a restarted terminal was claimed before, so it
        // is never an orphan (ADR 0003). It runs unwatched until a pane
        // re-attaches or it is explicitly killed.

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
                  `Failed to kill terminal ${terminal.id} during workspace cleanup: ${String(cause)}`
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
                statusEngines.delete(terminal.id)
                yield* Effect.sync(() => ptyHostClient.kill(terminal.id))
                killedCount += 1
              }).pipe(
                Effect.tapDefect((cause) =>
                  Effect.logWarning(
                    `Shutdown: failed to kill terminal ${terminal.id}: ${String(cause)}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                )
              ),
            { discard: true }
          )

          yield* Ref.set(terminalsRef, new Map<string, ManagedTerminal>())

          for (const timeout of graceTimeouts.values()) {
            timeout.cancel()
          }
          graceTimeouts.clear()

          // Clean up all headless terminal instances
          headlessManager.disposeAll()

          // Clean up OSC fallback timers
          for (const timer of noOscIdleFallbacks.values()) {
            clearTimeout(timer)
          }
          noOscIdleFallbacks.clear()
          sessionsWithOscActivity.clear()
          oscTitleMap.clear()
          oscPromptState.clear()

          yield* Effect.log(
            `Shutdown: killed ${killedCount}/${runningTerminals.length} terminal(s)`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        })
      )

      // ---------------------------------------------------------------
      // Subscribe helpers (extracted to reduce cognitive complexity)
      // ---------------------------------------------------------------

      /**
       * Replay buffered PTY output to a subscriber, then null the buffer.
       * Only called for data channel subscribers (replay=true).
       */
      const replayBufferToSubscriber = (
        state: TerminalSubscriberState,
        callback: (data: string) => void
      ): void => {
        if (state.replayBuffer !== null && state.replayBuffer.length > 0) {
          for (const data of state.replayBuffer) {
            try {
              callback(data)
            } catch {
              // Subscriber errors silently ignored
            }
          }
        }
        // Stop buffering — future data goes directly to subscribers.
        state.replayBuffer = null
      }

      // ---------------------------------------------------------------
      // WebSocket subscriber management
      // ---------------------------------------------------------------

      const subscribe = Effect.fn('TerminalManager.subscribe')(function* (
        terminalId: string,
        callback: (data: string) => void,
        options?: { readonly replay?: boolean }
      ) {
        const shouldReplay = options?.replay !== false

        const map = yield* Ref.get(terminalsRef)
        const terminal = map.get(terminalId)

        if (terminal === undefined) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        const state = getOrCreateSubscriberState(terminalId)
        const subscriberId = crypto.randomUUID()
        state.subscribers.set(subscriberId, callback)
        clearGraceTimeout(terminalId)

        if (shouldReplay) {
          replayBufferToSubscriber(state, callback)
        }

        yield* Effect.log(
          `WebSocket subscribed to terminal ${terminalId} (subscriber=${subscriberId}, replay=${String(shouldReplay)})`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        return { subscriberId }
      })

      const unsubscribe = Effect.fn('TerminalManager.unsubscribe')(function* (
        terminalId: string,
        subscriberId: string
      ) {
        const state = subscriberStates.get(terminalId)
        if (state !== undefined) {
          state.subscribers.delete(subscriberId)
          // Deliberately no grace timer when the last subscriber leaves:
          // detached terminals are first-class (CONTEXT.md) and a
          // terminal that was claimed once is never reaped (ADR 0003).
          // Cleanup happens via explicit kill/remove (pane close) only.
        }
        removeAttachSubscriber(terminalId, subscriberId)

        yield* Effect.log(
          `WebSocket unsubscribed from terminal ${terminalId} (subscriber=${subscriberId})`
        ).pipe(Effect.annotateLogs('module', logPrefix))
      })

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: protocol ordering is clearer as one linear attach transaction
      const attach = Effect.fn('TerminalManager.attach')(function* (
        terminalId: string,
        options: {
          readonly cursor?: number
          readonly epoch?: string
          readonly leaseId?: string
        },
        subscriber: AttachSubscriber
      ) {
        const terminal = (yield* Ref.get(terminalsRef)).get(terminalId)
        if (!terminal) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }
        const journal = journalFor(terminalId)
        const transportEpoch = transportEpochFor(terminalId)
        const subscriberId = options.leaseId ?? crypto.randomUUID()
        let subscribers = attachSubscribers.get(terminalId)
        if (!subscribers) {
          subscribers = new Map()
          attachSubscribers.set(terminalId, subscribers)
        }
        if (subscribers.has(subscriberId)) {
          return yield* new TerminalRpcError({
            message: `Terminal attach lease already exists: ${subscriberId}`,
            code: 'TERMINAL_INVALID_CURSOR',
          })
        }
        subscribers.set(subscriberId, subscriber)
        clearGraceTimeout(terminalId)
        ptyHostClient.attachFlowControlConsumer(terminalId)
        // Attach resets the PTY's flow-control debt (ADR 0002). Replay bytes
        // predate that reset and therefore must not be acknowledged as live
        // output debt.
        acknowledgedCursors.set(terminalId, journal.cursor)
        let cursors = leaseCursors.get(terminalId)
        if (cursors === undefined) {
          cursors = new Map()
          leaseCursors.set(terminalId, cursors)
        }
        // Every attach resets flow-control debt (ADR 0002), including debt
        // held by existing leases. New output is thereafter governed by the
        // minimum committed cursor across all attached clients.
        for (const leaseId of cursors.keys()) {
          cursors.set(leaseId, journal.cursor)
        }
        cursors.set(subscriberId, journal.cursor)
        oldestUnackedAt.delete(terminalId)

        const emit = (event: TerminalAttachEvent): boolean => {
          if (subscriber(event)) {
            return true
          }
          removeAttachSubscriber(terminalId, subscriberId)
          return false
        }

        let replayCursor = options.cursor
        const epochChanged =
          options.epoch !== undefined && options.epoch !== transportEpoch
        const cursorLost =
          replayCursor !== undefined && !journal.retains(replayCursor)
        if (epochChanged || cursorLost) {
          resetCounts.set(terminalId, (resetCounts.get(terminalId) ?? 0) + 1)
          if (
            !emit({
              _tag: 'Reset',
              epoch: transportEpoch,
              reason: epochChanged ? 'epoch_changed' : 'cursor_out_of_range',
            })
          ) {
            return { subscriberId }
          }
          replayCursor = undefined
        }

        if (replayCursor === undefined) {
          const snapshot = headlessManager.getScreenState(terminalId)
          if (utf8Bytes(snapshot) > snapshotBytes) {
            removeAttachSubscriber(terminalId, subscriberId)
            return yield* new TerminalRpcError({
              message: `Terminal snapshot exceeds the ${snapshotBytes}-byte bound`,
              code: 'TERMINAL_SNAPSHOT_OVERFLOW',
            })
          }
          replayCursor = parsedCursors.get(terminalId) ?? 0
          if (
            !emit({ _tag: 'Snapshot', cursor: replayCursor, data: snapshot })
          ) {
            return { subscriberId }
          }
        }
        for (const delta of journal.deltasAfter(replayCursor)) {
          if (!emit(delta)) {
            return { subscriberId }
          }
        }
        emit({ _tag: 'Meta', epoch: transportEpoch, status: terminal.status })
        emit({ _tag: 'ReplayComplete' })
        return { subscriberId }
      })

      const acknowledge = Effect.fn('TerminalManager.acknowledge')(function* (
        terminalId: string,
        leaseId: string,
        cursor: number
      ) {
        const journal = journals.get(terminalId)
        if (!journal) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }
        const cursors = leaseCursors.get(terminalId)
        const previousLeaseCursor = cursors?.get(leaseId)
        if (previousLeaseCursor === undefined || cursors === undefined) {
          return yield* new TerminalRpcError({
            message: `Terminal acknowledgement lease not found: ${leaseId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }
        // Duplicate and stale acknowledgements are normal when several panes
        // view one terminal or an in-flight acknowledgement outlives a
        // reconnect. They must be idempotent rather than surfacing errors.
        if (cursor <= previousLeaseCursor) {
          return
        }
        if (!journal.retains(cursor)) {
          return yield* new TerminalRpcError({
            message: `Invalid terminal acknowledgement cursor: ${cursor}`,
            code: 'TERMINAL_INVALID_CURSOR',
          })
        }
        cursors.set(leaseId, cursor)
        const previous =
          acknowledgedCursors.get(terminalId) ?? journal.minimumCursor
        const committed = Math.min(...cursors.values())
        const chars = journal.charactersBetween(previous, committed)
        if (chars > 0) {
          ptyHostClient.ack(terminalId, chars)
        }
        acknowledgedCursors.set(terminalId, committed)
        const startedAt = oldestUnackedAt.get(terminalId)
        if (startedAt !== undefined) {
          ackLatencies.set(terminalId, Math.max(0, Date.now() - startedAt))
        }
        if (committed >= journal.cursor) {
          oldestUnackedAt.delete(terminalId)
        }
      })

      const transportMetrics = Effect.fn('TerminalManager.transportMetrics')(
        function* (terminalId: string) {
          const journal = journals.get(terminalId)
          if (!journal) {
            return yield* new TerminalRpcError({
              message: `Terminal not found: ${terminalId}`,
              code: 'TERMINAL_NOT_FOUND',
            })
          }
          return {
            ackLatencyMs: ackLatencies.get(terminalId) ?? 0,
            backlogBytes: Math.max(
              0,
              journal.cursor -
                Math.max(
                  acknowledgedCursors.get(terminalId) ?? journal.minimumCursor,
                  journal.minimumCursor
                )
            ),
            resetCount: resetCounts.get(terminalId) ?? 0,
            wsBufferedBytes: null,
          }
        }
      )

      const terminalExists = Effect.fn('TerminalManager.terminalExists')(
        function* (terminalId: string) {
          const map = yield* Ref.get(terminalsRef)
          return map.has(terminalId)
        }
      )

      const setRevivedReplayEvent = Effect.fn(
        'TerminalManager.setRevivedReplayEvent'
      )(function* (terminalId: string, replayEvent: SerializedReplayEvent) {
        const map = yield* Ref.get(terminalsRef)
        if (!map.has(terminalId)) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        revivedReplayEvents.set(terminalId, replayEvent)
        const firstFrame = replayEvent.events[0]
        if (firstFrame !== undefined) {
          // Revival starts a replacement PTY, but its renderer-facing history
          // must begin at the checkpoint rather than at the replacement
          // shell's fresh prompt. Rehydrate the same headless/journal path
          // used by live output so WebSocket attaches and legacy data channels
          // observe one tier-iii history.
          headlessManager.dispose(terminalId)
          headlessManager.create(terminalId, firstFrame.cols, firstFrame.rows)
          const state = getOrCreateSubscriberState(terminalId)
          for (const frame of replayEvent.events) {
            headlessManager.resize(terminalId, frame.cols, frame.rows)
            processOutput(terminalId, frame.data, state)
          }
        }
      })

      const takeRevivedReplayEvent = Effect.fn(
        'TerminalManager.takeRevivedReplayEvent'
      )(function* (terminalId: string) {
        const map = yield* Ref.get(terminalsRef)
        if (!map.has(terminalId)) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        const replayEvent = revivedReplayEvents.get(terminalId)
        revivedReplayEvents.delete(terminalId)
        return replayEvent
      })

      // ---------------------------------------------------------------
      // setAgentStatusFromHook — external hook status override
      // ---------------------------------------------------------------

      /**
       * Immediately emit a ProcessChanged event for a single terminal by
       * building a full TerminalRecord from cached process detection.
       * Called from `setAgentStatusFromHook` so hook-reported status
       * reaches subscribers without waiting for the next detection tick.
       */
      const emitProcessChangedForTerminal = (
        terminal: ManagedTerminal
      ): void => {
        // Process detection fields come from the last snapshot if available,
        // but agent status is always fresh from the maps.
        const cachedDetection = lastProcessSnapshot.get(terminal.id)
        const record = toTerminalRecord(terminal, cachedDetection)
        emitEvent({ _tag: 'ProcessChanged', terminal: record })
      }

      const setObservedWorkspaces = Effect.fn(
        'TerminalManager.setObservedWorkspaces'
      )(function* (workspaceIds: ReadonlySet<string>) {
        observedWorkspaceIds = new Set(workspaceIds)
        const map = yield* Ref.get(terminalsRef)

        for (const terminal of map.values()) {
          const engine = statusEngines.get(terminal.id)
          if (engine === undefined) {
            continue
          }
          const wasSeen = engine.current?.seen
          engine.setObserved(observedWorkspaceIds.has(terminal.workspaceId))
          if (engine.current?.seen !== wasSeen) {
            emitProcessChangedForTerminal(terminal)
          }
        }
      })

      const WORKSPACE_PRESENCE_LEASE_MS = 15_000
      const WORKSPACE_PRESENCE_CLIENTS_MAX = 1000
      const aggregateWorkspacePresence = (): ReadonlySet<string> => {
        const workspaceIds = new Set<string>()
        for (const presence of workspacePresence.values()) {
          for (const workspaceId of presence.workspaceIds) {
            workspaceIds.add(workspaceId)
          }
        }
        return workspaceIds
      }
      const reportWorkspacePresence = Effect.fn(
        'TerminalManager.reportWorkspacePresence'
      )(function* (
        clientId: string,
        sequence: number,
        workspaceIds: ReadonlySet<string>
      ) {
        const previous = workspacePresence.get(clientId)
        if (previous !== undefined && sequence <= previous.sequence) {
          return
        }
        if (previous !== undefined) {
          clearTimeout(previous.timer)
        }
        if (
          previous === undefined &&
          workspacePresence.size >= WORKSPACE_PRESENCE_CLIENTS_MAX
        ) {
          const oldestClientId = workspacePresence.keys().next().value
          if (oldestClientId !== undefined) {
            const oldest = workspacePresence.get(oldestClientId)
            if (oldest !== undefined) {
              clearTimeout(oldest.timer)
            }
            workspacePresence.delete(oldestClientId)
          }
        }
        // Retain an empty lease as an ordering tombstone so a delayed focused
        // refresh cannot overwrite a newer blur/unmount report.
        const timer = setTimeout(() => {
          workspacePresence.delete(clientId)
          runSync(setObservedWorkspaces(aggregateWorkspacePresence()))
        }, WORKSPACE_PRESENCE_LEASE_MS)
        timer.unref()
        workspacePresence.set(clientId, {
          sequence,
          timer,
          workspaceIds: new Set(workspaceIds),
        })
        yield* setObservedWorkspaces(aggregateWorkspacePresence())
      })

      const setAgentStatusFromHook = Effect.fn(
        'TerminalManager.setAgentStatusFromHook'
      )(function* (terminalId: string, report: AgentStatusReport) {
        const map = yield* Ref.get(terminalsRef)
        const terminal = map.get(terminalId)

        if (terminal === undefined) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        getStatusEngine(terminalId).report(report, Date.now())
        yield* Effect.log(
          `Hook: reported agent status '${report.status}' (sequence ${report.sequence}) for terminal ${terminalId}`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        // Push the updated state to stream subscribers immediately so
        // the UI reflects hook-reported agent status without waiting
        // for the next detection tick.
        emitProcessChangedForTerminal(terminal)
      })

      // ---------------------------------------------------------------
      // Background process detection fiber
      // ---------------------------------------------------------------
      // Runs every 200ms. On each tick:
      // 1. Collect shell PIDs for all running terminals
      // 2. Run a single async `ps` call
      // 3. Build TerminalRecords and diff against the previous snapshot
      // 4. Emit ProcessChanged events for any terminals whose process
      //    state differs from the last snapshot
      //
      // The snapshot stores the serialised process fields (foreground-
      // Process, agentStatus, hasChildProcess, processChain) so we can
      // do a cheap string equality check.
      // ---------------------------------------------------------------

      /** Interval for the background detection loop. */
      const DETECTION_INTERVAL_MS = 200

      /**
       * Per-terminal process detection snapshot from the last tick.
       * Used to diff and decide whether to emit ProcessChanged.
       */
      const lastProcessSnapshot = new Map<string, ProcessDetectionResult>()

      /**
       * Per-terminal serialised TerminalRecord from the last tick.
       * JSON-stringified to enable cheap equality comparison.
       */
      const lastRecordJson = new Map<string, string>()

      /** Collect shell PIDs for running terminals from the in-memory map. */
      const collectShellPids = (
        map: ReadonlyMap<string, ManagedTerminal>
      ): {
        shellPids: Map<string, number>
        allTerminals: ManagedTerminal[]
      } => {
        const shellPids = new Map<string, number>()
        const allTerminals: ManagedTerminal[] = []

        for (const terminal of map.values()) {
          allTerminals.push(terminal)
          if (
            terminal.status === 'running' &&
            terminal.shellPid !== undefined
          ) {
            shellPids.set(terminal.id, terminal.shellPid)
          }
        }

        return { shellPids, allTerminals }
      }

      /**
       * Diff detection results against the previous snapshot and emit
       * ProcessChanged events for terminals whose state has changed.
       * Also cleans up stale snapshot entries.
       */
      const diffAndEmitChanges = (
        allTerminals: readonly ManagedTerminal[],
        detectionBatch: ProcessDetectionBatch,
        terminalIds: ReadonlySet<string>
      ): void => {
        const sampledAt = Date.now()
        for (const terminal of allTerminals) {
          const detected = observeProcessDetection(
            terminal,
            detectionBatch,
            sampledAt
          )
          const record = toTerminalRecord(terminal, detected)
          const json = JSON.stringify(record)
          const previous = lastRecordJson.get(terminal.id)

          if (json !== previous) {
            lastRecordJson.set(terminal.id, json)
            emitEvent({ _tag: 'ProcessChanged', terminal: record })
          }
        }

        // Clean up snapshots for removed terminals.
        for (const id of lastRecordJson.keys()) {
          if (!terminalIds.has(id)) {
            lastRecordJson.delete(id)
            lastProcessSnapshot.delete(id)
          }
        }
      }

      const detectionTick = Effect.gen(function* () {
        const map = yield* Ref.get(terminalsRef)

        if (map.size === 0) {
          return
        }

        const { shellPids, allTerminals } = collectShellPids(map)

        const detectionBatch = yield* Effect.promise(() =>
          detectProcessesForPids(shellPids)
        )

        diffAndEmitChanges(allTerminals, detectionBatch, new Set(map.keys()))
      }).pipe(
        Effect.tapDefect((cause) =>
          Effect.logWarning(
            `Process detection tick failed: ${String(cause)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        ),
        Effect.catchDefect(() => Effect.void)
      )

      // Launch the detection fiber in the layer scope so it is interrupted on
      // shutdown instead of leaking into Effect's global scope.
      yield* detectionTick.pipe(
        Effect.repeat(Schedule.spaced(`${DETECTION_INTERVAL_MS} millis`)),
        // The process detector must register before layer acquisition returns;
        // terminal-manager's OSC 133/background-process regression proves the
        // deferred v4 default can otherwise publish a false idle transition.
        Effect.forkScoped({ startImmediately: true })
      )

      yield* Effect.log(
        `Background process detection started (interval=${DETECTION_INTERVAL_MS}ms)`
      ).pipe(Effect.annotateLogs('module', logPrefix))

      return TerminalManager.of({
        spawn,
        attach,
        acknowledge,
        transportMetrics,
        hostStatus: () =>
          Effect.succeed({
            expectedVersion: 'in-process',
            runningVersion: 'in-process',
            state: 'healthy',
          }),
        restartHost: () =>
          Effect.fail(
            new TerminalRpcError({
              code: 'PTY_HOST_NOT_DETACHED',
              message: 'The terminal host is running in-process',
            })
          ),
        write,
        resize,
        forceRedraw,
        kill,
        remove,
        restart,
        listTerminals,
        killAllForWorkspace,
        getScreenState: (terminalId: string) =>
          headlessManager.getScreenState(terminalId),
        getCommandDetectionState: (terminalId: string) =>
          headlessManager.getCommandDetectionState(terminalId),
        subscribe,
        unsubscribe,
        terminalExists,
        setAgentStatusFromHook,
        setObservedWorkspaces,
        reportWorkspacePresence,
        getTerminals: () =>
          Effect.map(Ref.get(terminalsRef), (map) => [...map.values()]),
        setRevivedReplayEvent,
        takeRevivedReplayEvent,
        lifecycleEvents: lifecyclePubSub,
      })
    })
  )
}

export {
  buildDetectionFromTitle,
  classifyProcess,
  detectForShellPid,
  detectProcessesForPids,
  EMPTY_DETECTION,
  isIdleTitle,
  parsePsOutput,
  TerminalManager,
}
export type {
  ForegroundProcess,
  ManagedTerminal,
  OutputSubscriber,
  ProcessCategory,
  ProcessDetectionResult,
  SpawnPayload,
  TerminalExitedEvent,
  TerminalLifecycleEvent,
  TerminalProcessChangedEvent,
  TerminalRecord,
  TerminalRemovedEvent,
  TerminalRestartedEvent,
  TerminalSpawnedEvent,
  TerminalStatusChangedEvent,
}
