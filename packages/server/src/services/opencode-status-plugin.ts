import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentStatus } from '@laborer/shared/rpc'

/**
 * Report POSTed by the OpenCode v2 plugin to Laborer's agent hook server.
 *
 * OpenCode v2 runs plugins inside a shared background daemon, not inside the
 * terminal's process tree, so per-terminal environment variables are not
 * available to the plugin. Reports are attributed by workspace `directory`
 * instead: the hook server maps the directory back to the terminal(s)
 * spawned in that worktree.
 */
interface OpenCodeStatusReport {
  readonly directory: string
  readonly sequence: number
  readonly status: AgentStatus
}

type SendStatusReport = (report: OpenCodeStatusReport) => Promise<void>

/**
 * Minimal shape of the OpenCode v2 promise-plugin context this plugin uses.
 * The real context exposes many more domains; only the event stream matters
 * here.
 */
interface OpenCodePluginContext {
  readonly event: {
    readonly subscribe: () => AsyncIterable<unknown>
  }
}

interface OpenCodeStatusPluginRuntimeOptions {
  /**
   * Upper bound on remembered sessionID -> directory mappings. The daemon
   * runs indefinitely, so the oldest mapping is evicted past this bound.
   */
  readonly maxTrackedSessions?: number
  /** Delay before resubscribing after the volatile event stream fails. */
  readonly resubscribeDelayMs?: number
}

/**
 * OpenCode v2 plugin runtime. Keep this function self-contained: the
 * installer embeds its JavaScript representation in the user-level plugin
 * file, so it must not reference module-scope bindings.
 *
 * v2 facts this runtime relies on (verified empirically against a live
 * daemon, 0.0.0-next-17086, with a probe plugin):
 * - Plugins load from a `default` export of `{ id, setup }`; `setup` receives
 *   a promise context and must return quickly (its result is awaited).
 * - `context.event.subscribe()` delivers the daemon-wide firehose: events
 *   from EVERY project directory arrive interleaved. The bus's location
 *   filter does not apply to plugin hosts, so every event must be attributed
 *   individually — a single "current directory" is never safe.
 * - Event payloads are `{ type, data, location?, ... }` — fields live under
 *   `data`, and the envelope carries an optional `location.directory`.
 * - `session.status` / `session.idle` exist in the schema but are never
 *   emitted by the daemon. The official OpenCode app derives busy/idle from
 *   `session.execution.started|succeeded|failed|interrupted` and
 *   `session.retry.scheduled`; this runtime does the same (and keeps a
 *   `session.status` mapping in case a future daemon emits it).
 * - `session.execution.*` and `session.retry.scheduled` events carry NO
 *   envelope location. Streaming events (`session.step.*`,
 *   `session.tool.*`, `session.text.*`) do carry one, so the runtime learns
 *   each session's directory from located events and buffers busy marks
 *   until the directory is known.
 * - `session.created` never reaches plugins, so subagent (child) sessions
 *   cannot be recognized via `parentID`. Instead, a per-directory busy set
 *   keeps the terminal `working` until the LAST busy session in that
 *   directory finishes — parent and child sessions share the directory, so
 *   a finishing child never flips a still-working terminal to idle.
 */
