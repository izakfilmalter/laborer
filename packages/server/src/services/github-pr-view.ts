import { Effect } from 'effect'
import type { SpawnResult } from '../lib/spawn.js'
import { spawn } from '../lib/spawn.js'

const GITHUB_HTTPS_REMOTE_REGEX =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
const GITHUB_SSH_REMOTE_REGEX = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/
const GITHUB_PULL_REQUEST_URL_REGEX =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/

/** Parse a GitHub owner and repository from a supported origin URL. */
const parseGithubRepo = (
  remoteUrl: string
): { readonly owner: string; readonly repo: string } | null => {
  const trimmedRemoteUrl = remoteUrl.trim()
  const httpsMatch = trimmedRemoteUrl.match(GITHUB_HTTPS_REMOTE_REGEX)
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] }
  }

  const sshMatch = trimmedRemoteUrl.match(GITHUB_SSH_REMOTE_REGEX)
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] }
  }

  return null
}

/**
 * The `owner/repo` a pull request actually lives in, read from its own URL.
 *
 * The origin remote is the wrong answer for a fork: `gh pr view` falls back
 * to the parent repository when origin has no pull request, so a follow-up
 * request built from `remote.origin.url` would ask the fork about a number
 * that only exists upstream. The URL GitHub returned alongside the number is
 * the one repository both are guaranteed to agree on.
 */
const parsePullRequestRepoSlug = (pullRequestUrl: string): string | null => {
  const match = pullRequestUrl.trim().match(GITHUB_PULL_REQUEST_URL_REGEX)
  if (match?.[1] && match[2]) {
    return `${match[1]}/${match[2]}`
  }

  return null
}

interface GhPrViewResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

/**
 * Kill a child that outlived the fiber that wanted it.
 *
 * Reaping a process that already exited is not an error worth propagating —
 * the point of the finalizer is that nothing is left running, and a process
 * that ended on its own already satisfies that.
 */
const killQuietly = (spawned: SpawnResult) =>
  Effect.ignore(Effect.try(() => spawned.kill()))

/**
 * Run a `gh` command in a worktree, holding the child process in a scope.
 *
 * Awaiting `proc.exited` inside a promise means an interrupted fiber walks
 * away from a process that keeps running and keeps writing to a pipe nobody
 * reads. Callers here are interruptible in ordinary use — `PrWatcher` polls
 * on a schedule that can be shut down mid-flight — so the child is acquired
 * in a scope and signalled when that scope closes.
 */
const runGhPrViewCommand = <E>(
  args: readonly string[],
  worktreePath: string,
  onError: (error: unknown) => E
): Effect.Effect<GhPrViewResult, E> =>
  Effect.gen(function* () {
    const proc = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn([...args], {
            cwd: worktreePath,
            stdout: 'pipe',
            stderr: 'pipe',
          }),
        catch: onError,
      }),
      killQuietly
    )

    return yield* Effect.tryPromise({
      try: async () => {
        const exitCode = await proc.exited
        const stdout = await new Response(proc.stdout).text()
        const stderr = await new Response(proc.stderr).text()

        return { exitCode, stdout, stderr }
      },
      catch: onError,
    })
  }).pipe(Effect.scoped)

const resolveOriginRepoSlug = Effect.fn('GithubPrView.resolveOriginRepoSlug')(
  function* (worktreePath: string) {
    // Scoped for the same reason as `gh` above: a worktree with no origin is
    // an ordinary answer, but a `git` left running after an interrupt is not.
    const remoteUrl = yield* Effect.gen(function* () {
      const proc = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(['git', 'config', '--get', 'remote.origin.url'], {
              cwd: worktreePath,
              stdout: 'pipe',
              stderr: 'pipe',
            }),
          catch: () => null,
        }),
        killQuietly
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
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => null)
    )

    if (remoteUrl === null) {
      return null
    }

    const repoInfo = parseGithubRepo(remoteUrl)
    if (repoInfo === null) {
      return null
    }

    return `${repoInfo.owner}/${repoInfo.repo}`
  }
)

const runGhPrViewWithOriginFallback = <E>(
  worktreePath: string,
  branchName: string,
  jsonFields: string,
  onError: (error: unknown) => E
): Effect.Effect<GhPrViewResult, E> =>
  Effect.gen(function* () {
    const originRepoSlug = yield* resolveOriginRepoSlug(worktreePath)

    if (originRepoSlug !== null) {
      const originResult = yield* runGhPrViewCommand(
        [
          'gh',
          'pr',
          'view',
          branchName,
          '--json',
          jsonFields,
          '--repo',
          originRepoSlug,
        ],
        worktreePath,
        onError
      )

      if (originResult.exitCode === 0) {
        return originResult
      }
    }

    return yield* runGhPrViewCommand(
      ['gh', 'pr', 'view', branchName, '--json', jsonFields],
      worktreePath,
      onError
    )
  })

export {
  parseGithubRepo,
  parsePullRequestRepoSlug,
  resolveOriginRepoSlug,
  runGhPrViewWithOriginFallback,
}
export type { GhPrViewResult }
