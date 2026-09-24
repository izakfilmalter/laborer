#!/usr/bin/env bun

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import {
  agent,
  type ContentBlock,
  type McpServer,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type SessionNotification,
  type ToolCall,
} from '@agentclientprotocol/sdk'
import {
  type AgentInfo,
  type EventSubscribeOutput,
  OpenCode,
  type McpServer as OpenCodeMcpServer,
  type SessionInfo,
  type SessionMessageAssistant,
} from '@opencode/client'
import { openCodeMcpConfig } from './action-mcp-timeouts.ts'
import {
  type InstalledOpenCode,
  resolveInstalledOpenCode,
} from './installed-opencode.ts'
import { openPromptEpochEventStream } from './prompt-epoch-admission.ts'

const STARTUP_TIMEOUT_MILLIS = 30_000
const PROJECT_LOAD_TIMEOUT_MILLIS = 30_000
const PROJECT_LOAD_POLL_MILLIS = 250
const PROJECT_LOAD_STABLE_MILLIS = 1000
const MCP_CONNECT_TIMEOUT_MILLIS = 30_000
// OpenCode 2 reloads its tool registry after an MCP change behind a 100ms
// debounce (packages/core/src/tool/mcp.ts) and exposes no event for it.
const MCP_TOOL_REGISTRY_SETTLE_MILLIS = 1000
const SHUTDOWN_TIMEOUT_MILLIS = 3000
const MAX_STARTUP_LINE_BYTES = 64 * 1024

interface AttachedSession {
  readonly cwd: string
  readonly id: string
}

interface TurnControl {
  readonly admission: AbortController
  cancelled: boolean
}

interface ToolState {
  input: Record<string, unknown>
  name: string
}

interface RunningServer {
  readonly child: ChildProcessWithoutNullStreams
  readonly client: ReturnType<typeof OpenCode.make>
  readonly close: () => Promise<void>
  readonly closed: Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const messageId = (): string =>
  `msg_${Date.now().toString(16).padStart(12, '0').slice(-12)}${randomBytes(10)
    .toString('base64url')
    .slice(0, 14)}`

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const stopChild = async (
  child: ChildProcessWithoutNullStreams
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  child.stdin.end()
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve())
  )
  const graceful = await Promise.race([
    exited.then(() => true),
    sleep(SHUTDOWN_TIMEOUT_MILLIS).then(() => false),
  ])
  if (graceful) {
    return
  }
  child.kill('SIGTERM')
  const terminated = await Promise.race([
    exited.then(() => true),
    sleep(SHUTDOWN_TIMEOUT_MILLIS).then(() => false),
  ])
  if (!terminated) {
    child.kill('SIGKILL')
    await exited
  }
}

const readReadinessUrl = async (
  child: ChildProcessWithoutNullStreams
): Promise<string> => {
  let buffered = Buffer.alloc(0)
  for await (const chunk of child.stdout) {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)])
    if (buffered.byteLength > MAX_STARTUP_LINE_BYTES) {
      throw new Error('OpenCode startup record exceeded the limit')
    }
    const newline = buffered.indexOf(0x0a)
    if (newline < 0) {
      continue
    }
    const parsed: unknown = JSON.parse(
      buffered.subarray(0, newline).toString('utf8')
    )
    if (!(isRecord(parsed) && typeof parsed.url === 'string')) {
      throw new Error('OpenCode returned an invalid startup record')
    }
    return parsed.url
  }
  throw new Error('OpenCode exited before reporting readiness')
}

const startServer = async (
  installed: InstalledOpenCode
): Promise<RunningServer> => {
  const password = randomBytes(32).toString('base64url')
  const child = spawn(installed.command, ['serve', '--stdio', '--port', '0'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_PASSWORD: password,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>((resolveClosed) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveClosed()
      return
    }
    child.once('exit', () => resolveClosed())
  })
  child.stderr.resume()
  const url = await Promise.race([
    readReadinessUrl(child),
    sleep(STARTUP_TIMEOUT_MILLIS).then(() => {
      throw new Error('OpenCode server startup timed out')
    }),
  ]).catch(async (cause) => {
    await stopChild(child)
    throw cause
  })
  child.stdout.resume()
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  return {
    child,
    client: OpenCode.make({ baseUrl: url, headers: { authorization } }),
    close: () => stopChild(child),
    closed,
  }
}

const toolKind = (name: string): NonNullable<ToolCall['kind']> => {
  switch (name.toLowerCase()) {
    case 'bash':
    case 'shell':
      return 'execute'
    case 'read':
      return 'read'
    case 'edit':
    case 'patch':
    case 'write':
      return 'edit'
    case 'glob':
    case 'grep':
      return 'search'
    case 'webfetch':
      return 'fetch'
    default:
      return 'other'
  }
}

