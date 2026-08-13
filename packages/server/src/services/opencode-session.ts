/**
 * OpenCode v2 session pre-start.
 *
 * OpenCode v2's `--prompt` flag only *prefills* the TUI prompt. Its
 * auto-submit effect fires as soon as the local model-preference file has
 * been read, which happens before the agent and model catalogs for the
 * launch directory have synced from the background service; `submit()` then
 * bails out (no current agent, no model selection) and is never retried
 * because the effect has already latched itself as sent. The prompt sits in
 * the input until a human presses Enter. OpenCode v1 submitted reliably,
 * which is why dragging a described task into In Progress used to start the
 * work by itself.
 *
 * So Laborer stops asking the TUI to submit anything. It creates the session
 * and posts the prompt through the background service's HTTP API — reached
 * with `<agent> api`, which resolves the service endpoint on its own — and
 * then attaches an interactive TUI to that already-running session. The
 * agent starts working before the terminal paints its first frame.
 *
 * The service resolves the default agent and model for the directory, so no
 * model choice is encoded here.
 *
 * Verified against opencode2 `0.0.0-next-17400`.
 */

import { spawn } from '../lib/spawn.js'

/** Time allowed for a single `<agent> api` call before it is killed. */
const API_TIMEOUT_MS = 15_000

/** Upper bound on captured stdout/stderr from one API call. */
const MAX_OUTPUT_BYTES = 64 * 1024

/** Trailing slice of stderr kept when a call fails. */
const MAX_ERROR_LENGTH = 2000

/**
 * Shape of an OpenCode session id. Validated at this boundary so every
 * downstream use — including shell command construction — can trust it.
 */
const SESSION_ID_PATTERN = /^ses[A-Za-z0-9_-]+$/u

interface OpenCodeApiRequest {
  /** JSON request body. */
  readonly body: unknown
  /** Working directory for the CLI invocation. */
  readonly cwd: string
  /** Server path, e.g. `/api/session`. */
  readonly path: string
}

/** Performs one `POST` against the OpenCode server and resolves its stdout. */
type OpenCodeApiRunner = (request: OpenCodeApiRequest) => Promise<string>

interface StartOpenCodeSessionOptions {
  /** CLI to invoke, e.g. `opencode2`. */
  readonly agentCommand: string
  /** Directory the session belongs to — the task's worktree. */
  readonly directory: string
  /** Prompt to hand the agent. */
  readonly prompt: string
  /** Injection seam for tests; defaults to the real CLI. */
  readonly runApi?: OpenCodeApiRunner
}

/** Read a stream as text, discarding anything past `maxBytes`. */
const readBoundedText = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<string> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value === undefined) {
        continue
      }
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        break
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * Run `<agent> api POST <path> -d <json>`.
 *
 * The body travels as its own argv entry, so prompt text never passes
 * through a shell.
 */
const runOpenCodeApi =
  (agentCommand: string): OpenCodeApiRunner =>
  async ({ body, cwd, path }) => {
    const childProcess = spawn(
      [agentCommand, 'api', 'POST', path, '-d', JSON.stringify(body)],
      { cwd }
    )
    const timeout = setTimeout(() => {
      childProcess.kill('SIGKILL')
    }, API_TIMEOUT_MS)

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        childProcess.exited,
        readBoundedText(childProcess.stdout, MAX_OUTPUT_BYTES),
        readBoundedText(childProcess.stderr, MAX_OUTPUT_BYTES),
      ])

      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-MAX_ERROR_LENGTH)
        throw new Error(
          detail ||
            `${agentCommand} api POST ${path} exited with status ${String(exitCode)}.`
        )
      }

      return stdout
    } finally {
      clearTimeout(timeout)
    }
  }

/** Parse the JSON envelope the OpenCode CLI writes to stdout. */
const parseApiResponse = (stdout: string): unknown => {
  const start = stdout.indexOf('{')
  if (start === -1) {
    throw new Error(
      `OpenCode API returned no JSON body: ${stdout.trim().slice(0, 200)}`
    )
  }
  return JSON.parse(stdout.slice(start)) as unknown
}

/**
 * Read the session id out of a `POST /api/session` response, rejecting
 * anything that is not a well-formed id.
 */
const parseSessionId = (stdout: string): string => {
  const response = parseApiResponse(stdout)
  const data =
    typeof response === 'object' && response !== null
      ? (response as { readonly data?: unknown }).data
      : undefined
  const id =
    typeof data === 'object' && data !== null
      ? (data as { readonly id?: unknown }).id
      : undefined

  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
    throw new Error(
      `OpenCode API returned no usable session id: ${stdout.trim().slice(0, 200)}`
    )
  }

  return id
}

/** Whether a value can be trusted as an OpenCode session id. */
const isOpenCodeSessionId = (value: string): boolean =>
  SESSION_ID_PATTERN.test(value)

/**
 * Create a session in `directory` and post `prompt` to it, returning the id
 * to attach a terminal to. The agent begins working as soon as the prompt
 * lands, independent of any TUI.
 */
const startOpenCodeSession = async ({
  agentCommand,
  directory,
  prompt,
  runApi,
}: StartOpenCodeSessionOptions): Promise<string> => {
  const run = runApi ?? runOpenCodeApi(agentCommand)

  const created = await run({
    body: { location: { directory } },
    cwd: directory,
    path: '/api/session',
  })
  const sessionId = parseSessionId(created)

  await run({
    body: { text: prompt },
    cwd: directory,
    path: `/api/session/${sessionId}/prompt`,
  })

  return sessionId
}

export {
  isOpenCodeSessionId,
  parseSessionId,
  startOpenCodeSession,
  type OpenCodeApiRequest,
  type OpenCodeApiRunner,
  type StartOpenCodeSessionOptions,
}