function createOpenCodeStatusPluginRuntime(
  send: SendStatusReport,
  options: OpenCodeStatusPluginRuntimeOptions = {}
) {
  type Status = 'working' | 'needs_input' | 'idle'

  const resubscribeDelayMs = options.resubscribeDelayMs ?? 1000
  const maxTrackedSessions = options.maxTrackedSessions ?? 1000

  let sequence = Date.now() * 1000

  /** sessionID -> directory, learned from located events. Insertion-ordered. */
  const sessionDirectories = new Map<string, string>()
  /** directory -> busy sessionIDs. Working while non-empty. */
  const busySessions = new Map<string, Set<string>>()
  /** Sessions marked busy before any located event revealed their directory. */
  const pendingBusy = new Set<string>()

  /** directory -> newest status awaiting delivery. One request in flight. */
  const pendingReports = new Map<string, Status>()
  let sending = false

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null

  const drain = async (): Promise<void> => {
    if (sending) {
      return
    }
    sending = true
    while (pendingReports.size > 0) {
      const next = pendingReports.entries().next()
      if (next.done === true) {
        break
      }
      const [directory, status] = next.value
      pendingReports.delete(directory)
      sequence += 1
      try {
        await send({ sequence, status, directory })
      } catch {
        // Status is advisory. A later native event gets another attempt.
      }
    }
    sending = false
  }

  // While a request is in flight, retain only the newest fact per directory.
  const report = (directory: string, status: Status): void => {
    pendingReports.set(directory, status)
    drain().catch(() => {
      // drain handles transport errors; this only guards an unexpected bug.
    })
  }

  const markBusy = (sessionId: string, directory: string): void => {
    let sessions = busySessions.get(directory)
    if (sessions === undefined) {
      sessions = new Set()
      busySessions.set(directory, sessions)
    }
    const wasBusy = sessions.size > 0
    sessions.add(sessionId)
    // Report only the not-busy -> busy transition. Repeat busy signals (each
    // step of a run, sibling subagent sessions) must not clobber a
    // `needs_input` already reported for a blocked session.
    if (!wasBusy) {
      report(directory, 'working')
    }
  }

  const forgetSession = (sessionId: string): void => {
    pendingBusy.delete(sessionId)
    const directory = sessionDirectories.get(sessionId)
    if (directory === undefined) {
      return
    }
    const sessions = busySessions.get(directory)
    sessions?.delete(sessionId)
    if (sessions !== undefined && sessions.size === 0) {
      busySessions.delete(directory)
    }
  }

  const rememberSession = (sessionId: string, directory: string): void => {
    if (
      !sessionDirectories.has(sessionId) &&
      sessionDirectories.size >= maxTrackedSessions
    ) {
      const oldest = sessionDirectories.keys().next()
      if (oldest.done !== true) {
        forgetSession(oldest.value)
        sessionDirectories.delete(oldest.value)
      }
    }
    sessionDirectories.set(sessionId, directory)
    if (pendingBusy.delete(sessionId)) {
      markBusy(sessionId, directory)
    }
  }

  const sessionBusy = (sessionId: string): void => {
    const directory = sessionDirectories.get(sessionId)
    if (directory === undefined) {
      pendingBusy.add(sessionId)
      return
    }
    markBusy(sessionId, directory)
  }

  /**
   * A session stopped running. Reports `status` only when it was the last
   * busy session in its directory — while siblings (or the parent of a
   * subagent) are still busy the terminal stays `working`.
   */
  const sessionDone = (sessionId: string, status: Status): void => {
    pendingBusy.delete(sessionId)
    const directory = sessionDirectories.get(sessionId)
    if (directory === undefined) {
      return
    }
    const sessions = busySessions.get(directory)
    sessions?.delete(sessionId)
    if (sessions !== undefined && sessions.size === 0) {
      busySessions.delete(directory)
    }
    if ((busySessions.get(directory)?.size ?? 0) === 0) {
      report(directory, status)
    }
  }

  /** Report for the session's directory without touching the busy set. */
  const reportForSession = (sessionId: string, status: Status): void => {
    const directory = sessionDirectories.get(sessionId)
    if (directory !== undefined) {
      report(directory, status)
    }
  }

  // `session.step.started` doubles as a busy signal so a plugin loaded
  // mid-run re-adopts already-running sessions.
  const busyEvents = new Set([
    'session.execution.started',
    'session.retry.scheduled',
    'session.step.started',
  ])

  /** Terminal status once the LAST busy session in a directory stops. */
  const doneStatuses: Record<string, Status> = {
    'session.execution.succeeded': 'idle',
    'session.execution.interrupted': 'idle',
    // Deprecated; kept in case a daemon emits it again.
    'session.idle': 'idle',
    'session.execution.failed': 'needs_input',
  }

  /** Statuses reported directly, without touching the busy set. */
  const blockedStatuses: Record<string, Status> = {
    'permission.asked': 'needs_input',
    'question.asked': 'needs_input',
    'permission.replied': 'working',
    'question.replied': 'working',
    'question.rejected': 'working',
  }

  // Not emitted by current daemons; mapped for forward compatibility.
  const handleSessionStatus = (
    sessionId: string,
    data: Record<string, unknown>
  ): void => {
    const statusType = isRecord(data.status) ? data.status.type : undefined
    if (statusType === 'busy' || statusType === 'retry') {
      sessionBusy(sessionId)
    } else if (statusType === 'idle') {
      sessionDone(sessionId, 'idle')
    }
  }

  /** Learn the session's directory from a located envelope. */
  const learnDirectory = (
    sessionId: string,
    envelope: Record<string, unknown>
  ): void => {
    const location = isRecord(envelope.location) ? envelope.location : undefined
    if (
      typeof location?.directory === 'string' &&
      location.directory.length > 0
    ) {
      rememberSession(sessionId, location.directory)
    }
  }

  const dispatch = (
    type: string,
    sessionId: string,
    data: Record<string, unknown>
  ): void => {
    if (busyEvents.has(type)) {
      sessionBusy(sessionId)
      return
    }
    const doneStatus = doneStatuses[type]
    if (doneStatus !== undefined) {
      sessionDone(sessionId, doneStatus)
      return
    }
    const blockedStatus = blockedStatuses[type]
    if (blockedStatus !== undefined) {
      reportForSession(sessionId, blockedStatus)
      return
    }
    if (type === 'session.deleted') {
      sessionDone(sessionId, 'idle')
      sessionDirectories.delete(sessionId)
      return
    }
    if (type === 'session.status') {
      handleSessionStatus(sessionId, data)
    }
  }

  /**
   * Abandon busy bookkeeping accumulated under a stream that has since
   * dropped.
   *
   * Busy state is a fold over `session.execution.*` deltas, so a completion
   * lost in a resubscribe gap leaves its directory busy forever and pins the
   * terminal to `working`. Nothing in the event stream can undo that. Each
   * affected directory is released to `idle`; a run still in flight re-marks
   * itself `working` on its next `session.step.started`, which arrives
   * within moments.
   */
  const releaseBusySessions = (): void => {
    const directories = [...busySessions.keys()]
    busySessions.clear()
    pendingBusy.clear()
    for (const directory of directories) {
      report(directory, 'idle')
    }
  }

  const handleEvent = (event: unknown): void => {
    if (!isRecord(event) || typeof event.type !== 'string') {
      return
    }
    const data = isRecord(event.data) ? event.data : {}
    const sessionId =
      typeof data.sessionID === 'string' && data.sessionID.length > 0
        ? data.sessionID
        : undefined
    if (sessionId === undefined) {
      return
    }
    learnDirectory(sessionId, event)
    dispatch(event.type, sessionId, data)
  }

  /**
   * v2 `setup` implementation. Starts the event loop without awaiting it —
   * OpenCode awaits `setup`'s result during plugin load — and returns a
   * cleanup that stops the loop when the plugin unloads.
   */
  const setup = (context: OpenCodePluginContext): (() => void) => {
    let active = true
    let iterator: AsyncIterator<unknown> | undefined
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms))

    const loop = async (): Promise<void> => {
      while (active) {
        try {
          iterator = context.event.subscribe()[Symbol.asyncIterator]()
          while (active) {
            const next = await iterator.next()
            if (next.done === true) {
              break
            }
            handleEvent(next.value)
          }
        } catch {
          // The event stream is volatile by contract; resubscribe below.
        }
        if (active) {
          releaseBusySessions()
          await sleep(resubscribeDelayMs)
        }
      }
    }
    loop().catch(() => {
      // loop guards its own failures; this only protects against bugs.
    })

    return () => {
      active = false
      const result = iterator?.return?.(undefined)
      if (result !== undefined) {
        result.catch(() => {
          // Best-effort stream shutdown.
        })
      }
    }
  }

  return { handleEvent, setup }
}

