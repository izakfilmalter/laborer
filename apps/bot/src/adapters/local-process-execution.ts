import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { constants as fileSystemConstants } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { constants as operatingSystemConstants } from 'node:os'
import { isAbsolute } from 'node:path'
import { finished } from 'node:stream/promises'
import { Context, Effect, Array as EffectArray, Layer, Schema } from 'effect'
import {
  processSupervisorProxyPath,
  terminateSupervisedProcess,
} from './process-supervisor.ts'
import { isSensitiveCredentialEnvironmentName } from './sensitive-environment.ts'

const CONTROL_OUTPUT_LIMIT_BYTES = 4096
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_TIMER_MILLIS = 2_147_483_647

declare const ValidatedExecutableTypeId: unique symbol

/** An absolute executable path checked for execute access before registration. */
export type ValidatedExecutable = string & {
  readonly [ValidatedExecutableTypeId]: true
}

export class ProcessExecutableValidationError extends Schema.TaggedError<ProcessExecutableValidationError>()(
  'ProcessExecutableValidationError',
  { reason: Schema.String }
) {}

export const validateLocalExecutable = (
  executable: string
): Effect.Effect<ValidatedExecutable, ProcessExecutableValidationError> => {
  if (
    !isAbsolute(executable) ||
    executable.length === 0 ||
    executable.includes('\0')
  ) {
    return ProcessExecutableValidationError.make({ reason: 'invalid' })
  }
  return Effect.tryPromise({
    try: async () => {
      await access(executable, fileSystemConstants.X_OK)
      // Match the existing configured-command boundary: an executable must be
      // a regular file itself, not a final symlink whose target can be changed
      // independently after registration.
      if (!(await lstat(executable)).isFile()) {
        throw new Error('not a file')
      }
      return executable as ValidatedExecutable
    },
    catch: () =>
      ProcessExecutableValidationError.make({ reason: 'not-executable' }),
  })
}

export interface LocalProcessLimits {
  readonly deadlineMillis: number
  readonly inputBytes: number
  readonly stderrBytes: number
  readonly stdoutBytes: number
  readonly terminationGraceMillis: number
}

export interface LocalProcessRequest {
  readonly arguments: readonly string[]
  /** Names whose current values may cross the process boundary. */
  readonly environmentNames: readonly string[]
  readonly executable: ValidatedExecutable
  readonly input: Uint8Array
  /** Optional explicit cancellation in addition to Effect fiber interruption. */
  readonly interruptSignal?: AbortSignal
  readonly limits: LocalProcessLimits
  readonly workingDirectory: string
}

export interface LocalProcessEvidence {
  readonly pid: number | null
  readonly stderr: Uint8Array
  readonly stdout: Uint8Array
}

export type LocalProcessResult =
  | ({ readonly _tag: 'Success'; readonly exitCode: 0 } & LocalProcessEvidence)
  | ({
      readonly _tag: 'NonZeroExit'
      readonly exitCode: number | null
      readonly signal: NodeJS.Signals | null
    } & LocalProcessEvidence)
  | ({ readonly _tag: 'SpawnFailure' } & LocalProcessEvidence)
  | ({ readonly _tag: 'Timeout' } & LocalProcessEvidence)
  | ({ readonly _tag: 'Interrupted' } & LocalProcessEvidence)
  | ({
      readonly _tag: 'LimitExceeded'
      readonly limit: 'input' | 'stdout' | 'stderr' | 'protocol'
    } & LocalProcessEvidence)
  | ({
      readonly _tag: 'CleanupUncertain'
      readonly prior: Exclude<
        LocalProcessResult,
        { readonly _tag: 'CleanupUncertain' }
      >
    } & LocalProcessEvidence)

interface SupervisorResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly spawnFailed: boolean
}

const SupervisorResultRecord = Schema.Struct({
  code: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  spawnFailed: Schema.Boolean,
})

const decodeSupervisorResult = Schema.decodeUnknownSync(SupervisorResultRecord)

