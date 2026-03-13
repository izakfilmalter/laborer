import { rmSync } from 'node:fs'
import { assert, describe, it } from '@effect/vitest'
import { events } from '@laborer/shared/schema'
import { Cause, Effect, Exit, Layer } from 'effect'
import { afterEach, vi } from 'vitest'
import type { SpawnResult } from '../src/lib/spawn.js'
import { spawn } from '../src/lib/spawn.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { ReviewCommentFetcher } from '../src/services/review-comment-fetcher.js'
import { createTempDir, git } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'

vi.mock('../src/lib/spawn.js', () => ({
  spawn: vi.fn(),
}))

const spawnMock = vi.mocked(spawn)

const TestLayer = ReviewCommentFetcher.layer.pipe(
  Layer.provideMerge(TestLaborerStore)
)

/**
 * Helper to create a temp git repo with a GitHub remote and seed the store
 * with a project + workspace pointing at it.
 */
const setupWorkspace = (
  remoteUrl: string,
  tempRoots: string[],
  store: LaborerStore['Type']['store'],
  opts?: { prNumber?: number }
): string => {
  const repoPath = createTempDir('laborer-review-fetcher')
  tempRoots.push(repoPath)
  git('init', repoPath)
  git(`remote add origin ${remoteUrl}`, repoPath)

  store.commit(
    events.projectCreated({
      id: 'project-1',
      repoPath,
      name: 'test-repo',
      brrrConfig: null,
    })
  )
  store.commit(
    events.workspaceCreated({
      id: 'workspace-1',
      projectId: 'project-1',
      branchName: 'feature/test',
      worktreePath: repoPath,
      port: 4000,
      status: 'running',
      taskSource: null,
      origin: 'laborer',
      createdAt: new Date().toISOString(),
      baseSha: null,
    })
  )

  if (opts?.prNumber) {
    store.commit(
      events.workspacePrUpdated({
        id: 'workspace-1',
        prNumber: opts.prNumber,
        prUrl: `https://github.com/acme/laborer/pull/${opts.prNumber}`,
        prTitle: 'Test PR',
        prState: 'open',
      })
    )
  }

  return repoPath
}

/**
 * Create a mock spawn function that intercepts specific commands
 * and returns canned output.
 */
