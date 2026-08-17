import {
  SlackDaemonRpcs,
  SlackDaemonStartError,
  SlackDaemonStopError,
} from '@laborer/shared/rpc'
import { Effect } from 'effect'
import { SlackDaemonProcessControl } from '../services/slack-daemon-process-control.js'

const startError = () =>
  new SlackDaemonStartError({
    code: 'SLACK_DAEMON_START_FAILED',
    message: 'Unable to start Slack daemon.',
  })

const stopError = () =>
  new SlackDaemonStopError({
    code: 'SLACK_DAEMON_STOP_FAILED',
    message: 'Unable to stop Slack daemon.',
  })

export const SlackDaemonRpcsLive = SlackDaemonRpcs.toLayer(
  Effect.gen(function* () {
    const processControl = yield* SlackDaemonProcessControl

    return SlackDaemonRpcs.of({
      'slackDaemon.status': () =>
        processControl
          .status()
          .pipe(Effect.orElseSucceed(() => ({ status: 'error' as const }))),
      'slackDaemon.start': () =>
        processControl.start().pipe(Effect.mapError(startError)),
      'slackDaemon.stop': () =>
        processControl.stop().pipe(Effect.mapError(stopError)),
    })
  })
)
