/**
 * Independent terminal spawning hook.
 *
 * Provides a `spawnTerminal` function where each call runs as an
 * independent Effect fiber — multiple concurrent spawns do not
 * interfere with each other.
 *
 * This replaces the shared `LaborerClient.mutation('terminal.spawn')`
 * atom for spawning, which operates in "latest-wins" mode: calling it
 * a second time interrupts the previous in-flight request's fiber.
 *
 * Follows VS Code's architecture where each `TerminalInstance` owns its
 * own `TerminalProcessManager` — spawns are fully independent per call.
 *
 * @see .reference/vscode/src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts
 * @see packages/shared/src/rpc.ts — terminal.spawn RPC definition
 */

import { useAtomMount, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { Effect, Runtime } from 'effect'
import { useCallback } from 'react'

import { LaborerClient } from '@/atoms/laborer-client'

/** Payload shape matching the terminal.spawn RPC definition. */
interface SpawnTerminalPayload {
  readonly autoRun?: boolean | undefined
  readonly command?: string | undefined
  readonly workspaceId: string
}

/** Response shape matching the terminal.spawn RPC's TerminalResponse. */
interface SpawnTerminalResponse {
  readonly command: string
  readonly id: string
  readonly status: 'running' | 'stopped'
  readonly workspaceId: string
}

/**
 * Hook that returns an independent terminal spawn function.
 *
 * Each call creates its own Effect fiber via `Runtime.runPromise`,
 * bypassing the `AtomResultFn` mutation atom's "latest-wins"
 * behaviour. Multiple concurrent calls will all complete
 * independently — no interruption.
 *
 * Internally reads the `LaborerClient.runtime` atom to obtain the
 * Effect `Runtime` that provides the RPC client layer. The runtime
 * atom is mounted once and stays alive for the component's lifetime.
 *
 * @returns A stable callback `(args: { payload }) => Promise<SpawnTerminalResponse>`
 */
export function useSpawnTerminal(): (args: {
  payload: SpawnTerminalPayload
}) => Promise<SpawnTerminalResponse> {
  // Mount the runtime atom so it stays alive across renders.
  useAtomMount(LaborerClient.runtime)

  // Read the runtime result reactively.
  const runtimeResult = useAtomValue(LaborerClient.runtime)

  return useCallback(
    (args: { payload: SpawnTerminalPayload }) => {
      if (runtimeResult._tag !== 'Success') {
        return Promise.reject(
          new Error(
            `LaborerClient runtime not ready (state: ${runtimeResult._tag})`
          )
        )
      }

      const rt = runtimeResult.value

      // Each call runs as an independent fiber — no shared arg atom,
      // no "latest-wins" interruption.
      return Runtime.runPromise(rt)(
        Effect.gen(function* () {
          const client = yield* LaborerClient
          return yield* client('terminal.spawn', args.payload)
        })
      ) as Promise<SpawnTerminalResponse>
    },
    [runtimeResult]
  )
}
