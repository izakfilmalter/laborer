import { spawn } from 'node:child_process'
import { Context, Effect, Layer, Schema } from 'effect'

export interface DetachedProcessLaunch {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly file: string
}

export class ProcessLaunchError extends Schema.TaggedError<ProcessLaunchError>()(
  'ProcessLaunchError',
  { message: Schema.String }
) {}

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

type SpawnDetached = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly detached: true
    readonly env: Readonly<Record<string, string>>
    readonly stdio: 'ignore'
  }
) => DetachedChild

export function makeProcessLauncher(spawnDetached: SpawnDetached) {
  return {
    launchDetached: Effect.fn('ProcessLauncher.launchDetached')(
      (launch: DetachedProcessLaunch) =>
        Effect.tryPromise({
          try: (signal) =>
            new Promise<void>((resolve, reject) => {
              const child = spawnDetached(launch.file, launch.args, {
                cwd: launch.cwd,
                detached: true,
                env: launch.env,
                stdio: 'ignore',
              })
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
