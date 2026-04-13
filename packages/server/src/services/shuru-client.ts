import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
} from 'node:child_process'
import { createInterface } from 'node:readline'
import { RpcError } from '@laborer/shared/rpc'
import { Context, Effect, Layer } from 'effect'

const SHURU_WORKSPACE_PATH = '/workspace'
const SHURU_WORKSPACE_MOUNT = `${SHURU_WORKSPACE_PATH}:ro`
const READY_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 5000
const STDERR_TAIL_LIMIT = 4096
const WHITESPACE_PATTERN = /\s+/

interface JsonRpcErrorResponse {
  readonly error: {
    readonly code: number
    readonly message: string
  }
  readonly id: number
  readonly jsonrpc: '2.0'
}

interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: Record<string, unknown> | undefined
}

interface JsonRpcResult {
  readonly id: number
  readonly jsonrpc: '2.0'
  readonly result: unknown
}

interface PendingRequest {
  readonly reject: (error: Error) => void
  readonly resolve: (result: JsonRpcResult) => void
}

interface StartShuruSandboxParams {
  readonly workspaceId: string
  readonly worktreePath: string
}

interface ShuruSandboxHandle {
  readonly sandboxId: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isJsonRpcNotification = (value: unknown): value is JsonRpcNotification =>
  isRecord(value) &&
  value.jsonrpc === '2.0' &&
  typeof value.method === 'string' &&
  !('id' in value)

const isJsonRpcErrorResponse = (
  value: unknown
): value is JsonRpcErrorResponse =>
  isRecord(value) &&
  value.jsonrpc === '2.0' &&
  typeof value.id === 'number' &&
  isRecord(value.error) &&
  typeof value.error.code === 'number' &&
  typeof value.error.message === 'string'

const isJsonRpcResult = (value: unknown): value is JsonRpcResult =>
  isRecord(value) &&
  value.jsonrpc === '2.0' &&
  typeof value.id === 'number' &&
  'result' in value &&
  !('error' in value)

const formatShuruError = (message: string, stderrTail: string): string => {
  const trimmedStderr = stderrTail.trim()
  if (trimmedStderr.length === 0) {
    return message
  }

  return `${message} ${trimmedStderr}`
}

const resolveShuruCommand = (): readonly string[] => {
  const configured = process.env.LABORER_SHURU_BIN?.trim()
  if (configured && configured.length > 0) {
    return configured.split(WHITESPACE_PATTERN)
  }

  return ['shuru']
}

const buildShuruRunArgs = (worktreePath: string): readonly string[] => [
  ...resolveShuruCommand(),
  'run',
  '--stdio',
  '--mount',
  `${worktreePath}:${SHURU_WORKSPACE_MOUNT}`,
]

class ShuruRpcProcess {
  static async start(args: readonly string[]): Promise<ShuruRpcProcess> {
    const [command, ...commandArgs] = args
    if (command === undefined) {
      throw new Error('Shuru command is empty')
    }

    const child = nodeSpawn(command, commandArgs, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const shuruProcess = new ShuruRpcProcess(child)
    await shuruProcess.waitUntilReady()
    return shuruProcess
  }

  private readonly closePromise: Promise<void>
  private closed = false
  private idCounter = 0
  private onReadyError: ((error: Error) => void) | null = null
  private onReadySuccess: (() => void) | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly readyPromise: Promise<void>
  private stderrTail = ''

  private readonly child: ChildProcessWithoutNullStreams

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.onReadySuccess = resolve
      this.onReadyError = reject
    })

    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(
        -STDERR_TAIL_LIMIT
      )
    })

    const output = createInterface({ input: this.child.stdout })
    output.on('line', (line) => {
      this.handleLine(line)
    })

    this.child.on('error', (error) => {
      this.handleClose(error)
    })

    this.closePromise = new Promise<void>((resolve) => {
      this.child.once('close', (code) => {
        this.handleClose(
          new Error(
            formatShuruError(
              `shuru exited before completing the request (exit ${String(code ?? 1)})`,
              this.stderrTail
            )
          )
        )
        output.close()
        resolve()
      })
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  request(
    method: string,
    params: Record<string, unknown>
  ): Promise<JsonRpcResult> {
    if (this.closed || this.child.stdin.destroyed) {
      throw new Error('shuru process is not running')
    }

    const id = ++this.idCounter
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    return new Promise<JsonRpcResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(`${payload}\n`, (error) => {
        if (error) {
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (this.closed) {
      await this.closePromise
      return
    }

    try {
      this.child.stdin.end()
    } catch {
      // The process may already be shutting down.
    }

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Timed out waiting for Shuru sandbox to stop'))
      }, SHUTDOWN_TIMEOUT_MS)
    })

    try {
      await Promise.race([this.closePromise, timeout])
    } catch {
      this.child.kill('SIGTERM')
      await this.closePromise
    }
  }

  async validateWorkspaceMount(): Promise<void> {
    await this.request('stat', { path: SHURU_WORKSPACE_PATH })
  }

  private handleClose(error: Error): void {
    if (this.closed) {
      return
    }

    this.closed = true

    if (this.onReadyError !== null) {
      this.onReadyError(error)
      this.onReadyError = null
      this.onReadySuccess = null
    }

    for (const [, request] of this.pending) {
      request.reject(error)
    }
    this.pending.clear()
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) {
      return
    }

    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (isJsonRpcNotification(message)) {
      if (message.method === 'ready' && this.onReadySuccess !== null) {
        this.onReadySuccess()
        this.onReadySuccess = null
        this.onReadyError = null
      }
      return
    }

    if (isJsonRpcErrorResponse(message)) {
      const request = this.pending.get(message.id)
      if (request === undefined) {
        return
      }

      this.pending.delete(message.id)
      request.reject(new Error(message.error.message))
      return
    }

    if (!isJsonRpcResult(message)) {
      return
    }

    const request = this.pending.get(message.id)
    if (request === undefined) {
      return
    }

    this.pending.delete(message.id)
    request.resolve(message)
  }

  private async waitUntilReady(): Promise<void> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            formatShuruError(
              'Timed out waiting for shuru --stdio to signal readiness.',
              this.stderrTail
            )
          )
        )
      }, READY_TIMEOUT_MS)
    })

    await Promise.race([this.readyPromise, timeout])
  }
}