const isProcessSignal = (value: string): value is NodeJS.Signals =>
  Object.hasOwn(operatingSystemConstants.signals, value)

class SupervisorControlError extends Error {}

const validBound = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0

const validTimerBound = (value: number): boolean =>
  validBound(value) && value <= MAX_TIMER_MILLIS

const requestIsValid = (request: LocalProcessRequest): boolean =>
  typeof request.executable === 'string' &&
  request.executable.length > 0 &&
  isAbsolute(request.executable) &&
  !request.executable.includes('\0') &&
  request.input instanceof Uint8Array &&
  (request.interruptSignal === undefined ||
    request.interruptSignal instanceof AbortSignal) &&
  Array.isArray(request.arguments) &&
  EffectArray.every(
    request.arguments,
    (argument) => typeof argument === 'string' && !argument.includes('\0')
  ) &&
  isAbsolute(request.workingDirectory) &&
  !request.workingDirectory.includes('\0') &&
  Array.isArray(request.environmentNames) &&
  EffectArray.every(
    request.environmentNames,
    (name) => typeof name === 'string' && ENVIRONMENT_NAME.test(name)
  ) &&
  validBound(request.limits.inputBytes) &&
  validBound(request.limits.stdoutBytes) &&
  validBound(request.limits.stderrBytes) &&
  validTimerBound(request.limits.deadlineMillis) &&
  validTimerBound(request.limits.terminationGraceMillis)

const childEnvironment = (
  names: readonly string[],
  ambient: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of EffectArray.dedupe(names)) {
    if (isSensitiveCredentialEnvironmentName(name)) {
      continue
    }
    const value = ambient[name]
    if (value !== undefined) {
      environment[name] = value
    }
  }
  return environment
}

interface BoundedOutput {
  readonly completion: Promise<Buffer>
  readonly exceeded: () => boolean
  readonly snapshot: () => Buffer
}

const collect = (
  stream: NodeJS.ReadableStream,
  maximumBytes: number,
  name: 'stdout' | 'stderr'
): BoundedOutput => {
  const chunks: Buffer[] = []
  let bytes = 0
  let exceeded = false
  const completion = new Promise<Buffer>((resolveOutput, rejectOutput) => {
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (exceeded) {
        // Keep draining while process-tree cleanup runs, but never retain data
        // beyond the caller's bound. Pausing here could deadlock reap waiting
        // behind a child blocked on a full output pipe.
        return
      }
      if (buffer.length > maximumBytes - bytes) {
        exceeded = true
        rejectOutput(name)
        return
      }
      bytes += buffer.length
      chunks.push(buffer)
    }
    stream.on('data', onData)
    stream.once('end', () => {
      stream.removeListener('data', onData)
      resolveOutput(Buffer.concat(chunks, bytes))
    })
    stream.once('error', rejectOutput)
  })
  return {
    completion,
    exceeded: () => exceeded,
    snapshot: () => Buffer.concat(chunks, bytes),
  }
}

const readSupervisorResult = async (
  child: ChildProcessWithoutNullStreams
): Promise<SupervisorResult> => {
  const control = child.stdio[3]
  if (control === undefined || control === null || !('on' in control)) {
    throw new SupervisorControlError()
  }
  const source = await new Promise<Buffer>((resolveLine, rejectLine) => {
    let pending = Buffer.alloc(0)
    let settled = false
    const cleanup = (): void => {
      control.removeListener('data', onData)
      control.removeListener('error', onError)
      control.removeListener('end', onEnd)
    }
    const reject = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      rejectLine(new SupervisorControlError())
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      pending = Buffer.concat([pending, buffer])
      if (pending.length > CONTROL_OUTPUT_LIMIT_BYTES) {
        reject()
        return
      }
      const newline = pending.indexOf(0x0a)
      if (newline >= 0) {
        settled = true
        cleanup()
        resolveLine(pending.subarray(0, newline))
      }
    }
    const onError = (): void => reject()
    const onEnd = (): void => reject()
    control.on('data', onData)
    control.once('error', onError)
    control.once('end', onEnd)
  })
  const line = source.toString('utf8')
  let value: typeof SupervisorResultRecord.Type
  try {
    value = decodeSupervisorResult(JSON.parse(line))
  } catch {
    throw new SupervisorControlError()
  }
  if (value.signal !== null && !isProcessSignal(value.signal)) {
    throw new SupervisorControlError()
  }
  return {
    code: value.code,
    signal: value.signal,
    spawnFailed: value.spawnFailed,
  }
}

