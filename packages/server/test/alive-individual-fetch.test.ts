/**
 * TDD tests for the individual fetch RPCs used by Alive event handling:
 * - fetchSingleIssueComment
 * - fetchSingleReviewComment (plain comment and brrr finding)
 * - fetchSingleReview
 *
 * These test through the ReviewCommentFetcher service interface, mocking
 * only the `spawn` system boundary (gh CLI calls).
 */

import { rmSync } from 'node:fs'
import { assert, describe, it } from '@effect/vitest'
import { events } from '@laborer/shared/schema'
import { Effect, Layer } from 'effect'
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

// ---------------------------------------------------------------------------
// Helpers (same pattern as review-comment-fetcher.test.ts)
// ---------------------------------------------------------------------------

const setupWorkspace = (
  remoteUrl: string,
  tempRoots: string[],
  store: LaborerStore['Type']['store'],
  opts?: { prNumber?: number }
): string => {
  const repoPath = createTempDir('laborer-alive-fetch')
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
        prUrl: `https://github.com/acme/repo/pull/${opts.prNumber}`,
        prTitle: 'Test PR',
        prState: 'open',
      })
    )
  }

  return repoPath
}

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

// =========================================================================
// fetchSingleIssueComment
// =========================================================================

describe('ReviewCommentFetcher.fetchSingleIssueComment', () => {
  it.scoped(
    'fetches a single issue comment with reactions and returns PrComment shape',
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
        setupWorkspace('git@github.com:acme/repo.git', tempRoots, store, {
          prNumber: 10,
        })

        const issueComment = {
          id: 3001,
          user: { login: 'alice', avatar_url: 'https://example.com/alice.png' },
          body: 'Looks good overall.',
          created_at: '2025-06-01T12:00:00Z',
        }

        const reactions = [{ id: 7001, content: '+1', user: { id: 200 } }]

        spawnMock.mockImplementation(
          createSpawnMock({
            'remote.origin.url': {
              stdout: 'git@github.com:acme/repo.git',
            },
            // Reactions must be listed before the comment endpoint so
            // the more specific pattern matches first.
            'issues/comments/3001/reactions': {
              stdout: JSON.stringify(reactions),
            },
            'issues/comments/3001 --paginate': {
              stdout: JSON.stringify(issueComment),
            },
          })
        )

        const fetcher = yield* ReviewCommentFetcher
        const result = yield* fetcher.fetchSingleIssueComment(
          'workspace-1',
          3001
        )

        assert.strictEqual(result.comment.id, 3001)
        assert.strictEqual(result.comment.commentType, 'issue')
        assert.strictEqual(result.comment.authorLogin, 'alice')
        assert.strictEqual(
          result.comment.authorAvatarUrl,
          'https://example.com/alice.png'
        )
        assert.strictEqual(result.comment.body, 'Looks good overall.')
        assert.strictEqual(result.comment.filePath, null)
        assert.strictEqual(result.comment.line, null)
        assert.strictEqual(result.comment.createdAt, '2025-06-01T12:00:00Z')
        assert.strictEqual(result.comment.reactions.length, 1)
        assert.strictEqual(result.comment.reactions[0]?.content, '+1')

        // No brrr-review marker → verdict is null
        assert.strictEqual(result.verdict, null)
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('extracts verdict when comment contains brrr-review marker', () =>
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
      setupWorkspace('git@github.com:acme/repo.git', tempRoots, store, {
        prNumber: 10,
      })

      const brrrComment = {
        id: 3002,
        user: {
          login: 'brrr-bot',
          avatar_url: 'https://example.com/bot.png',
        },
        body: '<!-- brrr-review -->\n## Review Summary\n- Verdict: ✅ `approved`\nEverything looks great!',
        created_at: '2025-06-01T13:00:00Z',
      }

      spawnMock.mockImplementation(
        createSpawnMock({
          'remote.origin.url': {
            stdout: 'git@github.com:acme/repo.git',
          },
          'issues/comments/3002/reactions': {
            stdout: '[]',
          },
          'issues/comments/3002 --paginate': {
            stdout: JSON.stringify(brrrComment),
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchSingleIssueComment('workspace-1', 3002)

      assert.strictEqual(result.comment.id, 3002)
      assert.strictEqual(result.verdict, 'approved')
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('extracts needs_fix verdict from brrr-review marker', () =>
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
      setupWorkspace('git@github.com:acme/repo.git', tempRoots, store, {
        prNumber: 10,
      })

      const brrrComment = {
        id: 3003,
        user: {
          login: 'brrr-bot',
          avatar_url: 'https://example.com/bot.png',
        },
        body: '<!-- brrr-review -->\n## Review Summary\n- Verdict: ❌ `needs_fix`\nSeveral issues found.',
        created_at: '2025-06-01T14:00:00Z',
      }

      spawnMock.mockImplementation(
        createSpawnMock({
          'remote.origin.url': {
            stdout: 'git@github.com:acme/repo.git',
          },
          'issues/comments/3003/reactions': {
            stdout: '[]',
          },
          'issues/comments/3003 --paginate': {
            stdout: JSON.stringify(brrrComment),
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchSingleIssueComment('workspace-1', 3003)

      assert.strictEqual(result.verdict, 'needs_fix')
    }).pipe(Effect.provide(TestLayer))
  )
})

// =========================================================================
// fetchSingleReviewComment
// =========================================================================

describe('ReviewCommentFetcher.fetchSingleReviewComment', () => {
  it.scoped(
    'returns a plain comment when no brrr-finding marker is present',
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
        setupWorkspace('git@github.com:acme/repo.git', tempRoots, store, {
          prNumber: 10,
        })

        const reviewComment = {
          id: 4001,
          user: {
            login: 'reviewer',
            avatar_url: 'https://example.com/reviewer.png',
          },
          body: 'This function needs error handling.',
          path: 'src/utils.ts',
          line: 55,
          original_line: 55,
          created_at: '2025-06-02T10:00:00Z',
        }

        spawnMock.mockImplementation(
          createSpawnMock({
            'remote.origin.url': {
              stdout: 'git@github.com:acme/repo.git',
            },
            'pulls/comments/4001/reactions': {
              stdout: '[]',
            },
            'pulls/comments/4001 --paginate': {
              stdout: JSON.stringify(reviewComment),
            },
          })
        )

        const fetcher = yield* ReviewCommentFetcher
        const result = yield* fetcher.fetchSingleReviewComment(
          'workspace-1',
          4001
        )

        assert.strictEqual(result.kind, 'comment')
        if (result.kind !== 'comment') {
          throw new Error('Expected comment')
        }
        assert.strictEqual(result.comment.id, 4001)
        assert.strictEqual(result.comment.commentType, 'review')
        assert.strictEqual(result.comment.authorLogin, 'reviewer')
        assert.strictEqual(
          result.comment.body,
          'This function needs error handling.'
        )
        assert.strictEqual(result.comment.filePath, 'src/utils.ts')
        assert.strictEqual(result.comment.line, 55)
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('returns a finding when brrr-finding marker is present', () =>
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
      setupWorkspace('git@github.com:acme/repo.git', tempRoots, store, {
        prNumber: 10,
      })

      const findingJson = JSON.stringify({
        id: 'finding-1',
        file: 'src/api.ts',
        line: 42,
        severity: 'critical',
        description: 'Unhandled promise rejection',
        suggested_fixes: ['Add try-catch block'],
        category: 'error-handling',
        depends_on: [],
      })

      const reviewComment = {
        id: 4002,
        user: {
          login: 'brrr-bot',
          avatar_url: 'https://example.com/bot.png',
        },
        body: `Some description\n<!-- brrr-finding:${findingJson} -->\nMore text`,
        path: 'src/api.ts',
        line: 42,
        original_line: 42,
        created_at: '2025-06-02T11:00:00Z',
      }

      const reactions = [{ id: 8001, content: 'rocket', user: { id: 300 } }]

      spawnMock.mockImplementation(
        createSpawnMock({
          'remote.origin.url': {
            stdout: 'git@github.com:acme/repo.git',
          },
          'pulls/comments/4002/reactions': {
            stdout: JSON.stringify(reactions),
          },
          'pulls/comments/4002 --paginate': {
            stdout: JSON.stringify(reviewComment),
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchSingleReviewComment(
        'workspace-1',
        4002
      )

      assert.strictEqual(result.kind, 'finding')
      if (result.kind !== 'finding') {
        throw new Error('Expected finding')
      }
      assert.strictEqual(result.finding.id, 'finding-1')
      assert.strictEqual(result.finding.file, 'src/api.ts')
      assert.strictEqual(result.finding.line, 42)
      assert.strictEqual(result.finding.severity, 'critical')
      assert.strictEqual(
        result.finding.description,
        'Unhandled promise rejection'
      )
      assert.deepStrictEqual(result.finding.suggestedFixes, [
        'Add try-catch block',
      ])
      assert.strictEqual(result.finding.category, 'error-handling')
      assert.strictEqual(result.finding.commentId, 4002)
      assert.strictEqual(result.finding.reactions.length, 1)
      assert.strictEqual(result.finding.reactions[0]?.content, 'rocket')
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('includes reactions on plain comment', () =>
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
      setupWorkspace('git@github.com:acme/repo.git', tempRoots, store, {
        prNumber: 10,
      })

      const reviewComment = {
        id: 4003,
        user: {
          login: 'reviewer',
          avatar_url: 'https://example.com/reviewer.png',
        },
        body: 'Nice refactor!',
        path: 'src/main.ts',
        line: 10,
        original_line: 10,
        created_at: '2025-06-02T12:00:00Z',
      }

      const reactions = [
        { id: 8010, content: '+1', user: { id: 400 } },
        { id: 8011, content: 'heart', user: { id: 401 } },
      ]

      spawnMock.mockImplementation(
        createSpawnMock({
          'remote.origin.url': {
            stdout: 'git@github.com:acme/repo.git',
          },
          'pulls/comments/4003/reactions': {
            stdout: JSON.stringify(reactions),
          },
          'pulls/comments/4003 --paginate': {
            stdout: JSON.stringify(reviewComment),
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchSingleReviewComment(
        'workspace-1',
        4003
      )

      assert.strictEqual(result.kind, 'comment')
      if (result.kind !== 'comment') {
        throw new Error('Expected comment')
      }
      assert.strictEqual(result.comment.reactions.length, 2)
      assert.strictEqual(result.comment.reactions[0]?.content, '+1')
      assert.strictEqual(result.comment.reactions[1]?.content, 'heart')
    }).pipe(Effect.provide(TestLayer))
  )
})

// =========================================================================
// fetchSingleReview
// =========================================================================

describe('ReviewCommentFetcher.fetchSingleReview', () => {
  it.scoped('fetches a review and returns state, author, and body', () =>
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
      setupWorkspace('git@github.com:acme/repo.git', tempRoots, store, {
        prNumber: 10,
      })

      const review = {
        id: 9001,
        state: 'APPROVED',
        user: {
          login: 'lead-dev',
          avatar_url: 'https://example.com/lead.png',
        },
        body: 'Ship it!',
      }

      spawnMock.mockImplementation(
        createSpawnMock({
          'remote.origin.url': {
            stdout: 'git@github.com:acme/repo.git',
          },
          'gh pr view --json number': {
            stdout: JSON.stringify({ number: 10 }),
          },
          'pulls/10/reviews/9001': {
            stdout: JSON.stringify(review),
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchSingleReview('workspace-1', 9001)

      assert.strictEqual(result.reviewId, 9001)
      assert.strictEqual(result.state, 'APPROVED')
      assert.strictEqual(result.authorLogin, 'lead-dev')
      assert.strictEqual(result.body, 'Ship it!')
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('fetches a CHANGES_REQUESTED review', () =>
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
      setupWorkspace('git@github.com:acme/repo.git', tempRoots, store, {
        prNumber: 10,
      })

      const review = {
        id: 9002,
        state: 'CHANGES_REQUESTED',
        user: {
          login: 'senior-dev',
          avatar_url: 'https://example.com/senior.png',
        },
        body: 'Please address the security concerns.',
      }

      spawnMock.mockImplementation(
        createSpawnMock({
          'remote.origin.url': {
            stdout: 'git@github.com:acme/repo.git',
          },
          'gh pr view --json number': {
            stdout: JSON.stringify({ number: 10 }),
          },
          'pulls/10/reviews/9002': {
            stdout: JSON.stringify(review),
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchSingleReview('workspace-1', 9002)

      assert.strictEqual(result.state, 'CHANGES_REQUESTED')
      assert.strictEqual(result.body, 'Please address the security concerns.')
    }).pipe(Effect.provide(TestLayer))
  )
})
