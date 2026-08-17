import type { SlackDaemonStatus } from '@laborer/shared/rpc'
import { Context, Duration, Effect, Layer, Schema, Semaphore } from 'effect'
import { ProcessInspector, type ProcessQuery } from './process-inspector.js'
import {
  type DetachedProcessLaunch,
  ProcessLauncher,
} from './process-launcher.js'

export const SOURCE_LABORER_CHECKOUT =
  '/Users/izakfilmalter/Projects/izakfilmalter/laborer'
export const SOURCE_SLACK_DAEMON_COMMAND = `${SOURCE_LABORER_CHECKOUT}/apps/bot/src/acp-runtime/production-live.ts`

const SLACK_WORKSPACE_REGISTRY =
  '[{"teamId":"T0169RZR7MY","botTokenEnvironment":"SLACK_BOT_TOKEN_STEEPLE","root":"/Users/izakfilmalter/Projects/izakfilmalter/laborer"},{"teamId":"T04UDJP9283","botTokenEnvironment":"SLACK_BOT_TOKEN_FRECKLE","root":"/Users/izakfilmalter/Projects/Freckle/next"}]'

export const SOURCE_SLACK_DAEMON_QUERY: ProcessQuery = {
  commandPath: SOURCE_SLACK_DAEMON_COMMAND,
  cwd: SOURCE_LABORER_CHECKOUT,
}

export const SOURCE_SLACK_DAEMON_LAUNCH: DetachedProcessLaunch = {
  args: [
    '-lc',
    `SLACK_APP_TOKEN="$(/usr/bin/security find-generic-password -a "$USER" -s "laborer-slack-app-token-steeple" -w)" \\
SLACK_BOT_TOKEN_STEEPLE="$(/usr/bin/security find-generic-password -a "$USER" -s "laborer-slack-bot-token-steeple" -w)" \\
SLACK_BOT_TOKEN_FRECKLE="$(/usr/bin/security find-generic-password -a "$USER" -s "laborer-slack-bot-token-freckle" -w)" \\
LABORER_SLACK_WORKSPACES='${SLACK_WORKSPACE_REGISTRY}' \\
exec /Users/izakfilmalter/.bun/bin/bun run start:bot`,
  ],
  cwd: SOURCE_LABORER_CHECKOUT,
  env: {
    HOME: '/Users/izakfilmalter',
    PATH: '/Users/izakfilmalter/.nvm/versions/node/v24.11.1/bin:/Users/izakfilmalter/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    USER: 'izakfilmalter',
  },
  file: '/bin/zsh',
}

export class SlackDaemonControlError extends Schema.TaggedError<SlackDaemonControlError>()(
  'SlackDaemonControlError',
  { message: Schema.String }
) {}

const controlError = (message: string) => () =>
  new SlackDaemonControlError({
    message,
  })

const PROCESS_POLL_INTERVAL = Duration.millis(100)
const PROCESS_POLL_ATTEMPTS = 100

export class SlackDaemonProcessControl extends Context.Service<
  SlackDaemonProcessControl,
  {
    readonly start: () => Effect.Effect<
      SlackDaemonStatus,
      SlackDaemonControlError
    >
    readonly stop: () => Effect.Effect<
      SlackDaemonStatus,
      SlackDaemonControlError
    >
    readonly status: () => Effect.Effect<
      SlackDaemonStatus,
      import('./process-inspector.js').ProcessInspectionError
    >
  }
>()('@laborer/server/SlackDaemonProcessControl') {
  static readonly layer = Layer.effect(
    SlackDaemonProcessControl,
    Effect.gen(function* () {
      const inspector = yield* ProcessInspector
      const launcher = yield* ProcessLauncher
      const controlSemaphore = Semaphore.makeUnsafe(1)

      const status = Effect.fn('SlackDaemonProcessControl.status')(
        function* () {
          const pids = yield* inspector.matchingPids(SOURCE_SLACK_DAEMON_QUERY)
          return {
            status:
              pids.length > 0 ? ('running' as const) : ('stopped' as const),
          }
        }
      )

      const start = Effect.fn('SlackDaemonProcessControl.start')(function* () {
        const current = yield* status()
        if (current.status === 'running') {
          return current
        }
        yield* launcher.launchDetached(SOURCE_SLACK_DAEMON_LAUNCH)
        for (let attempt = 0; attempt < PROCESS_POLL_ATTEMPTS; attempt += 1) {
          yield* Effect.sleep(PROCESS_POLL_INTERVAL)
          const currentStatus = yield* status()
          if (currentStatus.status === 'running') {
            return currentStatus
          }
        }
        return yield* new SlackDaemonControlError({
          message: 'Unable to control Slack daemon',
        })
      })

      const stop = Effect.fn('SlackDaemonProcessControl.stop')(function* () {
        const pids = yield* inspector.matchingPids(SOURCE_SLACK_DAEMON_QUERY)
        if (pids.length === 0) {
          return { status: 'stopped' as const }
        }

        yield* Effect.forEach(
          pids,
          (pid) =>
            inspector.signalIfMatching(
              pid,
              SOURCE_SLACK_DAEMON_QUERY,
              'SIGTERM'
            ),
          { discard: true }
        )

        for (let attempt = 0; attempt < PROCESS_POLL_ATTEMPTS; attempt += 1) {
          yield* Effect.sleep(PROCESS_POLL_INTERVAL)
          const remaining = yield* inspector.matchingPids(
            SOURCE_SLACK_DAEMON_QUERY
          )
          if (remaining.length === 0) {
            return { status: 'stopped' as const }
          }
        }

        return yield* new SlackDaemonControlError({
          message: 'Unable to control Slack daemon',
        })
      })

      return SlackDaemonProcessControl.of({
        start: () =>
          controlSemaphore
            .withPermits(1)(start())
            .pipe(
              Effect.mapError(controlError('Unable to start Slack daemon'))
            ),
        stop: () =>
          controlSemaphore
            .withPermits(1)(stop())
            .pipe(Effect.mapError(controlError('Unable to stop Slack daemon'))),
        status,
      })
    })
  )
}
