import { ActionTitle } from '@laborer/task-db'
import { Effect, Schema } from 'effect'
import {
  LocalProcessExecutor,
  type LocalProcessRequest,
  type LocalProcessResult,
  validateLocalExecutable,
} from '../adapters/local-process-execution.ts'
import { defineAction } from './action.ts'

export const RenderLocalTextActionInput = Schema.Struct({
  text: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(1024)),
  title: ActionTitle,
})

export const RenderLocalTextActionResult = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  outcome: Schema.Literals([
    'success',
    'non-zero-exit',
    'spawn-failure',
    'timeout',
    'interrupted',
    'limit-exceeded',
    'cleanup-uncertain',
  ]),
  stderr: Schema.String.check(Schema.isMaxLength(4096)),
  stdout: Schema.String.check(Schema.isMaxLength(4096)),
})

const commandOutcome = (
  tag: LocalProcessResult['_tag']
): (typeof RenderLocalTextActionResult.Type)['outcome'] => {
  switch (tag) {
    case 'Success':
      return 'success'
    case 'NonZeroExit':
      return 'non-zero-exit'
    case 'SpawnFailure':
      return 'spawn-failure'
    case 'Timeout':
      return 'timeout'
    case 'Interrupted':
      return 'interrupted'
    case 'LimitExceeded':
      return 'limit-exceeded'
    case 'CleanupUncertain':
      return 'cleanup-uncertain'
    default:
      return tag satisfies never
  }
}

/** A harmless example of a user-owned command-backed registered Action. */
export const makeRenderLocalTextAction = Effect.fn('makeRenderLocalTextAction')(
  function* (workingDirectory: string) {
    const commandExecutable = yield* validateLocalExecutable(process.execPath)
    const runLocalProcess = (request: LocalProcessRequest) =>
      LocalProcessExecutor.pipe(
        Effect.flatMap((executor) => executor.execute(request)),
        Effect.provide(LocalProcessExecutor.layer())
      )
    return defineAction({
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        'Render bounded text with a registered harmless local command. Returns an Execution immediately; command evidence stays private.',
      input: RenderLocalTextActionInput,
      name: 'render-local-text',
      recoveryPolicy: 'fail-closed',
      result: RenderLocalTextActionResult,
      revision: 'reference-local-command/render-v2',
      run: (request, context) =>
        Effect.gen(function* () {
          yield* context.reportProgress('command-started', {
            kind: 'local-command-started',
          })
          const result = yield* runLocalProcess({
            arguments: [
              '-e',
              'process.stdout.write(process.argv[1])',
              request.text,
            ],
            environmentNames: [],
            executable: commandExecutable,
            input: new Uint8Array(),
            limits: {
              deadlineMillis: 5000,
              inputBytes: 0,
              stderrBytes: 4096,
              stdoutBytes: 4096,
              terminationGraceMillis: 1000,
            },
            workingDirectory,
          })
          const outcome = commandOutcome(result._tag)
          yield* context.reportProgress('command-finished', {
            kind: 'local-command-finished',
            outcome,
          })
          return {
            exitCode:
              'exitCode' in result && typeof result.exitCode === 'number'
                ? result.exitCode
                : null,
            outcome,
            stderr: Buffer.from(result.stderr).toString('utf8'),
            stdout: Buffer.from(result.stdout).toString('utf8'),
          }
        }),
    })
  }
)
