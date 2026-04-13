import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
} from 'node:child_process'
import { createInterface } from 'node:readline'
import { RpcError } from '@laborer/shared/rpc'
import { Context, Effect, Layer } from 'effect'

const SHURU_WORKSPACE_PATH = '/workspace'
const SHURU_WORKSPACE_MOUNT = `${SHURU_WORKSPACE_PATH}:ro`
const SHURU_TERMINAL_ID_PREFIX = 'shuru:'
const READY_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 5000
const STDERR_TAIL_LIMIT = 4096
const TERMINAL_OUTPUT_BUFFER_LIMIT = 64 * 1024
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

interface PendingTerminalNotification {
  bufferedOutput: string
  exitCode: number | null
}

interface StartShuruSandboxParams {
  readonly portForward?: ShuruPortForward | null
  readonly workspaceId: string
  readonly worktreePath: string
}

interface ShuruSandboxHandle {
  readonly sandboxId: string
}

interface ShuruPortForward {
  readonly guestPort: number
  readonly hostPort: number
}

interface SpawnShuruTerminalParams {
  readonly argv: readonly string[]
  readonly command: string
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly workspaceId: string
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

const trimTerminalOutputBuffer = (output: string): string =>
  output.length <= TERMINAL_OUTPUT_BUFFER_LIMIT
    ? output
    : output.slice(-TERMINAL_OUTPUT_BUFFER_LIMIT)

const isSpawnResult = (value: unknown): value is { readonly pid: string } =>
  isRecord(value) && typeof value.pid === 'string'

const resolveShuruCommand = (): readonly string[] => {
  const configured = process.env.LABORER_SHURU_BIN?.trim()
  if (configured && configured.length > 0) {
    return configured.split(WHITESPACE_PATTERN)
  }

  return ['shuru']
}

const buildShuruRunArgs = (
  worktreePath: string,
  portForward?: ShuruPortForward | null
): readonly string[] => [
  ...resolveShuruCommand(),
  'run',
  '--stdio',
  '--mount',
  `${worktreePath}:${SHURU_WORKSPACE_MOUNT}`,
  ...(portForward === undefined || portForward === null
    ? []
    : [
        '-p',
        `${String(portForward.hostPort)}:${String(portForward.guestPort)}`,
      ]),
]

class ShuruTerminalHandle {
  private bufferedOutput = ''
  private exitCode: number | null = null
  private readonly exitListeners = new Set<(code: number) => void>()
  private readonly outputListeners = new Set<(data: string) => void>()
  readonly pid: string
  private status: 'running' | 'stopped' = 'running'
  readonly workspaceId: string
  private readonly runtime: ShuruRpcProcess

  constructor(runtime: ShuruRpcProcess, pid: string, workspaceId: string) {
    this.runtime = runtime
    this.pid = pid
    this.workspaceId = workspaceId
  }

  getBufferedOutput(): string {
    return this.bufferedOutput
  }

  getExitCode(): number | null {
    return this.exitCode
  }

  getStatus(): 'running' | 'stopped' {
    return this.status
  }

  onExit(listener: (code: number) => void): () => void {
    this.exitListeners.add(listener)
    return () => {
      this.exitListeners.delete(listener)
    }
  }

  onOutput(listener: (data: string) => void): () => void {
    this.outputListeners.add(listener)
    return () => {
      this.outputListeners.delete(listener)
    }
  }

  handleExit(code: number): void {
    if (this.status === 'stopped') {
      return
    }

    this.status = 'stopped'
    this.exitCode = code

    for (const listener of this.exitListeners) {
      listener(code)
    }
  }

  handleOutput(text: string): void {
    if (text.length === 0) {
      return
    }

    this.bufferedOutput = trimTerminalOutputBuffer(
      `${this.bufferedOutput}${text}`
    )

    for (const listener of this.outputListeners) {
      listener(text)
    }
  }

  kill(): Promise<void> {
    if (this.status === 'stopped') {
      return Promise.resolve()
    }

    return this.runtime.request('kill', { pid: this.pid }).then(() => undefined)
  }

