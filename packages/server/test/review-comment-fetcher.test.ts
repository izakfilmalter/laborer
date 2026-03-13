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

        // No brrr markers in these comments → verdict null, findings empty
        assert.isNull(result.verdict)
        assert.strictEqual(result.findings.length, 0)

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

  // -------------------------------------------------------------------------
  // Finding extraction tests
  // -------------------------------------------------------------------------

  it.scoped(
    'extracts structured finding from brrr-finding marker in review comment',
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

        const findingJson = JSON.stringify({
          id: 'sql-injection',
          file: 'src/db.ts',
          line: 42,
          severity: 'critical',
          description: 'SQL injection vulnerability',
          suggested_fixes: ['Use parameterized queries'],
          category: 'security',
          depends_on: [],
        })

        const reviewComments = [
          {
            id: 3001,
            user: {
              login: 'brrr-bot',
              avatar_url: 'https://example.com/brrr.png',
            },
            body: `**CRITICAL** SQL injection vulnerability\n\n<!-- brrr-finding:${findingJson} -->`,
            path: 'src/db.ts',
            line: 42,
            original_line: 42,
            created_at: '2025-01-15T12:00:00Z',
          },
        ]

        spawnMock.mockImplementation(
          createSpawnMock({
            'remote.origin.url': {
              stdout: 'git@github.com:acme/laborer.git',
            },
            'issues/42/comments': {
              stdout: '[]',
            },
            'pulls/42/comments --paginate': {
              stdout: JSON.stringify(reviewComments),
            },
            'pulls/comments/3001/reactions': {
              stdout: JSON.stringify([
                { id: 6001, content: 'rocket', user: { id: 200 } },
              ]),
            },
          })
        )

        const fetcher = yield* ReviewCommentFetcher
        const result = yield* fetcher.fetchComments('workspace-1')

        // Finding should be in findings array, not comments
        assert.strictEqual(result.findings.length, 1)
        assert.strictEqual(result.comments.length, 0)

        const finding = result.findings[0]
        assert.isDefined(finding)
        if (finding) {
          assert.strictEqual(finding.id, 'sql-injection')
          assert.strictEqual(finding.file, 'src/db.ts')
          assert.strictEqual(finding.line, 42)
          assert.strictEqual(finding.severity, 'critical')
          assert.strictEqual(finding.description, 'SQL injection vulnerability')
          assert.deepStrictEqual(finding.suggestedFixes, [
            'Use parameterized queries',
          ])
          assert.strictEqual(finding.category, 'security')
          assert.deepStrictEqual(finding.dependsOn, [])
          assert.strictEqual(finding.commentId, 3001)
          assert.strictEqual(finding.reactions.length, 1)
          assert.strictEqual(finding.reactions[0]?.content, 'rocket')
        }
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped(
    'falls back to comments array when brrr-finding JSON is malformed',
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

        const reviewComments = [
          {
            id: 3002,
            user: {
              login: 'brrr-bot',
              avatar_url: 'https://example.com/brrr.png',
            },
            body: '**Finding** Bad JSON\n\n<!-- brrr-finding:{invalid json here -->',
            path: 'src/app.ts',
            line: 10,
            original_line: 10,
            created_at: '2025-01-15T12:00:00Z',
          },
        ]

        spawnMock.mockImplementation(
          createSpawnMock({
            'remote.origin.url': {
              stdout: 'git@github.com:acme/laborer.git',
            },
            'issues/42/comments': {
              stdout: '[]',
            },
            'pulls/42/comments --paginate': {
              stdout: JSON.stringify(reviewComments),
            },
            'pulls/comments/3002/reactions': {
              stdout: '[]',
            },
          })
        )

        const fetcher = yield* ReviewCommentFetcher
        const result = yield* fetcher.fetchComments('workspace-1')

        // Malformed finding → falls back to comments, not findings
        assert.strictEqual(result.findings.length, 0)
        assert.strictEqual(result.comments.length, 1)
        assert.strictEqual(result.comments[0]?.id, 3002)
        assert.strictEqual(result.comments[0]?.commentType, 'review')
      }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('extracts multiple findings from multiple review comments', () =>
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

      const finding1Json = JSON.stringify({
        id: 'null-check',
        file: 'src/utils.ts',
        line: 15,
        severity: 'warning',
        description: 'Missing null check',
        suggested_fixes: [],
        category: 'correctness',
        depends_on: null,
      })

      const finding2Json = JSON.stringify({
        id: 'unused-import',
        file: 'src/index.ts',
        line: 3,
        severity: 'info',
        description: 'Unused import',
        suggested_fixes: ['Remove the import'],
        category: 'hygiene',
        depends_on: [],
      })

      const reviewComments = [
        {
          id: 4001,
          user: {
            login: 'brrr-bot',
            avatar_url: 'https://example.com/brrr.png',
          },
          body: `Warning\n\n<!-- brrr-finding:${finding1Json} -->`,
          path: 'src/utils.ts',
          line: 15,
          original_line: 15,
          created_at: '2025-01-15T12:00:00Z',
        },
        {
          id: 4002,
          user: {
            login: 'brrr-bot',
            avatar_url: 'https://example.com/brrr.png',
          },
          body: `Info\n\n<!-- brrr-finding:${finding2Json} -->`,
          path: 'src/index.ts',
          line: 3,
          original_line: 3,
          created_at: '2025-01-15T12:01:00Z',
        },
      ]

      spawnMock.mockImplementation(
        createSpawnMock({
          'remote.origin.url': {
            stdout: 'git@github.com:acme/laborer.git',
          },
          'issues/42/comments': {
            stdout: '[]',
          },
          'pulls/42/comments --paginate': {
            stdout: JSON.stringify(reviewComments),
          },
          'pulls/comments/4001/reactions': {
            stdout: '[]',
          },
          'pulls/comments/4002/reactions': {
            stdout: '[]',
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchComments('workspace-1')

      assert.strictEqual(result.findings.length, 2)
      assert.strictEqual(result.comments.length, 0)

      const f1 = result.findings.find((f) => f.id === 'null-check')
      assert.isDefined(f1)
      assert.strictEqual(f1?.severity, 'warning')
      assert.strictEqual(f1?.category, 'correctness')
      // depends_on: null should be normalized to []
      assert.deepStrictEqual(f1?.dependsOn, [])

      const f2 = result.findings.find((f) => f.id === 'unused-import')
      assert.isDefined(f2)
      assert.strictEqual(f2?.severity, 'info')
      assert.deepStrictEqual(f2?.suggestedFixes, ['Remove the import'])
    }).pipe(Effect.provide(TestLayer))
  )

  // -------------------------------------------------------------------------
  // Verdict extraction tests
  // -------------------------------------------------------------------------

  it.scoped('extracts approved verdict from brrr-review summary comment', () =>
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

      const summaryBody = [
        '<!-- brrr-review -->',
        'All looks good.',
        '',
        '- Verdict: \u2705 `approved`',
        '- Findings: 0 total (\uD83D\uDD34 `critical`: 0, \uD83D\uDFE1 `warning`: 0, \uD83D\uDD35 `info`: 0)',
      ].join('\n')

      const issueComments = [
        {
          id: 5001,
          user: {
            login: 'brrr-bot',
            avatar_url: 'https://example.com/brrr.png',
          },
          body: summaryBody,
          created_at: '2025-01-15T10:00:00Z',
        },
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
            stdout: '[]',
          },
          'issues/comments/5001/reactions': {
            stdout: '[]',
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchComments('workspace-1')

      assert.strictEqual(result.verdict, 'approved')
      assert.strictEqual(result.findings.length, 0)
      // Summary comment still appears in comments array
      assert.strictEqual(result.comments.length, 1)
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('extracts needs_fix verdict from brrr-review summary comment', () =>
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

      const summaryBody = [
        '<!-- brrr-review -->',
        'Issues found.',
        '',
        '- Verdict: \u274C `needs_fix`',
        '- Findings: 2 total (\uD83D\uDD34 `critical`: 1, \uD83D\uDFE1 `warning`: 1, \uD83D\uDD35 `info`: 0)',
      ].join('\n')

      const issueComments = [
        {
          id: 5002,
          user: {
            login: 'brrr-bot',
            avatar_url: 'https://example.com/brrr.png',
          },
          body: summaryBody,
          created_at: '2025-01-15T10:00:00Z',
        },
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
            stdout: '[]',
          },
          'issues/comments/5002/reactions': {
            stdout: '[]',
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchComments('workspace-1')

      assert.strictEqual(result.verdict, 'needs_fix')
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('returns null verdict when no brrr-review comment exists', () =>
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
          id: 5003,
          user: {
            login: 'human-reviewer',
            avatar_url: 'https://example.com/human.png',
          },
          body: 'Looks good overall, just a few nits.',
          created_at: '2025-01-15T10:00:00Z',
        },
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
            stdout: '[]',
          },
          'issues/comments/5003/reactions': {
            stdout: '[]',
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchComments('workspace-1')

      assert.isNull(result.verdict)
    }).pipe(Effect.provide(TestLayer))
  )

  // -------------------------------------------------------------------------
  // Mixed comments test
  // -------------------------------------------------------------------------

  it.scoped('separates findings from human comments in mixed comment set', () =>
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

      const findingJson = JSON.stringify({
        id: 'xss-vuln',
        file: 'src/render.ts',
        line: 88,
        severity: 'critical',
        description: 'XSS vulnerability in template rendering',
        suggested_fixes: ['Sanitize user input'],
        category: 'security',
        depends_on: [],
      })

      const summaryBody = [
        '<!-- brrr-review -->',
        'Issues found.',
        '',
        '- Verdict: \u274C `needs_fix`',
        '- Findings: 1 total (\uD83D\uDD34 `critical`: 1, \uD83D\uDFE1 `warning`: 0, \uD83D\uDD35 `info`: 0)',
      ].join('\n')

      const issueComments = [
        {
          id: 6001,
          user: {
            login: 'brrr-bot',
            avatar_url: 'https://example.com/brrr.png',
          },
          body: summaryBody,
          created_at: '2025-01-15T10:00:00Z',
        },
        {
          id: 6002,
          user: {
            login: 'human-reviewer',
            avatar_url: 'https://example.com/human.png',
          },
          body: 'Great work on the refactoring!',
          created_at: '2025-01-15T11:00:00Z',
        },
      ]

      const reviewComments = [
        {
          id: 7001,
          user: {
            login: 'brrr-bot',
            avatar_url: 'https://example.com/brrr.png',
          },
          body: `**CRITICAL** XSS vulnerability\n\n<!-- brrr-finding:${findingJson} -->`,
          path: 'src/render.ts',
          line: 88,
          original_line: 88,
          created_at: '2025-01-15T12:00:00Z',
        },
        {
          id: 7002,
          user: {
            login: 'human-reviewer',
            avatar_url: 'https://example.com/human.png',
          },
          body: 'Consider extracting this into a helper function',
          path: 'src/render.ts',
          line: 50,
          original_line: 50,
          created_at: '2025-01-15T11:30:00Z',
        },
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
          'issues/comments/6001/reactions': {
            stdout: '[]',
          },
          'issues/comments/6002/reactions': {
            stdout: '[]',
          },
          'pulls/comments/7001/reactions': {
            stdout: JSON.stringify([
              { id: 8001, content: 'rocket', user: { id: 300 } },
            ]),
          },
          'pulls/comments/7002/reactions': {
            stdout: '[]',
          },
        })
      )

      const fetcher = yield* ReviewCommentFetcher
      const result = yield* fetcher.fetchComments('workspace-1')

      // Verdict from summary comment
      assert.strictEqual(result.verdict, 'needs_fix')

      // 1 brrr finding extracted
      assert.strictEqual(result.findings.length, 1)
      assert.strictEqual(result.findings[0]?.id, 'xss-vuln')
      assert.strictEqual(result.findings[0]?.severity, 'critical')
      assert.strictEqual(result.findings[0]?.reactions.length, 1)
      assert.strictEqual(result.findings[0]?.reactions[0]?.content, 'rocket')

      // 3 plain comments: 2 issue comments + 1 human review comment
      // (the brrr finding comment is NOT in comments)
      assert.strictEqual(result.comments.length, 3)

      // Verify the human review comment is present
      const humanReview = result.comments.find((c) => c.id === 7002)
      assert.isDefined(humanReview)
      assert.strictEqual(humanReview?.commentType, 'review')
      assert.strictEqual(humanReview?.authorLogin, 'human-reviewer')
      assert.strictEqual(humanReview?.filePath, 'src/render.ts')
      assert.strictEqual(humanReview?.line, 50)

      // Verify both issue comments are present
      const issueIds = result.comments
        .filter((c) => c.commentType === 'issue')
        .map((c) => c.id)
      assert.deepStrictEqual(issueIds.sort(), [6001, 6002])
    }).pipe(Effect.provide(TestLayer))
  )
})