/**
 * Discovery file the installed plugin reads to find Laborer's agent hook
 * server. The OpenCode daemon's environment is frozen at daemon start, so
 * the hook URL (random port per app run) must come from disk, not env.
 */
const agentHookDiscoveryPath = (homeDirectory?: string): string =>
  join(homeDirectory ?? homedir(), '.config', 'laborer', 'agent-hook.json')

interface WriteAgentHookDiscoveryOptions {
  readonly homeDirectory?: string
}

/** Write (atomically) the discovery file pointing at the agent hook server. */
const writeAgentHookDiscovery = (
  hookUrl: string,
  options: WriteAgentHookDiscoveryOptions = {}
): string => {
  const discoveryPath = agentHookDiscoveryPath(options.homeDirectory)
  mkdirSync(dirname(discoveryPath), { recursive: true })
  const temporaryPath = `${discoveryPath}.${String(process.pid)}.tmp`
  try {
    writeFileSync(
      temporaryPath,
      JSON.stringify({ url: hookUrl, pid: process.pid, updatedAt: Date.now() }),
      'utf8'
    )
    renameSync(temporaryPath, discoveryPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
  return discoveryPath
}

const openCodePluginSource = (): string => `// installed and managed by Laborer
// Reinstalling or updating Laborer may overwrite this file.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const createOpenCodeStatusPluginRuntime = ${createOpenCodeStatusPluginRuntime.toString()};

const discoveryPath = join(homedir(), ".config", "laborer", "agent-hook.json");

const send = async (report) => {
  const discovery = JSON.parse(await readFile(discoveryPath, "utf8"));
  if (typeof discovery?.url !== "string" || discovery.url.length === 0) return;
  await fetch(discovery.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(1000),
  });
};

const runtime = createOpenCodeStatusPluginRuntime(send);

export default {
  id: "laborer-agent-status",
  setup: (context) => runtime.setup(context),
};
`

interface InstallOpenCodeStatusPluginOptions {
  readonly homeDirectory?: string
}

/** Install once at service startup; OpenCode loads this user-level plugin. */
const installOpenCodeStatusPlugin = (
  options: InstallOpenCodeStatusPluginOptions = {}
): string | null => {
  const configDirectory = join(
    options.homeDirectory ?? homedir(),
    '.config',
    'opencode'
  )
  if (!existsSync(configDirectory)) {
    return null
  }

  const pluginsDirectory = join(configDirectory, 'plugins')
  mkdirSync(pluginsDirectory, { recursive: true })
  const pluginPath = join(pluginsDirectory, 'laborer-agent-status.js')
  const temporaryPath = `${pluginPath}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temporaryPath, openCodePluginSource(), 'utf8')
    renameSync(temporaryPath, pluginPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
  return pluginPath
}

export {
  agentHookDiscoveryPath,
  createOpenCodeStatusPluginRuntime,
  type InstallOpenCodeStatusPluginOptions,
  installOpenCodeStatusPlugin,
  type OpenCodePluginContext,
  type OpenCodeStatusReport,
  openCodePluginSource,
  writeAgentHookDiscovery,
  type WriteAgentHookDiscoveryOptions,
}
