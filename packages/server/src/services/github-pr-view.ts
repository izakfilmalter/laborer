import { Effect } from 'effect'
import { spawn } from '../lib/spawn.js'

const GITHUB_HTTPS_REMOTE_REGEX =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
const GITHUB_SSH_REMOTE_REGEX = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/

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

interface GhPrViewResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

const runGhPrViewCommand = <E>(
  args: readonly string[],
  worktreePath: string,
  onError: (error: unknown) => E
): Effect.Effect<GhPrViewResult, E> =>
  Effect.tryPromise({
    try: async () => {
      const proc = spawn([...args], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()

      return { exitCode, stdout, stderr }
    },
    catch: onError,
  })

const resolveOriginRepoSlug = Effect.fn('GithubPrView.resolveOriginRepoSlug')(
  function* (worktreePath: string) {
    const remoteUrl = yield* Effect.tryPromise({
      try: async () => {
        const proc = spawn(['git', 'config', '--get', 'remote.origin.url'], {
          cwd: worktreePath,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
          return null
        }

        const stdout = await new Response(proc.stdout).text()
        return stdout.trim() || null
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))

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

export { parseGithubRepo, runGhPrViewWithOriginFallback }
export type { GhPrViewResult }
