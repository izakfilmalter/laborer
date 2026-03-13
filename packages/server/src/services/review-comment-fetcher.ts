/**
 * ReviewCommentFetcher — Server service for fetching PR comments from GitHub.
 *
 * Uses the `gh api` CLI to fetch both issue comments and inline review comments
 * for a workspace's pull request. Returns raw comment data including author info,
 * body, file/line references, and reactions.
 *
 * Owner/repo detection reuses the same regex patterns as GithubTaskImporter
 * (parsing from `git remote get-url origin`).
 *
 * @see PRD-review-findings-panel.md — "PR Comment Fetcher" section
 */

import type { PrComment as PrCommentType } from '@laborer/shared/rpc'
import { RpcError } from '@laborer/shared/rpc'
import { tables } from '@laborer/shared/schema'
import { Array as Arr, Context, Effect, Layer, pipe } from 'effect'
import { spawn } from '../lib/spawn.js'
import { parseGithubRepo } from './github-task-importer.js'
import { LaborerStore } from './laborer-store.js'

/** Regex for splitting paginated JSON arrays from gh --paginate output */
const GH_PAGINATE_SPLIT_REGEX = /\]\s*\[/

// ---------------------------------------------------------------------------
// GitHub API response shapes (raw JSON from `gh api`)
// ---------------------------------------------------------------------------

interface GhReaction {
  readonly content: string
  readonly id: number
  readonly user: {
    readonly id: number
  }
}

interface GhUser {
  readonly avatar_url: string
  readonly login: string
}

interface GhIssueComment {
  readonly body: string
  readonly created_at: string
  readonly id: number
  readonly reactions?: {
    readonly url?: string
  }
  readonly user: GhUser
}

interface GhReviewComment {
  readonly body: string
  readonly created_at: string
  readonly id: number
  readonly line: number | null
  readonly original_line: number | null
  readonly path: string
  readonly reactions?: {
    readonly url?: string
  }
  readonly user: GhUser
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect owner/repo from the git remote of a workspace's worktree.
 */
const detectOwnerRepo = Effect.fn('ReviewCommentFetcher.detectOwnerRepo')(
  function* (worktreePath: string) {
    const { exitCode, stdout, stderr } = yield* Effect.tryPromise({
      try: async () => {
        const proc = spawn(['git', 'config', '--get', 'remote.origin.url'], {
          cwd: worktreePath,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const exitCode = await proc.exited
        const stdout = await new Response(proc.stdout).text()
        const stderr = await new Response(proc.stderr).text()
        return { exitCode, stdout, stderr }
      },
      catch: (error) =>
        new RpcError({
          message: `Failed to read git remote: ${String(error)}`,
          code: 'GIT_REMOTE_FAILED',
        }),
    })

    if (exitCode !== 0) {
      return yield* new RpcError({
        message: `Could not read git remote.origin.url: ${stderr.trim()}`,
        code: 'GIT_REMOTE_FAILED',
      })
    }

    const repoInfo = parseGithubRepo(stdout.trim())
    if (!repoInfo) {
      return yield* new RpcError({
        message: `Remote URL is not a GitHub repository: ${stdout.trim()}`,
        code: 'NOT_GITHUB_REPO',
      })
    }

    return repoInfo
  }
)

/**
 * Run a `gh api` command and return the parsed JSON output.
 */
const ghApi = Effect.fn('ReviewCommentFetcher.ghApi')(function* <T>(
  endpoint: string,
  worktreePath: string
) {
  const { exitCode, stdout, stderr } = yield* Effect.tryPromise({
    try: async () => {
      const proc = spawn(['gh', 'api', endpoint, '--paginate'], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      return { exitCode, stdout, stderr }
    },
    catch: (error) =>
      new RpcError({
        message: `Failed to run gh api: ${String(error)}. Ensure the GitHub CLI (gh) is installed and authenticated. Run 'gh auth login' if needed.`,
        code: 'GH_COMMAND_FAILED',
      }),
  })

  if (exitCode !== 0) {
    const stderrText = stderr.trim()
    if (stderrText.includes('auth') || stderrText.includes('login')) {
      return yield* new RpcError({
        message: `GitHub CLI authentication failed. Run 'gh auth login' to authenticate.\n${stderrText}`,
        code: 'GH_AUTH_FAILED',
      })
    }
    if (stderrText.includes('rate limit')) {
      return yield* new RpcError({
        message: `GitHub API rate limit exceeded. Wait a few minutes and try again.\n${stderrText}`,
        code: 'GH_RATE_LIMITED',
      })
    }
    return yield* new RpcError({
      message: `gh api ${endpoint} failed (exit code ${exitCode}): ${stderrText}`,
      code: 'GH_API_FAILED',
    })
  }

  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return [] as T
  }

  // gh --paginate may concatenate multiple JSON arrays, e.g. [a,b][c,d]
  // We need to handle this by parsing as JSON and flattening if needed.
  return yield* Effect.try({
    try: () => {
      // Try direct parse first (single array)
      return JSON.parse(trimmed) as T
    },
    catch: () => {
      // gh --paginate sometimes emits multiple JSON arrays back-to-back
      // e.g. "[{...},{...}][{...}]"
      // Split on "][" and parse each chunk
      const chunks = trimmed.split(GH_PAGINATE_SPLIT_REGEX)
      const results: unknown[] = []
      for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i] ?? ''
        if (i > 0) {
          chunk = `[${chunk}`
        }
        if (i < chunks.length - 1) {
          chunk = `${chunk}]`
        }
        const parsed = JSON.parse(chunk)
        if (globalThis.Array.isArray(parsed)) {
          results.push(...parsed)
        } else {
          results.push(parsed)
        }
      }
      return results as T
    },
  }).pipe(
    Effect.mapError(
      () =>
        new RpcError({
          message: `Failed to parse gh api response for ${endpoint}`,
          code: 'GH_API_PARSE_FAILED',
        })
    )
  )
})

/**
 * Fetch reactions for a specific comment via `gh api`.
 */
const fetchReactions = Effect.fn('ReviewCommentFetcher.fetchReactions')(
  function* (
    owner: string,
    repo: string,
    commentId: number,
    commentType: 'issue' | 'review',
    worktreePath: string
  ) {
    const endpoint =
      commentType === 'issue'
        ? `repos/${owner}/${repo}/issues/comments/${commentId}/reactions`
        : `repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`

    const reactions = yield* ghApi<GhReaction[]>(endpoint, worktreePath).pipe(
      Effect.catchAll(() => Effect.succeed([] as GhReaction[]))
    )

    return pipe(
      reactions,
      Arr.map((r) => ({
        id: r.id,
        content: r.content,
        userId: r.user.id,
      }))
    )
  }
)

// ---------------------------------------------------------------------------
// Service definition
// ---------------------------------------------------------------------------

interface ReviewFetchCommentsResult {
  readonly comments: readonly PrCommentType[]
}

class ReviewCommentFetcher extends Context.Tag('@laborer/ReviewCommentFetcher')<
  ReviewCommentFetcher,
  {
    readonly fetchComments: (
      workspaceId: string
    ) => Effect.Effect<ReviewFetchCommentsResult, RpcError>
  }
>() {
  static readonly layer = Layer.effect(
    ReviewCommentFetcher,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore

      const fetchComments = Effect.fn('ReviewCommentFetcher.fetchComments')(
        function* (workspaceId: string) {
          // 1. Resolve workspace
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            return yield* new RpcError({
              message: `Workspace not found: ${workspaceId}`,
              code: 'NOT_FOUND',
            })
          }

          const workspace = workspaceOpt.value
          const worktreePath = workspace.worktreePath

          // 2. Detect PR number
          const prNumber =
            typeof workspace.prNumber === 'number' && workspace.prNumber > 0
              ? workspace.prNumber
              : yield* detectPrNumber(worktreePath)

          // 3. Detect owner/repo from git remote
          const { owner, repo } = yield* detectOwnerRepo(worktreePath)

          // 4. Fetch issue comments and inline review comments in parallel
          const [issueComments, reviewComments] = yield* Effect.all(
            [
              ghApi<GhIssueComment[]>(
                `repos/${owner}/${repo}/issues/${prNumber}/comments`,
                worktreePath
              ),
              ghApi<GhReviewComment[]>(
                `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
                worktreePath
              ),
            ],
            { concurrency: 2 }
          )

          // 5. Fetch reactions for all comments in parallel
          const allCommentMetas = [
            ...pipe(
              issueComments,
              Arr.map((c) => ({ id: c.id, type: 'issue' as const }))
            ),
            ...pipe(
              reviewComments,
              Arr.map((c) => ({ id: c.id, type: 'review' as const }))
            ),
          ]

          const allReactions = yield* Effect.forEach(
            allCommentMetas,
            (meta) =>
              fetchReactions(
                owner,
                repo,
                meta.id,
                meta.type,
                worktreePath
              ).pipe(Effect.map((reactions) => [meta.id, reactions] as const)),
            { concurrency: 5 }
          )

          const reactionsMap = new Map(allReactions)

          // 6. Map issue comments to PrComment shape
          const mappedIssueComments: PrCommentType[] = pipe(
            issueComments,
            Arr.map((c) => ({
              id: c.id,
              commentType: 'issue' as const,
              authorLogin: c.user.login,
              authorAvatarUrl: c.user.avatar_url,
              body: c.body,
              filePath: null,
              line: null,
              createdAt: c.created_at,
              reactions: reactionsMap.get(c.id) ?? [],
            }))
          )

          // 7. Map review comments to PrComment shape
          const mappedReviewComments: PrCommentType[] = pipe(
            reviewComments,
            Arr.map((c) => ({
              id: c.id,
              commentType: 'review' as const,
              authorLogin: c.user.login,
              authorAvatarUrl: c.user.avatar_url,
              body: c.body,
              filePath: c.path,
              line: c.line ?? c.original_line ?? null,
              createdAt: c.created_at,
              reactions: reactionsMap.get(c.id) ?? [],
            }))
          )

          return {
            comments: [...mappedIssueComments, ...mappedReviewComments],
          }
        }
      )

      return ReviewCommentFetcher.of({
        fetchComments,
      })
    })
  )
}

/**
 * Detect PR number from the workspace's worktree using `gh pr view`.
 */
const detectPrNumber = Effect.fn('ReviewCommentFetcher.detectPrNumber')(
  function* (worktreePath: string) {
    const { exitCode, stdout, stderr } = yield* Effect.tryPromise({
      try: async () => {
        const proc = spawn(['gh', 'pr', 'view', '--json', 'number'], {
          cwd: worktreePath,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const exitCode = await proc.exited
        const stdout = await new Response(proc.stdout).text()
        const stderr = await new Response(proc.stderr).text()
        return { exitCode, stdout, stderr }
      },
      catch: (error) =>
        new RpcError({
          message: `Failed to run gh pr view: ${String(error)}`,
          code: 'GH_COMMAND_FAILED',
        }),
    })

    if (exitCode !== 0) {
      return yield* new RpcError({
        message: `No pull request found for this branch. Push the branch and open a PR first.\n${stderr.trim()}`,
        code: 'PR_NOT_FOUND',
      })
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(stdout.trim()) as { number?: number },
      catch: () =>
        new RpcError({
          message: `Could not parse PR number from gh output: ${stdout.trim()}`,
          code: 'PR_NOT_FOUND',
        }),
    })

    if (typeof parsed.number !== 'number' || parsed.number <= 0) {
      return yield* new RpcError({
        message: `Could not parse PR number from gh output: ${stdout.trim()}`,
        code: 'PR_NOT_FOUND',
      })
    }

    return parsed.number
  }
)

export { ReviewCommentFetcher }