class ShuruClient extends Context.Tag('@laborer/ShuruClient')<
  ShuruClient,
  {
    readonly startSandbox: (
      params: StartShuruSandboxParams
    ) => Effect.Effect<ShuruSandboxHandle, RpcError>
    readonly stopSandbox: (workspaceId: string) => Effect.Effect<void, RpcError>
  }
>() {
  static readonly layer = Layer.scoped(
    ShuruClient,
    Effect.gen(function* () {
      const runtimes = new Map<string, ShuruRpcProcess>()

      const stopRuntime = (
        workspaceId: string
      ): Effect.Effect<void, RpcError> =>
        Effect.gen(function* () {
          const runtime = runtimes.get(workspaceId)
          if (runtime === undefined) {
            return
          }

          yield* Effect.tryPromise({
            try: () => runtime.stop(),
            catch: (error) =>
              new RpcError({
                message:
                  error instanceof Error
                    ? error.message
                    : `Failed to stop Shuru sandbox for workspace "${workspaceId}"`,
                code: 'SHURU_STOP_FAILED',
              }),
          })

          runtimes.delete(workspaceId)
        })

      yield* Effect.addFinalizer(() =>
        Effect.forEach(Array.from(runtimes.keys()), (workspaceId) =>
          stopRuntime(workspaceId).pipe(Effect.catchAll(() => Effect.void))
        ).pipe(Effect.asVoid)
      )

      const startSandbox = Effect.fn('ShuruClient.startSandbox')(function* ({
        workspaceId,
        worktreePath,
      }: StartShuruSandboxParams) {
        if (runtimes.has(workspaceId)) {
          return yield* new RpcError({
            message: `A Shuru sandbox is already running for workspace "${workspaceId}".`,
            code: 'SHURU_ALREADY_RUNNING',
          })
        }

        const args = buildShuruRunArgs(worktreePath)
        const runtime = yield* Effect.tryPromise({
          try: () => ShuruRpcProcess.start(args),
          catch: (error) =>
            new RpcError({
              message: formatShuruError(
                `Failed to start Shuru sandbox for workspace "${workspaceId}".`,
                error instanceof Error ? error.message : String(error)
              ),
              code: 'SHURU_START_FAILED',
            }),
        })

        const cleanup = Effect.tryPromise({
          try: () => runtime.stop(),
          catch: () =>
            new RpcError({
              message: `Failed to stop partially started Shuru sandbox for workspace "${workspaceId}".`,
              code: 'SHURU_STOP_FAILED',
            }),
        }).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.asVoid
        )

        const validate = Effect.tryPromise({
          try: () => runtime.validateWorkspaceMount(),
          catch: (error) =>
            new RpcError({
              message: formatShuruError(
                `Failed to verify the Shuru /workspace mount for workspace "${workspaceId}".`,
                error instanceof Error ? error.message : String(error)
              ),
              code: 'SHURU_START_FAILED',
            }),
        })

        yield* validate.pipe(
          Effect.catchAll((error) =>
            cleanup.pipe(Effect.andThen(Effect.fail(error)))
          )
        )

        yield* Effect.sync(() => {
          runtimes.set(workspaceId, runtime)
        })

        return {
          sandboxId: `shuru:${String(runtime.pid ?? crypto.randomUUID())}`,
        } satisfies ShuruSandboxHandle
      })

      return ShuruClient.of({
        startSandbox,
        stopSandbox: stopRuntime,
      })
    })
  )
}

export { SHURU_WORKSPACE_PATH, ShuruClient }
