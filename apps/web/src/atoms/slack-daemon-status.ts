/**
 * Shared, ref-counted polling of the source Slack daemon's status.
 *
 * Consumers mount `slackDaemonStatusPollerAtom` and read
 * `slackDaemonStatusAtom`; the registry ref-counts the poller so N consumers
 * share one RPC poll loop. Polling pauses while the page is hidden and
 * refreshes immediately when it becomes visible again.
 *
 * @see apps/web/src/hooks/use-slack-daemon-status.ts — the consuming hook
 */

import type { SlackDaemonStatus } from '@laborer/shared/rpc'
import { Effect, Exit } from 'effect'
import { Atom } from 'effect/unstable/reactivity'

import { BrowserDaemonClient } from './browser-daemon-client'
import { pollWhileVisible } from './page-visibility'

export const SLACK_DAEMON_STATUS_POLL_MS = 2000

/** Structural equality so unchanged polls do not re-render consumers. */
export const areSlackDaemonStatusesEqual = (
  a: SlackDaemonStatus | undefined,
  b: SlackDaemonStatus | undefined
): boolean =>
  a === b || (a !== undefined && b !== undefined && a.status === b.status)

/**
 * Last known daemon status shared by the poll loop and the start/stop
 * actions. Starts undefined until the first poll resolves.
 */
export const slackDaemonStatusAtom = Atom.make<SlackDaemonStatus | undefined>(
  undefined
).pipe(
  Atom.withEquality<SlackDaemonStatus | undefined>(areSlackDaemonStatusesEqual)
)

/**
 * One shared poll loop, ref-counted by atom subscription. A failed status
 * probe is an explicit error state, matching the previous per-hook semantics.
 */
export const slackDaemonStatusPollerAtom = BrowserDaemonClient.runtime.atom(
  (get) => {
    get.mount(slackDaemonStatusAtom)
    return Effect.gen(function* () {
      const client = yield* BrowserDaemonClient
      const poll = client('slackDaemon.status', undefined as never).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            get.set(
              slackDaemonStatusAtom,
              Exit.isSuccess(exit) ? exit.value : { status: 'error' }
            )
          })
        )
      )
      return yield* pollWhileVisible(poll, SLACK_DAEMON_STATUS_POLL_MS)
    })
  }
)
