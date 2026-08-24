import { useAtomMount, useAtomValue } from '@effect/atom-react/Hooks'
import { RegistryContext } from '@effect/atom-react/RegistryContext'
import type { TerminalHostStatus } from '@laborer/shared/rpc'
import { Effect } from 'effect'
import { useCallback, useContext } from 'react'

import {
  terminalHostStatusAtom,
  terminalHostStatusPollerAtom,
} from '@/atoms/terminal-host-status'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'

/**
 * A failed restart must not leave the optimistic progress state stuck. Keep a
 * newer status observed by polling, otherwise return to the last actionable
 * state so the operator can retry.
 */
export function statusAfterRestartFailure(
  current: TerminalHostStatus | undefined,
  previous: TerminalHostStatus | undefined
): TerminalHostStatus | undefined {
  return current?.state === 'restarting' ? previous : current
}

/**
 * Terminal host health shared across all consumers: N mounts share one poll
 * loop via `terminalHostStatusPollerAtom`. The restart action updates the
 * shared atom so every consumer sees the optimistic and final status.
 */
export function useTerminalHostStatus() {
  useAtomMount(terminalHostStatusPollerAtom)
  const status = useAtomValue(terminalHostStatusAtom)
  const registry = useContext(RegistryContext)
  const runtimeResult = useAtomValue(TerminalServiceClient.runtime)

  const restart = useCallback(async () => {
    if (runtimeResult._tag !== 'Success') {
      throw new Error('Terminal service is unavailable')
    }
    const previousStatus = registry.get(terminalHostStatusAtom)
    registry.set(terminalHostStatusAtom, {
      expectedVersion: previousStatus?.expectedVersion ?? 'unknown',
      ...(previousStatus?.runningVersion === undefined
        ? {}
        : { runningVersion: previousStatus.runningVersion }),
      state: 'restarting',
    })
    try {
      const next = await Effect.runPromiseWith(runtimeResult.value)(
        Effect.gen(function* () {
          const client = yield* TerminalServiceClient
          return yield* client('terminal.restartHost', undefined as never)
        })
      )
      registry.set(terminalHostStatusAtom, next)
    } catch (error) {
      registry.set(
        terminalHostStatusAtom,
        statusAfterRestartFailure(
          registry.get(terminalHostStatusAtom),
          previousStatus
        )
      )
      throw error
    }
  }, [registry, runtimeResult])

  return { restart, status }
}
