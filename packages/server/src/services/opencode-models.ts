/**
 * Which models the operator can actually pick.
 *
 * `opencode2 models` answers with exactly the `provider/model` pairs the
 * machine has credentials for, which is a better list than anything this
 * repository could hardcode: it follows the operator's `opencode auth` state
 * rather than drifting behind it, and it can never offer a model that would
 * fail the moment it was used.
 *
 * The answer is cached briefly because opening settings should not shell out
 * every render, and a model list does not change between two clicks.
 *
 * @see apps/web/src/components/source-control-writing-settings.tsx — the picker
 */

import { RpcError } from '@laborer/shared/rpc'
import { Context, Effect, Layer, Ref } from 'effect'
import { spawn } from '../lib/spawn.js'

/** Long enough that opening settings twice costs one process, short enough
 * that authenticating a new provider shows up without a restart. */
const CACHE_TTL_MS = 60_000

/** Listing models is a local read; anything slower than this is a hang. */
const LIST_TIMEOUT_MS = 10_000

const LINE_SPLIT_RE = /\r?\n/u
/** `provider/model`, with the slashes some model ids carry in their tail. */
const MODEL_ID_RE = /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/u

interface CachedModels {
  readonly models: readonly string[]
  readonly readAt: number
}

const runModelsCommand = async (signal: AbortSignal): Promise<string> => {
  const child = spawn(['opencode2', 'models'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const abort = () => {
    child.kill('SIGTERM')
  }
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, LIST_TIMEOUT_MS)

  try {
    const exitCode = await child.exited
    const stdout = await new Response(child.stdout).text()
    if (exitCode !== 0) {
      const stderr = await new Response(child.stderr).text()
      throw new Error(stderr.trim() || `opencode2 models exited ${exitCode}`)
    }
    return stdout
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Keep the lines that name a model.
 *
 * The command prints one id per line, but a background service that is warming
 * up can prefix the list with progress chatter, so anything not shaped like a
 * model id is dropped rather than offered as one.
 */
const parseModelList = (stdout: string): readonly string[] => {
  const seen = new Set<string>()
  for (const line of stdout.split(LINE_SPLIT_RE)) {
    const candidate = line.trim()
    if (MODEL_ID_RE.test(candidate)) {
      seen.add(candidate)
    }
  }
  return [...seen].sort()
}

class OpenCodeModels extends Context.Service<
  OpenCodeModels,
  {
    readonly list: () => Effect.Effect<readonly string[], RpcError>
  }
>()('@laborer/OpenCodeModels') {
  static readonly layer = Layer.effect(
    OpenCodeModels,
    Effect.gen(function* () {
      const cache = yield* Ref.make<CachedModels | null>(null)

      const list = Effect.fn('OpenCodeModels.list')(function* () {
        const cached = yield* Ref.get(cache)
        const now = Date.now()
        if (cached !== null && now - cached.readAt < CACHE_TTL_MS) {
          return cached.models
        }

        const stdout = yield* Effect.tryPromise({
          try: (signal) => runModelsCommand(signal),
          catch: (error) =>
            new RpcError({
              code: 'OPENCODE_MODELS_FAILED',
              message: `Could not list OpenCode models: ${error instanceof Error ? error.message : String(error)}`,
            }),
        })

        const models = parseModelList(stdout)
        yield* Ref.set(cache, { models, readAt: now })
        return models
      })

      return OpenCodeModels.of({ list })
    })
  )
}

export { OpenCodeModels, parseModelList }
