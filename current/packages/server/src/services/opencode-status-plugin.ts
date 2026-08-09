import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentStatus } from '@laborer/shared/rpc'

interface OpenCodeStatusReport {
  readonly sequence: number
  readonly status: AgentStatus
}

type SendStatusReport = (report: OpenCodeStatusReport) => Promise<void>

/**
 * OpenCode's plugin runtime. Keep this function self-contained: the installer
 * embeds its JavaScript representation in the user-level plugin file.
 */
function createOpenCodeStatusPluginRuntime(send: SendStatusReport) {
  type Status = 'working' | 'needs_input' | 'idle'
  interface Waiter {
    readonly resolve: () => void
  }

  let sequence = Date.now() * 1000
  let rootSessionId: string | undefined
  const childSessionIds = new Set<string>()
  let sending = false
  let pending: { status: Status; waiters: Waiter[] } | undefined

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null

  const sessionIdFrom = (
    properties: Record<string, unknown>
  ): string | undefined => {
    if (
      typeof properties.sessionID === 'string' &&
      properties.sessionID.length > 0
    ) {
      return properties.sessionID
    }
    const info = properties.info
    return isRecord(info) && typeof info.id === 'string' && info.id.length > 0
      ? info.id
      : undefined
  }

  const statusFrom = (value: unknown): Status | undefined => {
    let kind: string | undefined
    if (typeof value === 'string') {
      kind = value
    } else if (isRecord(value) && typeof value.type === 'string') {
      kind = value.type
    }
    if (kind === undefined) {
      return undefined
    }
    switch (kind.toLowerCase()) {
      case 'idle':
        return 'idle'
      case 'active':
      case 'busy':
      case 'pending':
      case 'retry':
      case 'running':
      case 'streaming':
      case 'working':
        return 'working'
      default:
        return undefined
    }
  }

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
        await send({ sequence, status: current.status })
      } catch {
        // Status is advisory. A later native event gets another attempt.
      }
      for (const waiter of current.waiters) {
        waiter.resolve()
      }
    }
    sending = false
  }

  // At most one request is in flight. While it is in flight, retain only the
  // newest lifecycle fact, resolving all coalesced event callbacks with it.
  const report = (status: Status): Promise<void> =>
    new Promise((resolve) => {
      if (pending === undefined) {
        pending = { status, waiters: [{ resolve }] }
      } else {
        pending.status = status
        pending.waiters.push({ resolve })
      }
      drain().catch(() => {
        // drain handles transport errors; this only guards an unexpected bug.
      })
    })

  const belongsToRoot = (sessionId: string | undefined): boolean => {
    if (sessionId === undefined) {
      return true
    }
    if (childSessionIds.has(sessionId)) {
      return false
    }
    rootSessionId ??= sessionId
    return rootSessionId === sessionId
  }

  const acceptsSessionEvent = (
    eventType: string,
    properties: Record<string, unknown>
  ): boolean => {
    const sessionId = sessionIdFrom(properties)
    const info = properties.info
    const infoId =
      isRecord(info) && typeof info.id === 'string' && info.id.length > 0
        ? info.id
        : undefined
    const parentId =
      isRecord(info) &&
      typeof info.parentID === 'string' &&
      info.parentID.length > 0
        ? info.parentID
        : undefined

    if (infoId !== undefined && parentId !== undefined) {
      childSessionIds.add(infoId)
    } else if (eventType === 'session.created' && infoId !== undefined) {
      // OpenCode can replace the root session without replacing its process.
      // Follow that explicit lifecycle event rather than permanently binding
      // this plugin instance to the first session it observed.
      childSessionIds.delete(infoId)
      rootSessionId = infoId
    }

    const accepted = belongsToRoot(sessionId)
    if (!accepted && eventType === 'session.deleted' && infoId !== undefined) {
      childSessionIds.delete(infoId)
    }
    return accepted
  }

  return {
    'chat.message': async ({ sessionID }: { readonly sessionID?: string }) => {
      if (belongsToRoot(sessionID)) {
        await report('working')
      }
    },
    event: async ({ event }: { readonly event?: unknown }) => {
      if (!isRecord(event) || typeof event.type !== 'string') {
        return
      }
      const properties = isRecord(event.properties) ? event.properties : {}
      if (!acceptsSessionEvent(event.type, properties)) {
        return
      }

      switch (event.type) {
        case 'session.status': {
          const status = statusFrom(properties.status)
          if (status !== undefined) {
            await report(status)
          }
          break
        }
        case 'tool.execute.before':
        case 'tool.execute.after':
        case 'permission.replied':
        case 'question.replied':
        case 'question.rejected':
        case 'session.compacted':
          await report('working')
          break
        case 'permission.asked':
        case 'question.asked':
        case 'session.error':
          await report('needs_input')
          break
        case 'session.idle':
          await report('idle')
          break
        case 'session.deleted':
          break
        default:
          break
      }
    },
  }
}

const openCodePluginSource = (): string => `// installed and managed by Laborer
// Reinstalling or updating Laborer may overwrite this file.
const createOpenCodeStatusPluginRuntime = ${createOpenCodeStatusPluginRuntime.toString()};

const send = async (report) => {
  const hookUrl = process.env.LABORER_HOOK_URL;
  const terminalId = process.env.LABORER_TERMINAL_ID;
  if (!hookUrl || !terminalId) return;
  await fetch(hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalId, ...report }),
    signal: AbortSignal.timeout(1000),
  });
};

export const LaborerAgentStatusPlugin = async () =>
  process.env.LABORER_HOOK_URL && process.env.LABORER_TERMINAL_ID
    ? createOpenCodeStatusPluginRuntime(send)
    : {};
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
  createOpenCodeStatusPluginRuntime,
  type InstallOpenCodeStatusPluginOptions,
  installOpenCodeStatusPlugin,
  type OpenCodeStatusReport,
  openCodePluginSource,
}
