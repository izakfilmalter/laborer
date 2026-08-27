/**
 * The open pull requests a repository has, whether or not they are checked out
 * here.
 *
 * The sidebar gathers somebody else's branches under their login, but a branch
 * only appears there once it has been pulled in. That makes the group answer
 * "what have I already got from this person" when the question a reviewer
 * actually asks is "what have they got open". Listing the repository's open
 * pull requests supplies the other half: the ones with no worktree yet are
 * shown alongside the ones that have one, so the gap is visible and closable.
 *
 * `gh pr list` is asked against the project root rather than a worktree,
 * because the answer is a property of the repository and must not disappear
 * when the worktree that happened to be asked is destroyed.
 *
 * Results are cached briefly. The list is read on every sidebar render and on
 * a poll, and a pull request opened seconds ago is not worth a subprocess per
 * paint.
 */

import { Context, Duration, Effect, Layer, Ref, Schema } from 'effect'
import { spawn } from '../lib/spawn.js'

/** How long a listing is trusted before `gh` is asked again. */
const PULL_REQUEST_LIST_TTL = Duration.seconds(60)

/**
 * How long a *failed* listing is trusted. Shorter than a success: a failure is
 * usually "not logged in" or "offline", both of which the user can fix in the
 * next minute and will expect to take effect.
 */
const PULL_REQUEST_LIST_FAILURE_TTL = Duration.seconds(15)

/** How many open pull requests are read. Beyond this the sidebar is unusable anyway. */
const PULL_REQUEST_LIST_LIMIT = 100

/** One open pull request as the sidebar needs it. */
interface OpenPullRequest {
  /** The login that opened it, used to file it under an author heading. */
  readonly authorLogin: string
  /** The pull request body, shown as the card's description. */
  readonly body: string | null
  /** The head branch, which is what pulling it in checks out. */
  readonly branchName: string
  readonly isDraft: boolean
  readonly number: number
  readonly title: string
  readonly url: string
}

/**
 * What `gh pr list --json` promises, decoded rather than trusted.
 *
 * A missing author is possible for a pull request opened by a deleted account,
 * and an entry we cannot attribute cannot be filed under a heading, so it is
 * dropped rather than shown under a blank name.
 */
const GhPullRequest = Schema.Struct({
  author: Schema.optional(
    Schema.NullOr(Schema.Struct({ login: Schema.String }))
  ),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  headRefName: Schema.String,
  isDraft: Schema.Boolean,
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
})

const PULL_REQUEST_JSON_FIELDS =
  'number,title,url,body,headRefName,isDraft,author'

interface CachedList {
  readonly expiresAt: number
  readonly pullRequests: readonly OpenPullRequest[]
}

const decodeGhPullRequest = Schema.decodeUnknownOption(GhPullRequest)

/**
 * Read what `gh pr list --json` printed.
 *
 * Anything unreadable is an empty list rather than a raised error: the caller
 * is a sidebar heading, and "GitHub told us nothing" and "GitHub told us
 * nonsense" leave it with the same thing to show.
 *
 * Entries are decoded one at a time so a single unreadable one costs only
 * itself. `gh` is one process reporting many pull requests, and losing the
 * whole listing to one surprising field would be a worse trade than showing
 * the rest.
 *
 * An entry with no author is dropped on the same grounds. The sidebar files a
 * pull request under the login that opened it, and one opened by a
 * since-deleted account cannot be filed anywhere — a blank heading would
 * invent a person.
 */
const toOpenPullRequests = (stdout: string): readonly OpenPullRequest[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed.flatMap((raw): readonly OpenPullRequest[] => {
    const decoded = decodeGhPullRequest(raw)
    if (decoded._tag === 'None') {
      return []
    }

    const entry = decoded.value
    const authorLogin = entry.author?.login
    if (authorLogin === undefined || authorLogin === '') {
      return []
    }
    return [
      {
        authorLogin,
        body: entry.body ?? null,
        branchName: entry.headRefName,
        isDraft: entry.isDraft,
        number: entry.number,
        title: entry.title,
        url: entry.url,
      },
    ]
  })
}

/**
 * Ask `gh` for the repository's open pull requests.
 *
 * Every failure mode collapses to an empty list. A missing `gh`, a logged-out
 * `gh`, a repository with no GitHub remote, and an offline machine are not
 * distinguishable to the caller and would not be acted on differently: all
 * four mean the sidebar knows about no pull requests beyond the ones already
 * checked out, which is exactly what it showed before this existed.
 */
const listOpenPullRequests = Effect.fn('GithubPullRequests.list')(function* (
  repoPath: string
) {
  const proc = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        spawn(
          [
            'gh',
            'pr',
            'list',
            '--state',
            'open',
            '--limit',
            String(PULL_REQUEST_LIST_LIMIT),
            '--json',
            PULL_REQUEST_JSON_FIELDS,
          ],
          { cwd: repoPath, stdout: 'pipe', stderr: 'ignore' }
        ),
      catch: () => null,
    }),
    // Reaping a process that already exited is not a failure worth raising:
    // the finalizer only promises nothing is left running.
    (spawned) => Effect.ignore(Effect.try(() => spawned.kill()))
  )

  const stdout = yield* Effect.tryPromise({
    try: async () => {
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        return null
      }
      return await new Response(proc.stdout).text()
    },
    catch: () => null,
  })

  if (stdout === null) {
    return []
  }

  return toOpenPullRequests(stdout)
}, Effect.scoped)

class GithubPullRequests extends Context.Service<
  GithubPullRequests,
  {
    /**
     * Open pull requests in the repository rooted at `repoPath`, or an empty
     * list when GitHub cannot be asked.
     */
    readonly list: (
      repoPath: string
    ) => Effect.Effect<readonly OpenPullRequest[]>
  }
>()('@laborer/GithubPullRequests') {
  static readonly layer = Layer.effect(
    GithubPullRequests,
    Effect.gen(function* () {
      const cache = yield* Ref.make(new Map<string, CachedList>())

      const list = (repoPath: string) =>
        Effect.gen(function* () {
          const now = Date.now()
          const cached = (yield* Ref.get(cache)).get(repoPath)
          if (cached !== undefined && cached.expiresAt > now) {
            return cached.pullRequests
          }

          const pullRequests = yield* listOpenPullRequests(repoPath).pipe(
            Effect.orElseSucceed((): readonly OpenPullRequest[] => [])
          )
          const ttl =
            pullRequests.length === 0
              ? PULL_REQUEST_LIST_FAILURE_TTL
              : PULL_REQUEST_LIST_TTL

          yield* Ref.update(cache, (entries) => {
            const next = new Map(entries)
            next.set(repoPath, {
              expiresAt: now + Duration.toMillis(ttl),
              pullRequests,
            })
            return next
          })

          return pullRequests
        })

      return { list }
    })
  )
}

export { GithubPullRequests, toOpenPullRequests }
export type { OpenPullRequest }
