import { Context, Effect, Layer, Schema } from 'effect'
import { execFile } from '../lib/spawn.js'

const PROCESS_LINE_PATTERN = /^\s*(\d+)\s+(.+)$/
const WHITESPACE_PATTERN = /\s+/
const SURROUNDING_QUOTE_PATTERN = /^['"]|['"]$/g

export interface ProcessQuery {
  readonly commandPath: string
  readonly cwd: string
}

export class ProcessInspectionError extends Schema.TaggedError<ProcessInspectionError>()(
  'ProcessInspectionError',
  { message: Schema.String }
) {}

export class ProcessSignalError extends Schema.TaggedError<ProcessSignalError>()(
  'ProcessSignalError',
  { message: Schema.String }
) {}

export class ProcessInspector extends Context.Service<
  ProcessInspector,
  {
    readonly matchingPids: (
      query: ProcessQuery
    ) => Effect.Effect<readonly number[], ProcessInspectionError>
    readonly signalIfMatching: (
      pid: number,
      query: ProcessQuery,
      signal: 'SIGTERM'
    ) => Effect.Effect<boolean, ProcessInspectionError | ProcessSignalError>
  }
>()('@laborer/server/ProcessInspector') {
  static readonly layer = Layer.succeed(
    ProcessInspector,
    makeProcessInspector(exec)
  )
}

export function makeProcessInspector(
  run: (
    file: string,
    args: readonly string[]
  ) => Effect.Effect<string, ProcessInspectionError>
) {
  return {
    matchingPids: Effect.fn('ProcessInspector.matchingPids')(function* (
      query: ProcessQuery
    ) {
      const stdout = yield* run('ps', ['-axo', 'pid=,command='])
      const relativeCommand = query.commandPath.slice(query.cwd.length + 1)
      const candidates = stdout.split('\n').flatMap((line) => {
        const match = PROCESS_LINE_PATTERN.exec(line)
        if (match === null) {
          return []
        }
        const command = match[2]
        if (
          command !== undefined &&
          (hasCommandToken(command, query.commandPath) ||
            hasCommandToken(command, relativeCommand))
        ) {
          return [Number(match[1])]
        }
        return []
      })

      const matches: number[] = []
      for (const pid of candidates) {
        const cwdOutput = yield* inspectCwd(run, pid)
        if (cwdOutput.split('\n').includes(`n${query.cwd}`)) {
          matches.push(pid)
        }
      }
      return matches
    }),
    signalIfMatching: Effect.fn('ProcessInspector.signalIfMatching')(function* (
      pid: number,
      query: ProcessQuery,
      signal: 'SIGTERM'
    ) {
      const command = yield* run('ps', [
        '-p',
        String(pid),
        '-o',
        'command=',
      ]).pipe(Effect.catch(() => Effect.succeed('')))
      const relativeCommand = query.commandPath.slice(query.cwd.length + 1)
      if (
        !(
          hasCommandToken(command, query.commandPath) ||
          hasCommandToken(command, relativeCommand)
        )
      ) {
        return false
      }

      const cwdOutput = yield* inspectCwd(run, pid)
      if (!cwdOutput.split('\n').includes(`n${query.cwd}`)) {
        return false
      }

      yield* Effect.try({
        try: () => {
          process.kill(pid, signal)
          return undefined
        },
        catch: () =>
          new ProcessSignalError({
            message: 'Unable to signal local process',
          }),
      })
      return true
    }),
  }
}

const inspectCwd = (
  run: (
    file: string,
    args: readonly string[]
  ) => Effect.Effect<string, ProcessInspectionError>,
  pid: number
) =>
  run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).pipe(
    // A process disappearing between ps and lsof is an ordinary inspection race.
    Effect.catch(() => Effect.succeed(''))
  )

const hasCommandToken = (command: string, token: string): boolean =>
  command
    .split(WHITESPACE_PATTERN)
    .some((part) => part.replace(SURROUNDING_QUOTE_PATTERN, '') === token)

function exec(
  file: string,
  args: readonly string[]
): Effect.Effect<string, ProcessInspectionError> {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        execFile(file, args, {}, (error, stdout) => {
          if (error !== null) {
            reject(error)
            return
          }
          resolve(stdout)
        })
      }),
    catch: (error) =>
      new ProcessInspectionError({
        message: `Unable to inspect local processes: ${String(error)}`,
      }),
  })
}
