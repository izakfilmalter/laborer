/**
 * One-shot OpenCode runs, for the places mission control needs a model to
 * answer a question rather than to do work.
 *
 * `opencode2 run` is used headlessly: a prompt in, JSONL out, process gone.
 * There is no session to keep alive because nothing here is a conversation —
 * the Slack planner reads a thread once, the source-control writer reads a
 * diff once. Anchoring each run in a `cwd` matters more than it looks: without
 * one the child inherits the Electron process's home directory and the
 * OpenCode daemon boots a throwaway project over all of `~` before answering.
 *
 * @see slack-workspace-planner.ts — turns a Slack thread into a workspace plan
 * @see source-control-text-generation.ts — writes commit messages and PR bodies
 */

import { spawn } from '../lib/spawn.js'

const PROCESS_KILL_GRACE_MS = 2000
const MAX_ERROR_LENGTH = 2000
const MAX_STDERR_BYTES = 64 * 1024
const MAX_STDOUT_BYTES = 1024 * 1024

const JSON_CODE_FENCE_START_PATTERN = /^```(?:json)?\s*/iu
const JSON_CODE_FENCE_END_PATTERN = /\s*```$/u

interface OpenCodeTextEvent {
  readonly part?: {
    readonly text?: unknown
    readonly type?: unknown
  }
  readonly type?: unknown
}

/** The argv for a headless run of `prompt` against `model`. */
const buildOpenCodeCommand = (model: string, prompt: string): string[] => [
  'opencode2',
  'run',
  '--format',
  'json',
  '--model',
  model,
  '--auto',
  prompt,
]

/**
 * Collect the assistant's prose out of an OpenCode JSONL transcript.
 *
 * Every other event kind — tool calls, diagnostics, step boundaries — is
 * noise for a one-shot question, and malformed lines are skipped rather than
 * failing the run, because a single bad diagnostic line should not lose an
 * otherwise complete answer.
 */
const extractOpenCodeText = (stdout: string): string => {
  const textParts: string[] = []

  for (const line of stdout.split('\n')) {
    if (!line.trimStart().startsWith('{')) {
      continue
    }

    try {
      const event = JSON.parse(line) as OpenCodeTextEvent
      if (
        event.type === 'text' &&
        event.part?.type === 'text' &&
        typeof event.part.text === 'string'
      ) {
        textParts.push(event.part.text)
      }
    } catch {
      // OpenCode emits JSONL. Ignore malformed diagnostic lines and continue
      // looking for valid text events.
    }
  }

  return textParts.join('\n').trim()
}

/**
 * Strip the markdown fence a model wraps JSON in when it ignores the "no
 * markdown" instruction, which it does often enough to be worth absorbing.
 */
const stripJsonCodeFence = (text: string): string =>
  text
    .trim()
    .replace(JSON_CODE_FENCE_START_PATTERN, '')
    .replace(JSON_CODE_FENCE_END_PATTERN, '')

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

const readBoundedText = async (
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  label: string
): Promise<string> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        return text + decoder.decode()
      }
      bytesRead += result.value.byteLength
      if (bytesRead > maximumBytes) {
        throw new Error(`OpenCode ${label} exceeded the output limit.`)
      }
      text += decoder.decode(result.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

const terminateProcess = async (
  childProcess: ReturnType<typeof spawn>
): Promise<void> => {
  childProcess.kill('SIGTERM')
  const exitedDuringGracePeriod = await Promise.race([
    childProcess.exited.then(
      () => true,
      () => true
    ),
    delay(PROCESS_KILL_GRACE_MS).then(() => false),
  ])

  if (!exitedDuringGracePeriod) {
    childProcess.kill('SIGKILL')
    await childProcess.exited.catch(() => undefined)
  }
}

interface OpenCodeProcessOptions {
  readonly argv: readonly string[]
  readonly cwd?: string | undefined
  readonly signal: AbortSignal
  readonly timeoutMessage?: string
  readonly timeoutMs: number
}

/**
 * Run OpenCode to completion and hand back its stdout.
 *
 * Output is bounded on both streams so a runaway transcript cannot exhaust
 * memory, and the deadline is raced ahead of the kill so a terminated child's
 * nonzero exit never masquerades as a failure of the model.
 */
const executeOpenCodeProcess = async ({
  argv,
  cwd,
  signal,
  timeoutMessage = 'OpenCode timed out.',
  timeoutMs,
}: OpenCodeProcessOptions): Promise<string> => {
  const childProcess = spawn([...argv], cwd === undefined ? {} : { cwd })
  let termination: Promise<void> | undefined
  const startTermination = (): Promise<void> => {
    termination ??= terminateProcess(childProcess)
    return termination
  }
  const abortProcess = (): void => {
    startTermination().catch(() => undefined)
  }
  signal.addEventListener('abort', abortProcess, { once: true })

  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      // Reject before the SIGTERM lands. A terminated OpenCode exits with a
      // nonzero status during the kill grace period, and that exit must not
      // win the race below and masquerade as a process failure — the card
      // badge then blames OpenCode ("exited with status 130") for what was a
      // deadline.
      startTermination().catch(() => undefined)
      reject(new Error(timeoutMessage))
    }, timeoutMs)
  })

  try {
    const result = await Promise.race([
      Promise.all([
        childProcess.exited,
        readBoundedText(childProcess.stdout, MAX_STDOUT_BYTES, 'stdout'),
        readBoundedText(childProcess.stderr, MAX_STDERR_BYTES, 'stderr'),
      ]),
      timeoutPromise,
    ])
    const [exitCode, stdout, stderr] = result

    if (exitCode !== 0) {
      const detail = stderr.trim().slice(-MAX_ERROR_LENGTH)
      throw new Error(
        detail || `OpenCode exited with status ${String(exitCode)}.`
      )
    }

    return stdout
  } catch (error) {
    await startTermination().catch(() => undefined)
    throw error
  } finally {
    signal.removeEventListener('abort', abortProcess)
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
    await termination
  }
}

interface OpenCodePromptOptions {
  readonly cwd?: string | undefined
  readonly model: string
  readonly prompt: string
  readonly signal: AbortSignal
  readonly timeoutMessage?: string
  readonly timeoutMs: number
}

/** Ask the model one question and return the prose it answered with. */
const runOpenCodePrompt = async ({
  cwd,
  model,
  prompt,
  signal,
  timeoutMessage,
  timeoutMs,
}: OpenCodePromptOptions): Promise<string> => {
  const stdout = await executeOpenCodeProcess({
    argv: buildOpenCodeCommand(model, prompt),
    cwd,
    signal,
    ...(timeoutMessage === undefined ? {} : { timeoutMessage }),
    timeoutMs,
  })
  return extractOpenCodeText(stdout)
}

export {
  buildOpenCodeCommand,
  executeOpenCodeProcess,
  extractOpenCodeText,
  runOpenCodePrompt,
  stripJsonCodeFence,
}