const evidence = (
  pid: number | null,
  stdout: Buffer | undefined,
  stderr: Buffer | undefined
): LocalProcessEvidence => ({
  pid,
  stderr: stderr ?? Buffer.alloc(0),
  stdout: stdout ?? Buffer.alloc(0),
})

const spawnFailureResult = (pid: number | null = null): LocalProcessResult => ({
  _tag: 'SpawnFailure',
  ...evidence(pid, undefined, undefined),
})

const preflightResult = (
  request: LocalProcessRequest,
  effectSignal: AbortSignal
): LocalProcessResult | undefined => {
  if (!requestIsValid(request)) {
    return spawnFailureResult()
  }
  if (request.input.byteLength > request.limits.inputBytes) {
    return {
      _tag: 'LimitExceeded',
      limit: 'input',
      ...evidence(null, undefined, undefined),
    }
  }
  if (effectSignal.aborted || request.interruptSignal?.aborted === true) {
    return { _tag: 'Interrupted', ...evidence(null, undefined, undefined) }
  }
  return undefined
}

const destroyProcessStreams = (child: ChildProcessWithoutNullStreams): void => {
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
  const control = child.stdio[3]
  if (control !== undefined && control !== null && 'destroy' in control) {
    control.destroy()
  }
}

const collectSettledOutput = async (
  stdout: BoundedOutput,
  stderr: BoundedOutput,
  timeoutMillis: number
): Promise<readonly [Buffer, Buffer] | undefined> => {
  let timer: NodeJS.Timeout | undefined
  const output = Promise.all([
    stdout.completion.catch(() => stdout.snapshot()),
    stderr.completion.catch(() => stderr.snapshot()),
  ])
  const timeout = new Promise<undefined>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(undefined), timeoutMillis)
  })
  try {
    return await Promise.race([output, timeout])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

type SettledProcess =
  | { readonly _tag: 'report'; readonly report: SupervisorResult }
  | { readonly _tag: 'spawn-failure' }
  | { readonly _tag: 'limit'; readonly limit: unknown }
  | {
      readonly _tag: 'cancel'
      readonly reason: 'interrupted' | 'timeout'
    }

const resultFromSettled = (
  settled: SettledProcess,
  pid: number | null
): Exclude<LocalProcessResult, { readonly _tag: 'CleanupUncertain' }> => {
  const emptyEvidence = evidence(pid, undefined, undefined)
  if (settled._tag === 'cancel') {
    return {
      _tag: settled.reason === 'timeout' ? 'Timeout' : 'Interrupted',
      ...emptyEvidence,
    }
  }
  if (settled._tag === 'spawn-failure') {
    return { _tag: 'SpawnFailure', ...emptyEvidence }
  }
  if (settled._tag === 'limit') {
    const limit =
      settled.limit === 'stderr' || settled.limit === 'stdout'
        ? settled.limit
        : 'protocol'
    return { _tag: 'LimitExceeded', limit, ...emptyEvidence }
  }
  if (settled.report.spawnFailed) {
    return { _tag: 'SpawnFailure', ...emptyEvidence }
  }
  if (settled.report.code === 0 && settled.report.signal === null) {
    return { _tag: 'Success', exitCode: 0, ...emptyEvidence }
  }
  return {
    _tag: 'NonZeroExit',
    exitCode: settled.report.code,
    signal: settled.report.signal,
    ...emptyEvidence,
  }
}

const enforceObservedOutputLimit = (
  result: Exclude<LocalProcessResult, { readonly _tag: 'CleanupUncertain' }>,
  stdoutExceeded: boolean,
  stderrExceeded: boolean
): Exclude<LocalProcessResult, { readonly _tag: 'CleanupUncertain' }> => {
  if (!(stdoutExceeded || stderrExceeded)) {
    return result
  }
  return {
    _tag: 'LimitExceeded',
    limit: stdoutExceeded ? 'stdout' : 'stderr',
    ...evidence(result.pid, undefined, undefined),
  }
}

// The orchestration is intentionally centralized so every exit path reaches the
// same process-tree cleanup and evidence boundary.
const executeProcess = async (
  request: LocalProcessRequest,
  effectSignal: AbortSignal,
  ambient: NodeJS.ProcessEnv,
  terminate: typeof terminateSupervisedProcess
): Promise<LocalProcessResult> => {
  const preflight = preflightResult(request, effectSignal)
  if (preflight !== undefined) {
    return preflight
  }

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(
      process.execPath,
      [processSupervisorProxyPath, request.executable, ...request.arguments],
      {
        cwd: request.workingDirectory,
        detached: true,
        env: childEnvironment(request.environmentNames, ambient),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      }
    ) as ChildProcessWithoutNullStreams
  } catch {
    return spawnFailureResult()
  }

  // `spawn` reports failures such as a missing cwd asynchronously. Always
  // observe the child error event so malformed local selections cannot become
  // an uncaught EventEmitter error in the daemon.
  const spawnFailure = new Promise<SettledProcess>((resolveFailure) => {
    child.once('error', () => resolveFailure({ _tag: 'spawn-failure' }))
  })

  const stdoutOutput = collect(
    child.stdout,
    request.limits.stdoutBytes,
    'stdout'
  )
  const stderrOutput = collect(
    child.stderr,
    request.limits.stderrBytes,
    'stderr'
  )
  let stdout: Buffer | undefined
  let stderr: Buffer | undefined
  let result: Exclude<LocalProcessResult, { readonly _tag: 'CleanupUncertain' }>
  let timer: NodeJS.Timeout | undefined
  let interrupted: (() => void) | undefined
  try {
    const cancellation = new Promise<'timeout' | 'interrupted'>((resolve) => {
      timer = setTimeout(
        () => resolve('timeout'),
        request.limits.deadlineMillis
      )
      interrupted = () => resolve('interrupted')
      effectSignal.addEventListener('abort', interrupted, { once: true })
      request.interruptSignal?.addEventListener('abort', interrupted, {
        once: true,
      })
      if (effectSignal.aborted || request.interruptSignal?.aborted === true) {
        resolve('interrupted')
      }
    })
    const input = finished(child.stdin, { cleanup: true }).then(
      () => true,
      () => false
    )
    child.stdin.end(Buffer.from(request.input))
    const failureOnly = <A>(promise: Promise<A>): Promise<never> =>
      promise.then(
        () => new Promise<never>(() => undefined),
        (failure: unknown) => Promise.reject(failure)
      )
    const settled: SettledProcess = await Promise.race([
      readSupervisorResult(child).then(async (report) => {
        const inputCompleted = await input
        // A known unsuccessful child outcome remains authoritative when the
        // child deliberately closes stdin without consuming the whole bounded
        // request. Successful execution, however, requires the backpressured
        // write to have completed.
        if (
          !inputCompleted &&
          report.code === 0 &&
          report.signal === null &&
          !report.spawnFailed
        ) {
          return { _tag: 'spawn-failure' as const }
        }
        return { _tag: 'report' as const, report }
      }),
      failureOnly(stdoutOutput.completion).catch(
        (failure: unknown): SettledProcess =>
          failure === 'stdout'
            ? { _tag: 'limit', limit: failure }
            : { _tag: 'spawn-failure' }
      ),
      failureOnly(stderrOutput.completion).catch(
        (failure: unknown): SettledProcess =>
          failure === 'stderr'
            ? { _tag: 'limit', limit: failure }
            : { _tag: 'spawn-failure' }
      ),
      spawnFailure,
      cancellation.then((reason) => ({ _tag: 'cancel' as const, reason })),
    ])
    result = resultFromSettled(settled, child.pid ?? null)
  } catch (failure) {
    result =
      failure instanceof SupervisorControlError
        ? {
            _tag: 'LimitExceeded',
            limit: 'protocol',
            ...evidence(child.pid ?? null, stdout, stderr),
          }
        : {
            _tag: 'SpawnFailure',
            ...evidence(child.pid ?? null, stdout, stderr),
          }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    if (interrupted !== undefined) {
      effectSignal.removeEventListener('abort', interrupted)
      request.interruptSignal?.removeEventListener('abort', interrupted)
    }
  }

  // The proxy is a stable ownership sentinel and deliberately stays alive
  // after its child reports an outcome. If it disappears before this adapter
  // begins cleanup, any surviving group members can no longer be signaled
  // without risking a reused numeric PGID.
  if (
    child.pid !== undefined &&
    (child.exitCode !== null || child.signalCode !== null)
  ) {
    destroyProcessStreams(child)
    return {
      _tag: 'CleanupUncertain',
      prior: result,
      ...evidence(child.pid, stdoutOutput.snapshot(), stderrOutput.snapshot()),
    }
  }

  try {
    await terminate(child, request.limits.terminationGraceMillis)
    const output = await collectSettledOutput(
      stdoutOutput,
      stderrOutput,
      request.limits.terminationGraceMillis
    )
    if (output === undefined) {
      destroyProcessStreams(child)
      result = enforceObservedOutputLimit(
        result,
        stdoutOutput.exceeded(),
        stderrOutput.exceeded()
      )
      return {
        _tag: 'CleanupUncertain',
        prior: result,
        ...evidence(
          child.pid ?? null,
          stdoutOutput.snapshot(),
          stderrOutput.snapshot()
        ),
      }
    }
    ;[stdout, stderr] = output
    result = enforceObservedOutputLimit(
      result,
      stdoutOutput.exceeded(),
      stderrOutput.exceeded()
    )
    return { ...result, ...evidence(child.pid ?? null, stdout, stderr) }
  } catch {
    destroyProcessStreams(child)
    stdout = stdoutOutput.snapshot()
    stderr = stderrOutput.snapshot()
    result = enforceObservedOutputLimit(
      result,
      stdoutOutput.exceeded(),
      stderrOutput.exceeded()
    )
    return {
      _tag: 'CleanupUncertain',
      prior: result,
      ...evidence(child.pid ?? null, stdout, stderr),
    }
  }
}

export interface LocalProcessExecutorShape {
  readonly execute: (
    request: LocalProcessRequest
  ) => Effect.Effect<LocalProcessResult>
}

export class LocalProcessExecutor extends Context.Service<
  LocalProcessExecutor,
  LocalProcessExecutorShape
>()('@laborer/LocalProcessExecutor') {
  static layer = (
    ambient: NodeJS.ProcessEnv = process.env,
    terminate: typeof terminateSupervisedProcess = terminateSupervisedProcess
  ) =>
    Layer.succeed(LocalProcessExecutor, {
      execute: (request) =>
        Effect.callback<LocalProcessResult>((resume, signal) => {
          const execution = executeProcess(
            request,
            signal,
            ambient,
            terminate
          ).catch(() => spawnFailureResult())
          execution.then((result) => resume(Effect.succeed(result)))

          // Effect interruption aborts the execution and then waits for this
          // finalizer, preserving the process-tree cleanup guarantee even
          // though an interrupted fiber does not return LocalProcessResult.
          return Effect.promise(() => execution).pipe(Effect.asVoid)
        }),
    })
}