const pendingToolCall = (
  callId: string,
  name: string,
  input: Record<string, unknown>
): ToolCall => ({
  kind: toolKind(name),
  name,
  rawInput: input,
  status: 'pending',
  title: name,
  toolCallId: callId,
})

const contentText = (content: readonly unknown[]): string =>
  content
    .flatMap((part) =>
      isRecord(part) && typeof part.text === 'string' ? [part.text] : []
    )
    .join('')

const promptParts = (blocks: readonly ContentBlock[]) => {
  const text: string[] = []
  const files: Array<{ name?: string; uri: string }> = []
  for (const block of blocks) {
    if (block.type === 'text') {
      text.push(block.text)
      continue
    }
    if (block.type === 'image') {
      if (block.data) {
        files.push({ uri: `data:${block.mimeType};base64,${block.data}` })
      } else if (block.uri) {
        files.push({ uri: block.uri })
      }
      continue
    }
    if (block.type === 'resource_link') {
      files.push({
        name: block.name,
        uri: block.uri,
      })
      continue
    }
    if (block.type === 'resource' && 'text' in block.resource) {
      text.push(block.resource.text)
    }
  }
  return { files, text: text.join('\n') }
}

const stopReasonFor = (
  terminal: 'failed' | 'interrupted' | 'succeeded',
  cancelled: boolean,
  finish: SessionMessageAssistant['finish']
) => {
  if (cancelled || terminal === 'interrupted') {
    return 'cancelled' as const
  }
  if (finish === 'length') {
    return 'max_tokens' as const
  }
  if (finish === 'content-filter') {
    return 'refusal' as const
  }
  return 'end_turn' as const
}

// A turn OpenCode definitely finished without success. The client matches this
// exact shape to settle the prompt as failed instead of ambiguous.
const executionFailed = (): RequestError =>
  RequestError.internalError(
    { execution: 'failed' },
    'OpenCode execution failed'
  )

const responseFor = (
  terminal: 'failed' | 'interrupted' | 'succeeded',
  cancelled: boolean,
  finish: SessionMessageAssistant['finish']
) => ({ _meta: {}, stopReason: stopReasonFor(terminal, cancelled, finish) })

const settleTurn = (
  terminal: 'failed' | 'interrupted' | 'succeeded',
  cancelled: boolean,
  finish: SessionMessageAssistant['finish'],
  executionError: { readonly type: string } | undefined
) => {
  if (terminal === 'failed') {
    if (executionError?.type === 'provider.auth') {
      throw RequestError.authRequired()
    }
    if (executionError?.type === 'provider.content-filter') {
      return responseFor(terminal, cancelled, 'content-filter')
    }
    throw executionFailed()
  }
  // OpenCode can settle the execution after a provider stream broke off
  // mid-reply; the step's error finish is the only signal of that.
  if (terminal === 'succeeded' && finish === 'error' && !cancelled) {
    throw executionFailed()
  }
  return responseFor(terminal, cancelled, finish)
}

const assertMatchingCwd = async (
  requested: string,
  persisted: string,
  sessionId: string
): Promise<void> => {
  const [requestedRoot, persistedRoot] = await Promise.all([
    realpath(requested),
    realpath(persisted),
  ]).catch(() => {
    throw RequestError.resourceNotFound(sessionId)
  })
  if (requestedRoot !== persistedRoot) {
    throw RequestError.resourceNotFound(sessionId)
  }
}