const createSpawnMock = (
  handlers: Record<
    string,
    { stdout: string; stderr?: string; exitCode?: number }
  >
): typeof spawn => {
  return ((cmd: string[]) => {
    const cmdString = cmd.join(' ')

    for (const [pattern, response] of Object.entries(handlers)) {
      if (cmdString.includes(pattern)) {
        const stdout = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(response.stdout))
            controller.close()
          },
        })
        const stderr = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(response.stderr ?? ''))
            controller.close()
          },
        })
        return {
          exited: Promise.resolve(response.exitCode ?? 0),
          stdout,
          stderr,
          kill: () => true,
          pid: 1234,
        } satisfies SpawnResult
      }
    }

    // Default: command not found
    const emptyStdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const errorStderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`unknown command: ${cmdString}`)
        )
        controller.close()
      },
    })
    return {
      exited: Promise.resolve(1),
      stdout: emptyStdout,
      stderr: errorStderr,
      kill: () => true,
      pid: 1234,
    } satisfies SpawnResult
  }) as typeof spawn
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReviewCommentFetcher.fetchComments', () => {
  it.scoped(
    'fetches issue comments and inline review comments for a workspace PR',
    () =>
      Effect.gen(function* () {
        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const root of tempRoots) {
              rmSync(root, { force: true, recursive: true })
            }
          })
        )

        const { store } = yield* LaborerStore
        setupWorkspace('git@github.com:acme/laborer.git', tempRoots, store, {
          prNumber: 42,
        })

        const issueComments = [
          {
            id: 1001,
            user: {
              login: 'bot-user',
              avatar_url: 'https://example.com/bot.png',
            },
            body: 'This is a summary comment',
            created_at: '2025-01-15T10:00:00Z',
          },
        ]

        const reviewComments = [
          {
            id: 2001,
            user: {
              login: 'reviewer',
              avatar_url: 'https://example.com/reviewer.png',
            },
            body: 'Please fix this null check',
            path: 'src/index.ts',
            line: 42,
            original_line: 42,
            created_at: '2025-01-15T11:00:00Z',
          },
        ]

        const reactions1001 = [
          { id: 5001, content: 'rocket', user: { id: 100 } },
        ]

        const reactions2001 = [
          { id: 5002, content: '+1', user: { id: 101 } },
          { id: 5003, content: 'confused', user: { id: 102 } },
        ]

        spawnMock.mockImplementation(
          createSpawnMock({
            'remote.origin.url': {
              stdout: 'git@github.com:acme/laborer.git',
            },
            'issues/42/comments': {
              stdout: JSON.stringify(issueComments),
            },
            'pulls/42/comments --paginate': {
              stdout: JSON.stringify(reviewComments),
            },
            'issues/comments/1001/reactions': {
              stdout: JSON.stringify(reactions1001),
            },
            'pulls/comments/2001/reactions': {
              stdout: JSON.stringify(reactions2001),
            },
          })
        )

        const fetcher = yield* ReviewCommentFetcher
        const result = yield* fetcher.fetchComments('workspace-1')

        // Should have 2 comments total (1 issue + 1 review)
        assert.strictEqual(result.comments.length, 2)

        // Validate issue comment
        const issueComment = result.comments.find((c) => c.id === 1001)
        assert.isDefined(issueComment)
        if (issueComment) {
          assert.strictEqual(issueComment.commentType, 'issue')
          assert.strictEqual(issueComment.authorLogin, 'bot-user')
          assert.strictEqual(
            issueComment.authorAvatarUrl,
            'https://example.com/bot.png'
          )
          assert.strictEqual(issueComment.body, 'This is a summary comment')
          assert.isNull(issueComment.filePath)
          assert.isNull(issueComment.line)
          assert.strictEqual(issueComment.createdAt, '2025-01-15T10:00:00Z')
          assert.strictEqual(issueComment.reactions.length, 1)
          assert.strictEqual(issueComment.reactions[0]?.content, 'rocket')
        }

        // Validate review comment
        const reviewComment = result.comments.find((c) => c.id === 2001)
        assert.isDefined(reviewComment)
        if (reviewComment) {
          assert.strictEqual(reviewComment.commentType, 'review')
          assert.strictEqual(reviewComment.authorLogin, 'reviewer')
          assert.strictEqual(reviewComment.body, 'Please fix this null check')
          assert.strictEqual(reviewComment.filePath, 'src/index.ts')
          assert.strictEqual(reviewComment.line, 42)
          assert.strictEqual(reviewComment.reactions.length, 2)
        }
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('parses owner/repo from SSH remote URL', () =>
    Effect.gen(function* () {
      const tempRoots: string[] = []
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const root of tempRoots) {
            rmSync(root, { force: true, recursive: true })
          }
        })
      )

      const { store } = yield* LaborerStore
      setupWorkspace('git@github.com:my-org/my-repo.git', tempRoots, store, {
        prNumber: 10,
      })

      spawnMock.mockImplementation(
        createSpawnMock({
          'remote.origin.url': {
            stdout: 'git@github.com:my-org/my-repo.git',
          },
          'my-org/my-repo/issues/10/comments': {
            stdout: '[]',
          },
          'my-org/my-repo/pulls/10/comments --paginate': {
            stdout: '[]',
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchComments('workspace-1')

      assert.strictEqual(result.comments.length, 0)

      // Verify the correct owner/repo was used in the API call
      const calls = spawnMock.mock.calls
      const apiCall = calls.find((c) =>
        (c[0] as string[]).some((arg: string) => arg.includes('my-org/my-repo'))
      )
      assert.isDefined(apiCall)
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('parses owner/repo from HTTPS remote URL', () =>
    Effect.gen(function* () {
      const tempRoots: string[] = []
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const root of tempRoots) {
            rmSync(root, { force: true, recursive: true })
          }
        })
      )

      const { store } = yield* LaborerStore
      setupWorkspace(
        'https://github.com/my-org/my-repo.git',
        tempRoots,
        store,
        { prNumber: 10 }
      )

      spawnMock.mockImplementation(
        createSpawnMock({
          'remote.origin.url': {
            stdout: 'https://github.com/my-org/my-repo.git',
          },
          'my-org/my-repo/issues/10/comments': {
            stdout: '[]',
          },
          'my-org/my-repo/pulls/10/comments --paginate': {
            stdout: '[]',
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchComments('workspace-1')

      assert.strictEqual(result.comments.length, 0)
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped(
    'returns PR_NOT_FOUND when no PR exists and prNumber is not cached',
    () =>
      Effect.gen(function* () {
        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const root of tempRoots) {
              rmSync(root, { force: true, recursive: true })
            }
          })
        )

        const { store } = yield* LaborerStore
        // No prNumber cached — forces fallback to gh pr view
        setupWorkspace('git@github.com:acme/laborer.git', tempRoots, store)

        spawnMock.mockImplementation(
          createSpawnMock({
            'gh pr view': {
              stdout: '',
              stderr: 'no pull requests found',
              exitCode: 1,
            },
          })
        )

        const fetcher = yield* ReviewCommentFetcher
        const exit = yield* Effect.exit(fetcher.fetchComments('workspace-1'))
        assert.isTrue(Exit.isFailure(exit))
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          assert.isTrue(
            String(error instanceof Error ? error.message : error).includes(
              'No pull request found'
            )
          )
        }
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('returns NOT_FOUND when workspace does not exist', () =>
    Effect.gen(function* () {
      const fetcher = yield* ReviewCommentFetcher
      const exit = yield* Effect.exit(
        fetcher.fetchComments('nonexistent-workspace')
      )
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        assert.isTrue(
          String(error instanceof Error ? error.message : error).includes(
            'Workspace not found'
          )
        )
      }
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('handles gh auth failure with actionable error message', () =>
    Effect.gen(function* () {
      const tempRoots: string[] = []
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const root of tempRoots) {
            rmSync(root, { force: true, recursive: true })
          }
        })
      )

      const { store } = yield* LaborerStore
      setupWorkspace('git@github.com:acme/laborer.git', tempRoots, store, {
        prNumber: 42,
      })

      spawnMock.mockImplementation(
        createSpawnMock({
          'remote.origin.url': {
            stdout: 'git@github.com:acme/laborer.git',
          },
          'issues/42/comments': {
            stdout: '',
            stderr: 'gh: auth login required',
            exitCode: 1,
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const exit = yield* Effect.exit(fetcher.fetchComments('workspace-1'))
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        const errorMsg = String(error instanceof Error ? error.message : error)
        assert.isTrue(errorMsg.includes('auth'))
      }
    }).pipe(Effect.provide(TestLayer))
  )
})
