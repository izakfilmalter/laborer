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
  /** Delay before resubscribing after the volatile event stream fails. */
  readonly resubscribeDelayMs?: number
}

/**
 * OpenCode v2 plugin runtime. Keep this function self-contained: the
 * installer embeds its JavaScript representation in the user-level plugin
 * file, so it must not reference module-scope bindings.
 *
 * v2 facts this runtime relies on (verified against the opencode repo):
 * - Plugins load from a `default` export of `{ id, setup }`; `setup` receives
 *   a promise context and must return quickly (its result is awaited).
 * - One plugin instance exists per project directory (location), and
 *   `context.event.subscribe()` is already filtered to that location's
 *   events plus location-less events.
 * - Event payloads are `{ type, data, location?, ... }` — fields live under
 *   `data`, and the envelope carries an optional `location.directory`.
 * - `session.status` reports `{ type: 'busy' | 'retry' | 'idle' }`;
 *   `permission.asked` / `question.asked` signal a blocked agent;
 *   `session.created` data carries `parentID` for child (subagent) sessions.
 */
function createOpenCodeStatusPluginRuntime(
  send: SendStatusReport,
  options: OpenCodeStatusPluginRuntimeOptions = {}
) {
  type Status = 'working' | 'needs_input' | 'idle'

  const resubscribeDelayMs = options.resubscribeDelayMs ?? 1000

  let sequence = Date.now() * 1000
  let directory: string | undefined
  const childSessionIds = new Set<string>()
  let sending = false
  let pending: { status: Status; directory: string } | undefined

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null

  const drain = async (): Promise<void> => {
    if (sending) {
      return
    }
    sending = true
    while (pending !== undefined) {
      const current = pending
      pending = undefined
      sequence += 1
      try {
        await send({
          sequence,
          status: current.status,
          directory: current.directory,
        })
      } catch {
        // Status is advisory. A later native event gets another attempt.
      }
    }
    sending = false
  }

  // At most one request is in flight. While it is in flight, retain only the
  // newest lifecycle fact.
  const report = (status: Status): void => {
    if (directory === undefined) {
      return
    }
    if (pending === undefined) {
      pending = { status, directory }
    } else {
      pending.status = status
      pending.directory = directory
    }
    drain().catch(() => {
      // drain handles transport errors; this only guards an unexpected bug.
    })
  }

  const statusFromSessionStatus = (value: unknown): Status | undefined => {
    if (!isRecord(value) || typeof value.type !== 'string') {
      return undefined
    }
    switch (value.type) {
      case 'idle':
        return 'idle'
      case 'busy':
      case 'retry':
        return 'working'
      default:
        return undefined
    }
  }

  const rememberDirectory = (
    envelope: Record<string, unknown>,
    data: Record<string, unknown>
  ): void => {
    const location = isRecord(envelope.location) ? envelope.location : undefined
    if (
      typeof location?.directory === 'string' &&
      location.directory.length > 0
    ) {
      directory = location.directory
      return
    }
    const dataLocation = isRecord(data.location) ? data.location : undefined
    if (
      directory === undefined &&
      typeof dataLocation?.directory === 'string' &&
      dataLocation.directory.length > 0
    ) {
      directory = dataLocation.directory
    }
  }

  const eventStatuses: Record<string, Status> = {
    'session.execution.started': 'working',
    'permission.replied': 'working',
    'question.replied': 'working',
    'question.rejected': 'working',
    'permission.asked': 'needs_input',
    'question.asked': 'needs_input',
    'session.execution.failed': 'needs_input',
    // Deprecated in v2 but still emitted alongside session.status.
    'session.idle': 'idle',
  }

  /** Track child (subagent) sessions; returns true when the event is consumed. */
  const trackSessionLifecycle = (
    eventType: string,
    sessionId: string | undefined,
    data: Record<string, unknown>
  ): boolean => {
    if (eventType === 'session.created') {
      if (
        sessionId !== undefined &&
        typeof data.parentID === 'string' &&
        data.parentID.length > 0
      ) {
        childSessionIds.add(sessionId)
      }
      return true
    }
    if (eventType === 'session.deleted') {
      if (sessionId !== undefined) {
        childSessionIds.delete(sessionId)
      }
      return true
    }
    return false
  }

  const handleEvent = (event: unknown): void => {
    if (!isRecord(event) || typeof event.type !== 'string') {
      return
    }
    const data = isRecord(event.data) ? event.data : {}
    rememberDirectory(event, data)

    const sessionId =
      typeof data.sessionID === 'string' && data.sessionID.length > 0
        ? data.sessionID
        : undefined

    if (trackSessionLifecycle(event.type, sessionId, data)) {
      return
    }
    // Child (subagent) session lifecycle must not clobber the root status.
    if (sessionId !== undefined && childSessionIds.has(sessionId)) {
      return
    }

    if (event.type === 'session.status') {
      const status = statusFromSessionStatus(data.status)
      if (status !== undefined) {
        report(status)
      }
      return
    }
    const mapped = eventStatuses[event.type]
    if (mapped !== undefined) {
      report(mapped)
    }
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