  write(data: string): void {
    if (this.status === 'stopped') {
      return
    }

    this.runtime.sendNotification('input', {
      pid: this.pid,
      data: Buffer.from(data).toString('base64'),
    })
  }
}

const shuruTerminalHandles = new Map<string, ShuruTerminalHandle>()

const getShuruTerminalHandle = (
  terminalId: string
): ShuruTerminalHandle | undefined => shuruTerminalHandles.get(terminalId)

const clearShuruTerminalHandles = (): void => {
  shuruTerminalHandles.clear()
}

const removeShuruTerminalHandle = (terminalId: string): void => {
  shuruTerminalHandles.delete(terminalId)
}

const removeWorkspaceTerminalHandles = (workspaceId: string): void => {
  for (const [terminalId, handle] of shuruTerminalHandles) {
    if (handle.workspaceId === workspaceId) {
      shuruTerminalHandles.delete(terminalId)
    }
  }
}

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
  private readonly pendingProcessNotifications = new Map<
    string,
    PendingTerminalNotification
  >()
  private readonly processHandles = new Map<string, ShuruTerminalHandle>()
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

  sendNotification(method: string, params: Record<string, unknown>): void {
    if (this.closed || this.child.stdin.destroyed) {
      return
    }

    const payload = JSON.stringify({ jsonrpc: '2.0', method, params })
    this.child.stdin.write(`${payload}\n`)
  }

  async spawnProcess({
    argv,
    cwd,
    env,
    workspaceId,
  }: {
    readonly argv: readonly string[]
    readonly cwd?: string | undefined
    readonly env?: Record<string, string> | undefined
    readonly workspaceId: string
  }): Promise<ShuruTerminalHandle> {
    const response = await this.request('spawn', {
      argv: [...argv],
      cwd,
      env,
    })

    if (!isSpawnResult(response.result)) {
      throw new Error('Shuru returned an invalid spawn response')
    }

    const handle = new ShuruTerminalHandle(
      this,
      response.result.pid,
      workspaceId
    )
    this.processHandles.set(response.result.pid, handle)
    this.replayPendingProcessNotifications(response.result.pid, handle)
    return handle
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

    for (const handle of this.processHandles.values()) {
      handle.handleExit(1)
    }
    this.pendingProcessNotifications.clear()
    this.processHandles.clear()
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
      this.handleNotification(message)
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

  private handleNotification(message: JsonRpcNotification): void {
    if (message.method === 'ready' && this.onReadySuccess !== null) {
      this.onReadySuccess()
      this.onReadySuccess = null
      this.onReadyError = null
      return
    }

    if (!isRecord(message.params)) {
      return
    }

    if (message.method === 'output') {
      this.handleOutputNotification(message.params)
      return
    }

    if (message.method === 'exit') {
      this.handleExitNotification(message.params)
    }
  }

  private handleOutputNotification(params: Record<string, unknown>): void {
    if (typeof params.pid !== 'string' || typeof params.data !== 'string') {
      return
    }

    const output = Buffer.from(params.data, 'base64').toString('utf8')
    const handle = this.processHandles.get(params.pid)
    if (handle !== undefined) {
      handle.handleOutput(output)
      return
    }

    const pending = this.getOrCreatePendingProcessNotification(params.pid)
    pending.bufferedOutput = trimTerminalOutputBuffer(
      `${pending.bufferedOutput}${output}`
    )
  }

  private handleExitNotification(params: Record<string, unknown>): void {
    if (typeof params.pid !== 'string' || typeof params.code !== 'number') {
      return
    }

    const handle = this.processHandles.get(params.pid)
    if (handle !== undefined) {
      handle.handleExit(params.code)
      this.processHandles.delete(params.pid)
      return
    }

    const pending = this.getOrCreatePendingProcessNotification(params.pid)
    pending.exitCode = params.code
  }

  private getOrCreatePendingProcessNotification(
    pid: string
  ): PendingTerminalNotification {
    const existing = this.pendingProcessNotifications.get(pid)
    if (existing !== undefined) {
      return existing
    }

    const pending: PendingTerminalNotification = {
      bufferedOutput: '',
      exitCode: null,
    }
    this.pendingProcessNotifications.set(pid, pending)
    return pending
  }

  private replayPendingProcessNotifications(
    pid: string,
    handle: ShuruTerminalHandle
  ): void {
    const pending = this.pendingProcessNotifications.get(pid)
    if (pending === undefined) {
      return
    }

    this.pendingProcessNotifications.delete(pid)

    if (pending.bufferedOutput.length > 0) {
      handle.handleOutput(pending.bufferedOutput)
    }

    if (pending.exitCode !== null) {
      handle.handleExit(pending.exitCode)
      this.processHandles.delete(pid)
    }
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
    readonly spawnTerminal: (params: SpawnShuruTerminalParams) => Effect.Effect<
      {
        readonly command: string
        readonly id: string
        readonly status: 'running' | 'stopped'
        readonly workspaceId: string
      },
      RpcError
    >
    readonly killTerminal: (terminalId: string) => Effect.Effect<void, RpcError>
    readonly removeTerminal: (
      terminalId: string
    ) => Effect.Effect<void, RpcError>
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
          removeWorkspaceTerminalHandles(workspaceId)
        })

