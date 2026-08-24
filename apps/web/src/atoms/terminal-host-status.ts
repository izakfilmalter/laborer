/**
 * Shared, ref-counted polling of the detached terminal host's health.
 *
 * Consumers mount `terminalHostStatusPollerAtom` and read
 * `terminalHostStatusAtom`; the registry ref-counts the poller so N consumers
 * share one RPC poll loop. Polling pauses while the page is hidden and
 * refreshes immediately when it becomes visible again.
 *
 * @see apps/web/src/hooks/use-terminal-host-status.ts — the consuming hook
 */

import type { TerminalHostStatus } from '@laborer/shared/rpc'
import { Effect } from 'effect'
import { Atom } from 'effect/unstable/reactivity'

import { pollWhileVisible } from './page-visibility'
import { TerminalServiceClient } from './terminal-service-client'

/** Health is advisory, so a modest poll keeps it off the terminal data path. */
export const TERMINAL_HOST_STATUS_POLL_MS = 2000

/** Structural equality so unchanged polls do not re-render consumers. */
export const areTerminalHostStatusesEqual = (
  a: TerminalHostStatus | undefined,
  b: TerminalHostStatus | undefined
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.state === b.state &&
    a.expectedVersion === b.expectedVersion &&
    a.runningVersion === b.runningVersion)

/**
 * Last known host status shared by the poll loop and the restart action.
 * Starts undefined until the first successful poll.
 */
export const terminalHostStatusAtom = Atom.make<TerminalHostStatus | undefined>(
  undefined
).pipe(
  Atom.withEquality<TerminalHostStatus | undefined>(
    areTerminalHostStatusesEqual
  )
)

/**
 * One shared poll loop, ref-counted by atom subscription. Poll failures are
 * swallowed: connection health owns daemon-level failures, so the last known
 * host state is preserved rather than replaced with transport noise.
 */
export const terminalHostStatusPollerAtom = TerminalServiceClient.runtime.atom(
  (get) => {
    get.mount(terminalHostStatusAtom)
    return Effect.gen(function* () {
      const client = yield* TerminalServiceClient
      const poll = client('terminal.hostStatus', undefined as never).pipe(
        Effect.flatMap((next) =>
          Effect.sync(() => get.set(terminalHostStatusAtom, next))
        ),
        Effect.exit,
        Effect.asVoid
      )
      return yield* pollWhileVisible(poll, TERMINAL_HOST_STATUS_POLL_MS)
    })
  }
)
