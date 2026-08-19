import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'

export interface DetachedProcessLaunch {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly file: string
  /**
   * Append the child's stdout and stderr here. Without it a detached process
   * that dies during startup leaves no trace anywhere, so the caller can only
   * observe that it stopped, never why.
   */
  readonly logFile?: string | undefined
}

export class ProcessLaunchError extends Schema.TaggedError<ProcessLaunchError>()(
  'ProcessLaunchError',
  { message: Schema.String }
) {}

/**
 * Open the log for appending, or give up on logging. A state directory that
 * cannot be written is no reason to refuse to start the process, which would
 * turn a logging problem into an outage.
 */
const openAppendLog = (path: string): number | undefined => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    return openSync(path, 'a')
  } catch {
    return undefined
  }
}

export class ProcessLauncher extends Context.Service<
  ProcessLauncher,
  {
    readonly launchDetached: (
      launch: DetachedProcessLaunch
    ) => Effect.Effect<void, ProcessLaunchError>
  }
>()('@laborer/server/ProcessLauncher') {
  static readonly layer = Layer.succeed(
    ProcessLauncher,
    makeProcessLauncher(spawn)
  )
}

interface DetachedChild {
  readonly off: (event: 'error' | 'exit', listener: () => void) => unknown
  readonly once: (event: 'error' | 'exit', listener: () => void) => unknown
  readonly unref: () => unknown
}

type LaunchStdio = 'ignore' | ['ignore', number, number]

type SpawnDetached = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly detached: true
    readonly env: Readonly<Record<string, string>>
    readonly stdio: LaunchStdio
  }
) => DetachedChild

export function makeProcessLauncher(
  spawnDetached: SpawnDetached,
  openLog: (path: string) => number | undefined = openAppendLog,
  closeLog: (descriptor: number) => void = closeSync
) {
  return {
    launchDetached: Effect.fn('ProcessLauncher.launchDetached')(
      (launch: DetachedProcessLaunch) =>
        Effect.tryPromise({
          try: (signal) =>
            new Promise<void>((resolve, reject) => {
              const descriptor =
                launch.logFile === undefined
                  ? undefined
                  : openLog(launch.logFile)
              const child = spawnDetached(launch.file, launch.args, {
                cwd: launch.cwd,
                detached: true,
                env: launch.env,
                stdio:
                  descriptor === undefined
                    ? 'ignore'
                    : ['ignore', descriptor, descriptor],
              })
              // The child has its own duplicate of the descriptor, so this end
              // must close or the parent leaks one per launch.
              if (descriptor !== undefined) {
                closeLog(descriptor)
              }
              let settled = false

              const cleanup = () => {
                clearTimeout(timer)
                child.off('error', onError)
                child.off('exit', onExit)
                signal.removeEventListener('abort', onAbort)
              }
              const fail = () => {
                if (settled) {
                  return
                }
                settled = true
                cleanup()
                reject(new Error('Detached process launch failed'))
              }
              const timer = setTimeout(() => {
                if (settled) {
                  return
                }
                settled = true
                cleanup()
                resolve()
              }, 500)
              const onError = () => fail()
              const onExit = () => fail()
              const onAbort = () => fail()

              child.once('error', onError)
              child.once('exit', onExit)
              signal.addEventListener('abort', onAbort, { once: true })
              child.unref()
            }),
          catch: () =>
            new ProcessLaunchError({
              message: 'Unable to launch detached process',
            }),
        })
    ),
  }
}
