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

import { exec } from 'node:child_process'
import { TerminalRpcError } from '@laborer/shared/rpc'
import {
  Cause,
  Context,
  Effect,
  Layer,
  PubSub,
  Ref,
  Runtime,
  Schedule,
} from 'effect'
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
 * Agent status for a terminal, derived from foreground process transitions.
 *
 * - `active` — an AI agent is currently the foreground process
 * - `waiting_for_input` — an agent was running but is now idle (needs user input or completed)
 * - `null` — no agent has been detected in this terminal
 */
type AgentStatus = 'active' | 'waiting_for_input'

/**
 * Shape of a terminal record returned by the manager.
 * Matches the TerminalInfo RPC schema fields.
 */
interface TerminalRecord {
  readonly agentStatus: AgentStatus | null
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
): void => {
  const comm = commByPid.get(pid) ?? ''
  const classified = classifyProcess(comm)
  if (classified !== null && classified.category !== 'shell') {
    chain.push(classified)
  }
}

/**
 * Walk the process tree from a shell PID down to the deepest first-child,
 * collecting all non-shell classified processes along the way into a chain
 * for display (e.g., "OpenCode › biome"). Returns the deepest child PID.
 */
const walkProcessTree = (
  startPid: number,
  childrenByPid: ReadonlyMap<number, number[]>,
  commByPid: ReadonlyMap<number, string>,
  chain: ForegroundProcess[]
): void => {
  let targetPid = startPid
  classifyAndCollect(targetPid, commByPid, chain)

  for (let depth = 0; depth < 10; depth++) {
    const grandchildren = childrenByPid.get(targetPid)
    if (grandchildren === undefined || grandchildren.length === 0) {
      break
    }
    targetPid = grandchildren[0] ?? targetPid
    classifyAndCollect(targetPid, commByPid, chain)
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

    // If the shell was exec-replaced (e.g., zsh → opencode), include the
    // exec'd process as the root of the chain before walking children.
    if (isExecReplaced) {
      chain.push(shellClassified)
    }

    const firstChildPid = children[0] ?? shellPid
    walkProcessTree(firstChildPid, childrenByPid, commByPid, chain)

    return {
      foregroundProcess: chain.at(-1) ?? null,
      hasChildProcess: true,
      processChain: chain,
    }
  }

  if (!isExecReplaced) {
    return EMPTY_DETECTION
  }

  // Shell exec'd into another process (e.g., sh -c cat → cat)
  return {
    foregroundProcess: shellClassified,
    hasChildProcess: false,
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
const detectProcessesForPids = async (
  shellPids: ReadonlyMap<string, number>
): Promise<ReadonlyMap<string, ProcessDetectionResult>> => {
  const results = new Map<string, ProcessDetectionResult>()

  if (shellPids.size === 0) {
    return results
  }

  // Single async ps call to get the full process table.
  // `ps -eo pid=,ppid=,comm=` is faster than multiple targeted calls
  // because it's a single fork+exec. We then filter in memory.
  const psOutput = await execAsync('ps -eo pid=,ppid=,comm=')

  if (psOutput === null) {
    for (const terminalId of shellPids.keys()) {
      results.set(terminalId, EMPTY_DETECTION)
    }
    return results
  }

  const { childrenByPid, commByPid } = parsePsOutput(psOutput)

  for (const [terminalId, shellPid] of shellPids) {
    results.set(
      terminalId,
      detectForShellPid(shellPid, childrenByPid, commByPid)
    )
  }

  return results
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

    /**
     * Set agent status for a terminal from an external hook.
     *
     * Agent CLIs (Claude Code, OpenCode, etc.) call this via the
     * `POST /hook/agent-status` HTTP endpoint to report lifecycle
     * transitions. Hook-reported status takes priority over the
     * ps-based detection in `listTerminals`.
     *
     * Valid events:
     * - `'active'` — agent is actively working (session started, prompt submitted)
     * - `'waiting_for_input'` — agent is idle / needs user input (notification, stop)
     * - `'clear'` — clear hook override, revert to ps-based detection
     */
    readonly setAgentStatusFromHook: (
      terminalId: string,
      event: 'active' | 'waiting_for_input' | 'clear'
    ) => Effect.Effect<void, TerminalRpcError>

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

      // Per-terminal agent status tracking. Tracks whether an agent was
      // previously the foreground process so we can detect the transition
      // from "agent active" → "shell idle" (waiting for input / completed).
      const agentStatusMap = new Map<string, AgentStatus | null>()

      // Hook-reported agent status overrides. When an agent CLI reports
      // its lifecycle state via the hook endpoint, that status takes
      // priority over the ps-based detection. Set to `undefined` (or
      // deleted) to revert to ps-based detection.
      const hookAgentStatusMap = new Map<string, AgentStatus>()

      // Per-terminal ring buffer and subscriber state.
      const bufferStates = new Map<string, TerminalBufferState>()
      const graceTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

      // Lifecycle event PubSub — unbounded so publishers never block.
      const lifecyclePubSub = yield* PubSub.unbounded<TerminalLifecycleEvent>()

      /** Publish a lifecycle event (fire-and-forget). */
      const emitEvent = (event: TerminalLifecycleEvent): void => {
        runFork(lifecyclePubSub.publish(event))
      }

      /**
       * Compute the agent status for a terminal based on the current
       * process chain and the previous tracked status.
       *
       * An agent is considered "active" if it appears anywhere in the
       * process chain (typically as the root). This handles the common
       * case where `zsh -c opencode` exec-replaces into opencode, which
       * then spawns tool subprocesses like biome via node. The agent is
       * still running — it just has child processes doing work.
       *
       * State transitions:
       * - Agent in chain → `active`
       * - Was `active`, now idle (no foreground or shell) → `waiting_for_input`
       * - Was `waiting_for_input`, agent comes back → `active`
       * - No agent in chain, non-shell foreground → clear to `null`
       * - No agent ever seen → `null`
       */
      const computeAgentStatus = (
        terminalId: string,
        foregroundProcess: ForegroundProcess | null,
        processChain: readonly ForegroundProcess[]
      ): AgentStatus | null => {
        const previous = agentStatusMap.get(terminalId) ?? null

        // Check if any process in the chain is an agent (typically the root).
        // This correctly detects agents that exec-replace the shell and then
        // spawn child tool processes (e.g., opencode → node → biome).
        const hasAgentInChain = processChain.some((p) => p.category === 'agent')

        if (hasAgentInChain) {
          agentStatusMap.set(terminalId, 'active')
          return 'active'
        }

        // Agent was active, now idle (shell at prompt or no foreground process)
        if (
          previous === 'active' &&
          (foregroundProcess === null || foregroundProcess.category === 'shell')
        ) {
          agentStatusMap.set(terminalId, 'waiting_for_input')
          return 'waiting_for_input'
        }

        // Stay in waiting_for_input until a non-agent process takes over
        // or the user dismisses it (by running another command)
        if (
          previous === 'waiting_for_input' &&
          (foregroundProcess === null || foregroundProcess.category === 'shell')
        ) {
          return 'waiting_for_input'
        }

        // A non-agent, non-shell process is now foreground — clear agent status
        if (previous !== null && foregroundProcess !== null) {
          agentStatusMap.set(terminalId, null)
          return null
        }

        return previous
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
          agentStatus: null,
          foregroundProcess: null,
          hasChildProcess: false,
          processChain: [],
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
        agentStatusMap.delete(terminalId)
        hookAgentStatusMap.delete(terminalId)

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
        const foregroundProcess = detected?.foregroundProcess ?? null
        const processChain = detected?.processChain ?? []

        // Hook-reported status takes priority over ps-based detection.
        // If an agent CLI has reported its state via the hook endpoint,
        // use that. Otherwise fall back to the ps-based state machine.
        const hookStatus = hookAgentStatusMap.get(terminal.id)
        const agentStatus =
          terminal.status === 'running'
            ? (hookStatus ??
              computeAgentStatus(terminal.id, foregroundProcess, processChain))
            : null

        return {
          id: terminal.id,
          workspaceId: terminal.workspaceId,
          command: terminal.command,
          args: [...terminal.args],
          cwd: terminal.cwd,
          agentStatus,
          foregroundProcess,
          hasChildProcess: detected?.hasChildProcess ?? false,
          processChain,
          status: terminal.status,
        }
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
          const detectionResults = yield* Effect.promise(() =>
            detectProcessesForPids(shellPids)
          )

          return terminalsInScope.map((terminal) =>
            toTerminalRecord(terminal, detectionResults.get(terminal.id))
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

        // Reset agent status tracking on restart
        agentStatusMap.delete(terminalId)
        hookAgentStatusMap.delete(terminalId)

        const record: TerminalRecord = {
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

      const setAgentStatusFromHook = Effect.fn(
        'TerminalManager.setAgentStatusFromHook'
      )(function* (
        terminalId: string,
        event: 'active' | 'waiting_for_input' | 'clear'
      ) {
        const map = yield* Ref.get(terminalsRef)
        const terminal = map.get(terminalId)

        if (terminal === undefined) {
          return yield* new TerminalRpcError({
            message: `Terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        if (event === 'clear') {
          hookAgentStatusMap.delete(terminalId)
          yield* Effect.log(
            `Hook: cleared agent status override for terminal ${terminalId}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        } else {
          hookAgentStatusMap.set(terminalId, event)
          // Also sync the ps-based map so transitions are consistent
          // when the hook override is later cleared
          agentStatusMap.set(terminalId, event)
          yield* Effect.log(
            `Hook: set agent status to '${event}' for terminal ${terminalId}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }

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
        detectionResults: ReadonlyMap<string, ProcessDetectionResult>,
        terminalIds: ReadonlySet<string>
      ): void => {
        for (const terminal of allTerminals) {
          const detected = detectionResults.get(terminal.id)

          if (detected !== undefined) {
            lastProcessSnapshot.set(terminal.id, detected)
          }

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

        const detectionResults = yield* Effect.promise(() =>
          detectProcessesForPids(shellPids)
        )

        diffAndEmitChanges(allTerminals, detectionResults, new Set(map.keys()))
      }).pipe(
        Effect.tapDefect((cause) =>
          Effect.logWarning(
            `Process detection tick failed: ${Cause.pretty(cause)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        ),
        Effect.catchAllDefect(() => Effect.void)
      )

      // Launch the detection fiber as a daemon so it runs for the
      // lifetime of the scoped layer and is interrupted on shutdown.
      yield* detectionTick.pipe(
        Effect.repeat(Schedule.spaced(`${DETECTION_INTERVAL_MS} millis`)),
        Effect.forkDaemon
      )

      yield* Effect.log(
        `Background process detection started (interval=${DETECTION_INTERVAL_MS}ms)`
      ).pipe(Effect.annotateLogs('module', logPrefix))

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
        setAgentStatusFromHook,
        lifecycleEvents: lifecyclePubSub,
      })
    })
  )
}

export { classifyProcess, TerminalManager }
export type {
  AgentStatus,
  ForegroundProcess,
  ManagedTerminal,
  OutputSubscriber,
  ProcessCategory,
  SpawnPayload,
  TerminalBufferState,
  TerminalExitedEvent,
  TerminalLifecycleEvent,
  TerminalProcessChangedEvent,
  TerminalRecord,
  TerminalRemovedEvent,
  TerminalRestartedEvent,
  TerminalSpawnedEvent,
  TerminalStatusChangedEvent,
}
