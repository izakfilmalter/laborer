/**
 * Who GitHub thinks this machine is.
 *
 * The sidebar groups a workspace under the login that opened its pull
 * request, but only when that login is somebody else. Answering "somebody
 * else" needs a name for "me", and the only authority on that is the `gh`
 * credential the rest of the server already reads pull requests with.
 *
 * The answer is cached because it is asked on every sidebar render and
 * changes roughly never — a login changes when the user re-authenticates as
 * a different account, which is rare enough to pay for with a restart.
 */

import { Context, Duration, Effect, Layer, Ref } from 'effect'
import { spawn } from '../lib/spawn.js'

/** How long a resolved login is trusted before `gh` is asked again. */
const VIEWER_LOGIN_TTL = Duration.minutes(30)

/**
 * How long a *failed* lookup is trusted. Much shorter than a success: a
 * failure usually means "not logged in yet" or "offline", both of which the
 * user can fix in the next minute and will expect to take effect.
 */
const VIEWER_LOGIN_FAILURE_TTL = Duration.minutes(1)

interface CachedLogin {
  readonly expiresAt: number
  readonly login: string | null
}

/**
 * Ask `gh` for the authenticated user's login.
 *
 * Every failure mode collapses to null. A missing `gh`, a logged-out `gh`,
 * and an offline machine are not distinguishable to the caller and would not
 * be acted on differently: all three mean no workspace can be attributed to
 * the current user, so none get hidden from the author grouping.
 */
const resolveViewerLogin = Effect.fn('GithubViewer.resolveViewerLogin')(
  function* () {
    const proc = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn(['gh', 'api', 'user', '--jq', '.login'], {
            stdout: 'pipe',
            stderr: 'ignore',
          }),
        catch: () => null,
      }),
      // Reaping a process that already exited is not a failure worth raising:
      // the finalizer only promises nothing is left running.
      (spawned) => Effect.ignore(Effect.try(() => spawned.kill()))
    )

    return yield* Effect.tryPromise({
      try: async () => {
        const exitCode = await proc.exited
        if (exitCode !== 0) {
          return null
        }
        const stdout = await new Response(proc.stdout).text()
        return stdout.trim() || null
      },
      catch: () => null,
    })
  },
  Effect.scoped
)

class GithubViewer extends Context.Service<
  GithubViewer,
  {
    /** The current user's GitHub login, or null when unauthenticated. */
    readonly login: Effect.Effect<string | null>
  }
>()('@laborer/GithubViewer') {
  static readonly layer = Layer.effect(
    GithubViewer,
    Effect.gen(function* () {
      const cache = yield* Ref.make<CachedLogin | null>(null)

      const login = Effect.gen(function* () {
        const now = Date.now()
        const cached = yield* Ref.get(cache)
        if (cached !== null && cached.expiresAt > now) {
          return cached.login
        }

        const resolved = yield* resolveViewerLogin().pipe(
          Effect.orElseSucceed(() => null)
        )
        const ttl =
          resolved === null ? VIEWER_LOGIN_FAILURE_TTL : VIEWER_LOGIN_TTL

        yield* Ref.set(cache, {
          expiresAt: now + Duration.toMillis(ttl),
          login: resolved,
        })

        return resolved
      })

      return { login }
    })
  )
}

export { GithubViewer }