const run = async (): Promise<void> => {
  const installed = resolveInstalledOpenCode()
  const server = await startServer(installed)
  const sessions = new Map<string, AttachedSession>()
  const active = new Map<string, TurnControl>()
  const ownedMcpNames = new Set<string>()

  const registerMcpServers = async (
    session: AttachedSession,
    servers: readonly McpServer[]
  ): Promise<void> => {
    const location = { directory: session.cwd }
    const existing = await server.client.mcp.list({ location })
    for (const registration of servers) {
      if (
        existing.data.some(
          (candidate: OpenCodeMcpServer) => candidate.name === registration.name
        ) &&
        !ownedMcpNames.has(registration.name)
      ) {
        throw new Error(
          `MCP registration name is already configured: ${registration.name}`
        )
      }
      await server.client.mcp.add({
        config: openCodeMcpConfig(registration),
        location,
        server: registration.name,
      })
      ownedMcpNames.add(registration.name)
    }
    await awaitMcpServersSettled(
      location,
      servers.map((registration) => registration.name)
    )
  }

  // OpenCode 2 connects added MCP servers asynchronously and then reloads its
  // tool registry; a prompt sent before both finish runs without the tools.
  const awaitMcpServersSettled = async (
    location: { readonly directory: string },
    names: readonly string[]
  ): Promise<void> => {
    if (names.length === 0) {
      return
    }
    const deadline = Date.now() + MCP_CONNECT_TIMEOUT_MILLIS
    while (Date.now() < deadline) {
      const listed = await server.client.mcp.list({ location })
      const pending = names.some((name) => {
        const status = listed.data.find(
          (candidate: OpenCodeMcpServer) => candidate.name === name
        )?.status.status
        return status === undefined || status === 'pending'
      })
      if (!pending) {
        await sleep(MCP_TOOL_REGISTRY_SETTLE_MILLIS)
        return
      }
      await sleep(PROJECT_LOAD_POLL_MILLIS)
    }
    throw new Error('OpenCode did not connect the registered MCP servers')
  }

  let connection: ReturnType<ReturnType<typeof agent>['connect']> | undefined

  // OpenCode 2 loads a project in stages: built-in agents first, then the
  // operator's agents, then providers (which change the default model). It
  // exposes no completion signal, so wait until agents and the default model
  // stop changing.
  const awaitProjectLoaded = async (location: {
    readonly directory: string
  }) => {
    const deadline = Date.now() + PROJECT_LOAD_TIMEOUT_MILLIS
    let previous: string | undefined
    let stableSince = Date.now()
    while (true) {
      const [agents, defaultModel] = await Promise.all([
        server.client.agent.list({ location }),
        server.client.model.default({ location }),
      ])
      const snapshot = JSON.stringify([
        agents.data.map((candidate: AgentInfo) => [
          candidate.id,
          candidate.mode,
          candidate.hidden,
          candidate.model ?? null,
        ]),
        defaultModel.data
          ? [defaultModel.data.providerID, defaultModel.data.id]
          : null,
      ])
      const now = Date.now()
      if (snapshot !== previous) {
        previous = snapshot
        stableSince = now
      } else if (
        agents.data.length > 0 &&
        now - stableSince >= PROJECT_LOAD_STABLE_MILLIS
      ) {
        return agents
      }
      if (now >= deadline) {
        if (agents.data.length > 0) {
          return agents
        }
        throw new Error('OpenCode did not load the project in time')
      }
      await sleep(PROJECT_LOAD_POLL_MILLIS)
    }
  }

  const streamTurn = async (
    session: AttachedSession,
    prompt: readonly ContentBlock[],
    meta: Record<string, unknown> | undefined,
    peer: {
      requestPermission: (input: {
        options: Array<{
          kind: 'allow_always' | 'allow_once' | 'reject_once'
          name: string
          optionId: string
        }>
        sessionId: string
        toolCall: ToolCall
      }) => Promise<{ outcome: { optionId?: string; outcome: string } }>
      sessionUpdate: (input: SessionNotification) => Promise<unknown>
    }
  ) => {
    const control: TurnControl = {
      admission: new AbortController(),
      cancelled: false,
    }
    if (active.has(session.id)) {
      throw new Error('Session already has an active prompt')
    }
    active.set(session.id, control)
    const streamController = new AbortController()
    let stream: ReturnType<
      ReturnType<
        typeof server.client.event.subscribe
      >[typeof Symbol.asyncIterator]
    >
    const promptId = messageId()
    const epoch = meta?.['laborer.dev/prompt-epoch']
    try {
      stream = await openPromptEpochEventStream({
        publishEpoch: async () => {
          if (typeof epoch === 'string') {
            await peer.sessionUpdate({
              sessionId: session.id,
              update: {
                _meta: { 'laborer.dev/prompt-epoch': epoch },
                content: { text: '', type: 'text' },
                messageId: promptId,
                sessionUpdate: 'user_message_chunk',
              },
            })
          }
        },
        subscribe: () =>
          server.client.event
            .subscribe({ signal: streamController.signal })
            [Symbol.asyncIterator](),
      })
    } catch (cause) {
      active.delete(session.id)
      streamController.abort()
      throw cause
    }
    let started = false
    let finish: SessionMessageAssistant['finish']
    let executionError:
      | { readonly message: string; readonly type: string }
      | undefined
    const tools = new Map<string, ToolState>()
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one bounded protocol dispatcher keeps OpenCode event ordering explicit
    const consume = async () => {
      while (!streamController.signal.aborted) {
        const next = await stream.next()
        if (next.done) {
          throw new Error(
            'OpenCode event stream disconnected during prompt execution'
          )
        }
        const event: EventSubscribeOutput = next.value
        if (
          event.type === 'permission.asked' &&
          event.data.sessionID === session.id
        ) {
          const tool = event.data.source?.id
            ? tools.get(event.data.source.id)
            : undefined
          const toolName = tool?.name ?? event.data.action
          const toolInput = { ...event.data.metadata, ...tool?.input }
          const result = await peer
            .requestPermission({
              options: [
                { kind: 'allow_once', name: 'Allow once', optionId: 'once' },
                {
                  kind: 'allow_always',
                  name: 'Always allow',
                  optionId: 'always',
                },
                { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
              ],
              sessionId: session.id,
              toolCall: pendingToolCall(
                event.data.source?.id ?? event.data.id,
                toolName,
                toolInput
              ),
            })
            .catch(() => undefined)
          const option =
            result?.outcome.outcome === 'selected'
              ? result.outcome.optionId
              : undefined
          await server.client.permission.reply({
            decision:
              option === 'once' || option === 'always' ? option : 'reject',
            requestID: event.data.id,
            sessionID: session.id,
          })
          continue
        }
        if (
          event.type === 'form.created' &&
          event.data.form.sessionID === session.id
        ) {
          await server.client.session.form
            .cancel({ formID: event.data.form.id, sessionID: session.id })
            .catch(() =>
              server.client.session
                .interrupt({ sessionID: session.id })
                .catch(() => undefined)
            )
          continue
        }
        if (
          !('sessionID' in event.data) ||
          event.data.sessionID !== session.id
        ) {
          continue
        }
        if (
          event.type === 'session.inbox.delivered' &&
          event.data.inboxID === promptId
        ) {
          started = true
          continue
        }
        if (!started) {
          continue
        }
        if (event.type === 'session.text.delta') {
          await peer.sessionUpdate({
            sessionId: session.id,
            update: {
              content: { text: event.data.delta, type: 'text' },
              messageId: event.data.assistantMessageID,
              sessionUpdate: 'agent_message_chunk',
            },
          })
        } else if (event.type === 'session.reasoning.delta') {
          await peer.sessionUpdate({
            sessionId: session.id,
            update: {
              content: { text: event.data.delta, type: 'text' },
              messageId: event.data.assistantMessageID,
              sessionUpdate: 'agent_thought_chunk',
            },
          })
        } else if (event.type === 'session.tool.input.started') {
          tools.set(event.data.id, { input: {}, name: event.data.name })
        } else if (event.type === 'session.tool.called') {
          const current = tools.get(event.data.id) ?? {
            input: {},
            name: 'tool',
          }
          current.input = event.data.input
          tools.set(event.data.id, current)
          await peer.sessionUpdate({
            sessionId: session.id,
            update: {
              ...pendingToolCall(event.data.id, current.name, current.input),
              sessionUpdate: 'tool_call',
            },
          })
        } else if (event.type === 'session.tool.success') {
          tools.delete(event.data.id)
          await peer.sessionUpdate({
            sessionId: session.id,
            update: {
              content: event.data.content.length
                ? [
                    {
                      content: {
                        text: contentText(event.data.content),
                        type: 'text',
                      },
                      type: 'content',
                    },
                  ]
                : [],
              rawOutput: { metadata: event.data.metadata ?? {} },
              status: 'completed',
              toolCallId: event.data.id,
              sessionUpdate: 'tool_call_update',
            },
          })
        } else if (event.type === 'session.tool.failed') {
          tools.delete(event.data.id)
          await peer.sessionUpdate({
            sessionId: session.id,
            update: {
              rawOutput: { error: event.data.error.message },
              status: 'failed',
              toolCallId: event.data.id,
              sessionUpdate: 'tool_call_update',
            },
          })
        } else if (event.type === 'session.step.ended') {
          finish = event.data.finish
        } else if (event.type === 'session.execution.succeeded') {
          return 'succeeded'
        } else if (event.type === 'session.execution.interrupted') {
          return 'interrupted'
        } else if (event.type === 'session.execution.failed') {
          executionError = event.data.error
          return 'failed'
        }
      }
      return 'interrupted'
    }
    const completed = consume()
    try {
      const parts = promptParts(prompt)
      await server.client.session
        .prompt(
          {
            delivery: 'steer',
            files: parts.files,
            id: promptId,
            sessionID: session.id,
            text: parts.text,
          },
          { signal: control.admission.signal }
        )
        .catch((cause) => {
          if (!control.cancelled) {
            throw cause
          }
        })
      if (control.cancelled) {
        await server.client.session
          .interrupt({ sessionID: session.id })
          .catch(() => undefined)
        if (!started) {
          streamController.abort()
          await completed.catch(() => undefined)
          return responseFor('interrupted', true, undefined)
        }
      }
      return settleTurn(
        await completed,
        control.cancelled,
        finish,
        executionError
      )
    } finally {
      active.delete(session.id)
      streamController.abort()
      await stream.return?.(undefined).catch(() => undefined)
    }
  }

  const app = agent({ name: 'laborer-opencode-v2-acp-adapter' })
    .onRequest(methods.agent.initialize, ({ params }) => {
      if (params.protocolVersion !== PROTOCOL_VERSION) {
        throw RequestError.invalidParams('stable ACP v1 is required')
      }
      return {
        agentCapabilities: {
          _meta:
            params.clientCapabilities?._meta?.[
              'laborer.dev/prompt-epoch/v1'
            ] === true
              ? { 'laborer.dev/prompt-epoch/v1': true }
              : {},
          loadSession: false,
          mcpCapabilities: { http: true, sse: false },
          promptCapabilities: { embeddedContext: true, image: true },
          sessionCapabilities: {
            close: {},
            list: {},
            resume: {},
          },
        },
        agentInfo: { name: 'OpenCode', version: installed.version },
        protocolVersion: PROTOCOL_VERSION,
      }
    })
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const location = { directory: params.cwd }
      const agents = await awaitProjectLoaded(location)
      const primary = agents.data.find(
        (candidate: AgentInfo) =>
          candidate.mode === 'primary' && !candidate.hidden
      )
      // Pin the agent's configured model like OpenCode's own clients do.
      // Without one, leave it unset so OpenCode resolves its default when the
      // turn runs: providers load asynchronously, and the default read at
      // startup can be a fallback model rather than the configured one.
      const created = await server.client.session.create({
        ...(primary ? { agent: primary.id } : {}),
        ...(primary?.model ? { model: primary.model } : {}),
        location,
      })
      const session = { cwd: params.cwd, id: created.id }
      await registerMcpServers(session, params.mcpServers)
      sessions.set(session.id, session)
      return { sessionId: session.id }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      let restored: SessionInfo
      try {
        restored = await server.client.session.get({
          sessionID: params.sessionId,
        })
      } catch {
        throw RequestError.resourceNotFound(params.sessionId)
      }
      const session = { cwd: restored.location.directory, id: restored.id }
      await assertMatchingCwd(params.cwd, session.cwd, params.sessionId)
      await awaitProjectLoaded({ directory: session.cwd })
      await registerMcpServers(session, params.mcpServers ?? [])
      sessions.set(session.id, session)
      return {}
    })
    .onRequest(methods.agent.session.list, async ({ params }) => {
      const listed = await server.client.session.list({
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.cwd ? { directory: params.cwd } : {}),
        limit: 100,
        order: 'desc',
      })
      return {
        ...(listed.cursor.next ? { nextCursor: listed.cursor.next } : {}),
        sessions: listed.data.map((session: SessionInfo) => ({
          cwd: session.location.directory,
          sessionId: session.id,
        })),
      }
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      sessions.delete(params.sessionId)
      const turn = active.get(params.sessionId)
      if (turn) {
        turn.cancelled = true
        turn.admission.abort()
      }
      await server.client.session
        .interrupt({ sessionID: params.sessionId })
        .catch(() => undefined)
      return {}
    })
    .onRequest(methods.agent.session.prompt, ({ client: peer, params }) => {
      const session = sessions.get(params.sessionId)
      if (!session) {
        throw RequestError.resourceNotFound(params.sessionId)
      }
      return streamTurn(
        session,
        params.prompt,
        isRecord(params._meta) ? params._meta : undefined,
        {
          requestPermission: (input) =>
            peer.request(methods.client.session.requestPermission, input),
          sessionUpdate: (input) =>
            peer.notify(methods.client.session.update, input),
        }
      )
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const turn = active.get(params.sessionId)
      if (turn) {
        turn.cancelled = true
        turn.admission.abort()
      }
      await server.client.session
        .interrupt({ sessionID: params.sessionId })
        .catch(() => undefined)
    })

  try {
    connection = app.connect(
      ndJsonStream(
        Writable.toWeb(process.stdout),
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )
    await Promise.race([
      connection.closed,
      server.closed.then(() => {
        throw new Error('OpenCode server exited unexpectedly')
      }),
    ])
  } finally {
    connection?.close()
    await server.close()
  }
}

run().catch((cause) => {
  const message =
    cause instanceof Error ? cause.message : 'unknown adapter failure'
  process.stderr.write(`OpenCode ACP adapter failed: ${message}\n`)
  process.exitCode = 1
})