      yield* Effect.addFinalizer(() =>
        Effect.forEach(Array.from(runtimes.keys()), (workspaceId) =>
          stopRuntime(workspaceId).pipe(Effect.catchAll(() => Effect.void))
        ).pipe(
          Effect.andThen(Effect.sync(clearShuruTerminalHandles)),
          Effect.asVoid
        )
      )

      const startSandbox = Effect.fn('ShuruClient.startSandbox')(function* ({
        portForward,
        workspaceId,
        worktreePath,
      }: StartShuruSandboxParams) {
        if (runtimes.has(workspaceId)) {
          return yield* new RpcError({
            message: `A Shuru sandbox is already running for workspace "${workspaceId}".`,
            code: 'SHURU_ALREADY_RUNNING',
          })
        }

        const args = buildShuruRunArgs(worktreePath, portForward)
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

      const spawnTerminal = Effect.fn('ShuruClient.spawnTerminal')(function* ({
        argv,
        command,
        cwd,
        env,
        workspaceId,
      }: SpawnShuruTerminalParams) {
        const runtime = runtimes.get(workspaceId)
        if (runtime === undefined) {
          return yield* new RpcError({
            message: `Cannot spawn a Shuru terminal: workspace "${workspaceId}" has no active sandbox.`,
            code: 'NOT_FOUND',
          })
        }

        const handle = yield* Effect.tryPromise({
          try: () => runtime.spawnProcess({ argv, cwd, env, workspaceId }),
          catch: (error) =>
            new RpcError({
              message:
                error instanceof Error
                  ? error.message
                  : `Failed to spawn a Shuru process for workspace "${workspaceId}".`,
              code: 'SHURU_TERMINAL_FAILED',
            }),
        })

        const terminalId = `${SHURU_TERMINAL_ID_PREFIX}${crypto.randomUUID()}`
        yield* Effect.sync(() => {
          shuruTerminalHandles.set(terminalId, handle)
        })

        return {
          command,
          id: terminalId,
          status: handle.getStatus(),
          workspaceId,
        } as const
      })

      const killTerminal = Effect.fn('ShuruClient.killTerminal')(function* (
        terminalId: string
      ) {
        const handle = getShuruTerminalHandle(terminalId)
        if (handle === undefined) {
          return yield* new RpcError({
            message: `Shuru terminal not found: ${terminalId}`,
            code: 'TERMINAL_NOT_FOUND',
          })
        }

        yield* Effect.tryPromise({
          try: () => handle.kill(),
          catch: (error) =>
            new RpcError({
              message:
                error instanceof Error
                  ? error.message
                  : `Failed to stop Shuru terminal "${terminalId}".`,
              code: 'SHURU_TERMINAL_FAILED',
            }),
        })
      })

      const removeTerminal = Effect.fn('ShuruClient.removeTerminal')(function* (
        terminalId: string
      ) {
        const handle = getShuruTerminalHandle(terminalId)
        if (handle === undefined) {
          return
        }

        yield* Effect.sync(() => {
          removeShuruTerminalHandle(terminalId)
        })

        if (handle.getStatus() === 'stopped') {
          return
        }

        yield* Effect.tryPromise({
          try: () => handle.kill(),
          catch: (error) =>
            new RpcError({
              message:
                error instanceof Error
                  ? error.message
                  : `Failed to remove Shuru terminal "${terminalId}".`,
              code: 'SHURU_TERMINAL_FAILED',
            }),
        }).pipe(Effect.catchAll(() => Effect.void))
      })

      return ShuruClient.of({
        killTerminal,
        removeTerminal,
        startSandbox,
        spawnTerminal,
        stopSandbox: stopRuntime,
      })
    })
  )
}

export {
  SHURU_TERMINAL_ID_PREFIX,
  SHURU_WORKSPACE_PATH,
  ShuruClient,
  getShuruTerminalHandle,
  removeShuruTerminalHandle,
}
