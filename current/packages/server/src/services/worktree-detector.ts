import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { RpcError } from '@laborer/shared/rpc'
import { Context, Effect, Layer } from 'effect'
import { withFsmonitorDisabled } from './repo-watching-git.js'

export interface DetectedWorktree {
  readonly branch: string | null
  readonly head: string
  readonly isMain: boolean
  readonly path: string
}

interface ParsedWorktreeBlock {
  readonly branch: string | null
  readonly head: string
  readonly path: string
  readonly prunable: boolean
}

const normalizePath = (value: string): string => {
  try {
    return realpathSync(value)
  } catch {
    return value
  }
}

const toBranchName = (ref: string | null): string | null => {
  if (ref === null) {
    return null
  }
  const refsPrefix = 'refs/heads/'
  return ref.startsWith(refsPrefix) ? ref.slice(refsPrefix.length) : ref
}

const parsePorcelainOutput = (
  output: string
): readonly ParsedWorktreeBlock[] => {
  const blocks = output
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0)

  const parsed: ParsedWorktreeBlock[] = []

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    let path: string | null = null
    let head = ''
    let branch: string | null = null
    let prunable = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
        continue
      }
      if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
        continue
      }
      if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length)
        continue
      }
      if (line.startsWith('prunable')) {
        prunable = true
      }
    }

    if (path !== null) {
      parsed.push({
        path,
        head,
        branch: toBranchName(branch),
        prunable,
      })
    }
  }

  return parsed
}

const runGit = (
  args: readonly string[],
  cwd: string
): Effect.Effect<
  {
    readonly exitCode: number
    readonly stderr: string
    readonly stdout: string
  },
  RpcError
> =>
  Effect.tryPromise({
    try: () =>
      new Promise<{
        readonly exitCode: number
        readonly stderr: string
        readonly stdout: string
      }>((resolve) => {
        execFile(
          'git',
          withFsmonitorDisabled(args),
          { cwd },
          (error, stdout, stderr) => {
            if (error) {
              const code =
                typeof error.code === 'number' ? error.code : Number(error.code)
              resolve({
                exitCode: Number.isFinite(code) ? code : 1,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
              })
              return
            }

            resolve({
              exitCode: 0,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
            })
          }
        )
      }),
    catch: (error) =>
      new RpcError({
        message: `Failed to run git ${args.join(' ')}: ${String(error)}`,
        code: 'WORKTREE_DETECT_FAILED',
      }),
  })

class WorktreeDetector extends Context.Tag('@laborer/WorktreeDetector')<
  WorktreeDetector,
  {
    readonly detect: (
      repoPath: string
    ) => Effect.Effect<readonly DetectedWorktree[], RpcError>
  }
>() {
  static readonly layer = Layer.effect(
    WorktreeDetector,
    Effect.gen(function* () {
      const detect = Effect.fn('WorktreeDetector.detect')(function* (
        repoPath: string
      ) {
        const worktreeResult = yield* runGit(
          ['worktree', 'list', '--porcelain'],
          repoPath
        )

        if (worktreeResult.exitCode !== 0) {
          return yield* new RpcError({
            message: `git worktree list failed (exit ${worktreeResult.exitCode}): ${worktreeResult.stderr.trim()}`,
            code: 'WORKTREE_DETECT_FAILED',
          })
        }

        const rootResult = yield* runGit(
          ['rev-parse', '--show-toplevel'],
          repoPath
        )

        const mainWorktreePath =
          rootResult.exitCode === 0
            ? normalizePath(rootResult.stdout.trim())
            : null

        return parsePorcelainOutput(worktreeResult.stdout)
          .filter((block) => !block.prunable)
          .map((block) => {
            const normalized = normalizePath(block.path)
            return {
              path: normalized,
              head: block.head,
              branch: block.branch,
              isMain:
                mainWorktreePath !== null && normalized === mainWorktreePath,
            } satisfies DetectedWorktree
          })
      })

      return WorktreeDetector.of({ detect })
    })
  )
}

export { parsePorcelainOutput, WorktreeDetector }
