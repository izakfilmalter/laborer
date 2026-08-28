import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, vi } from 'vitest'
import { spawn } from '../src/lib/spawn.js'
import {
  buildFilesPatch,
  commentOnPullRequest,
  editPullRequest,
  fetchPullRequestActivity,
  fetchPullRequestDetail,
  fetchPullRequestDiff,
  fetchPullRequestDiffFileContents,
  fetchReviewerCandidates,
  replyToReviewThread,
  runPullRequestAction,
  setPullRequestReaction,
  setReviewerRequest,
  setReviewThreadResolution,
  submitPullRequestReview,
} from '../src/services/pull-request-panel.js'

vi.mock('../src/lib/spawn.js', () => ({
  spawn: vi.fn(),
}))

const spawnMock = vi.mocked(spawn)

const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

const makeWorktreeDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), 'pr-panel-'))),
  (dir) => Effect.sync(() => rmSync(dir, { force: true, recursive: true }))
)

afterEach(() => {
  spawnMock.mockReset()
})

/** Every recorded spawn's argv. */
const recordedCommands = (): readonly (readonly string[])[] =>
  spawnMock.mock.calls.map(([cmd]) => cmd as string[])

/** The text a call's stdin stream carried, or empty when none was piped. */
const stdinTextOf = async (callIndex: number): Promise<string> => {
  const options = spawnMock.mock.calls[callIndex]?.[1] as
    | { stdin?: ReadableStream<Uint8Array> }
    | undefined
  const stream = options?.stdin
  return stream === undefined ? '' : await new Response(stream).text()
}

/**
 * Answer each `gh` invocation by inspecting its argv. Results are built per
 * call because a `ReadableStream` can only be drained once.
 */
const mockGh = (respond: (cmd: readonly string[]) => string) => {
  spawnMock.mockImplementation(((cmd: string[]) => ({
    exited: Promise.resolve(0),
    kill: () => true,
    pid: 2,
    stderr: streamOf(''),
    stdout: streamOf(respond(cmd)),
  })) as typeof spawn)
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const DETAIL_JSON = JSON.stringify({
  additions: 10,
  author: { login: 'izak', name: 'Izak' },
  autoMergeRequest: null,
  baseRefName: 'main',
  body: 'The body',
  changedFiles: 3,
  closedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  deletions: 2,
  headRefName: 'feat',
  isDraft: false,
  labels: [{ color: 'ff0000', name: 'bug' }],
  mergeable: 'MERGEABLE',
  mergedAt: null,
  number: 7,
  reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: [{ login: 'sam' }, { name: 'Core', slug: 'core' }],
  state: 'OPEN',
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      completedAt: '2026-01-01T01:00:00Z',
      conclusion: 'FAILURE',
      detailsUrl: 'https://checks/1',
      name: 'test',
      status: 'COMPLETED',
      workflowName: 'CI',
    },
    {
      __typename: 'CheckRun',
      completedAt: '2026-01-01T02:00:00Z',
      conclusion: 'SUCCESS',
      detailsUrl: 'https://checks/2',
      name: 'test',
      status: 'COMPLETED',
      workflowName: 'CI',
    },
    {
      __typename: 'StatusContext',
      context: 'lint',
      state: 'PENDING',
      targetUrl: 'https://checks/3',
    },
  ],
  title: 'Add thing',
  updatedAt: '2026-01-02T00:00:00Z',
  url: 'https://github.com/o/r/pull/7',
})

const REPO_ACCESS_JSON = JSON.stringify({
  mergeCommitAllowed: true,
  rebaseMergeAllowed: false,
  squashMergeAllowed: true,
  viewerPermission: 'WRITE',
})

describe('fetchPullRequestDetail', () => {
  it.effect('maps the three gh reads into one detail', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh((cmd) => {
        if (cmd[1] === 'pr') {
          return DETAIL_JSON
        }
        if (cmd[1] === 'repo') {
          return REPO_ACCESS_JSON
        }
        return 'izak\n'
      })

      const detail = yield* fetchPullRequestDetail(worktreePath, 'o/r', 7)

      expect(detail.number).toBe(7)
      expect(detail.state).toBe('open')
      expect(detail.mergeability).toBe('mergeable')
      expect(detail.reviewDecision).toBe('reviewRequired')
      // A JSON null auto-merge request is "nobody armed this", not unknown.
      expect(detail.autoMergeEnabled).toBe(false)
      expect(detail.viewer).toBe('izak')
      expect(detail.viewerCanWrite).toBe(true)
      expect(detail.mergeCapabilities).toEqual({
        merge: true,
        rebase: false,
        squash: true,
      })
      // The re-run collapses to its newest run; the commit status stays.
      expect(detail.checks).toEqual([
        {
          description: null,
          name: 'test',
          status: 'success',
          url: 'https://checks/2',
        },
        {
          description: null,
          name: 'lint',
          status: 'pending',
          url: 'https://checks/3',
        },
      ])
      // A team request wears its slug as a login.
      expect(detail.reviewers.map((reviewer) => reviewer.login)).toEqual([
        'sam',
        'core',
      ])

      const prView = recordedCommands().find((cmd) => cmd[1] === 'pr')
      expect(prView).toContain('--repo')
      expect(prView).toContain('o/r')
    })
  )

  it.effect('reads a merged pull request from mergedAt alone', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      const merged = JSON.stringify({
        ...JSON.parse(DETAIL_JSON),
        mergedAt: '2026-01-03T00:00:00Z',
        state: 'CLOSED',
      })
      mockGh((cmd) => {
        if (cmd[1] === 'pr') {
          return merged
        }
        if (cmd[1] === 'repo') {
          return REPO_ACCESS_JSON
        }
        return 'izak\n'
      })

      const detail = yield* fetchPullRequestDetail(worktreePath, 'o/r', 7)
      expect(detail.state).toBe('merged')
      expect(detail.mergedAt).toBe('2026-01-03T00:00:00Z')
    })
  )

  it.effect('names the missing worktree instead of blaming gh', () =>
    Effect.gen(function* () {
      const missingPath = join(tmpdir(), 'pr-panel-gone')
      const failure = yield* Effect.flip(
        fetchPullRequestDetail(missingPath, 'o/r', 7)
      )
      assert.strictEqual(failure._tag, 'GhApiFailure')
      expect(failure.message).toBe(`Worktree no longer exists: ${missingPath}`)
      expect(spawnMock).not.toHaveBeenCalled()
    })
  )
})

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const ACTIVITY_GRAPHQL_PAGES = JSON.stringify([
  {
    data: {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              {
                databaseId: 11,
                id: 'IC_1',
                reactionGroups: [
                  {
                    content: 'HEART',
                    reactors: { totalCount: 1 },
                    viewerHasReacted: false,
                  },
                ],
              },
            ],
          },
          commits: {
            nodes: [
              {
                commit: {
                  additions: 5,
                  authors: {
                    nodes: [{ name: 'Izak', user: { login: 'izak' } }],
                  },
                  committedDate: '2026-01-01T00:00:00Z',
                  deletions: 1,
                  messageHeadline: 'feat: x',
                  oid: 'abc1234',
                },
              },
            ],
          },
          latestReviews: {
            nodes: [{ author: { avatarUrl: 'https://a/ana', login: 'ana' } }],
          },
          reactionGroups: [
            {
              content: 'THUMBS_UP',
              reactors: { totalCount: 2 },
              viewerHasReacted: true,
            },
          ],
          reviewRequests: {
            nodes: [
              {
                requestedReviewer: { avatarUrl: 'https://a/sam', login: 'sam' },
              },
            ],
          },
          reviews: { nodes: [] },
          reviewThreads: {
            nodes: [
              {
                comments: {
                  nodes: [
                    {
                      author: { login: 'ana' },
                      body: 'hm',
                      createdAt: '2026-01-01T03:00:00Z',
                      databaseId: 21,
                      id: 'RC_1',
                      reactionGroups: [],
                      url: 'https://c/21',
                    },
                  ],
                  totalCount: 1,
                },
                diffSide: 'RIGHT',
                id: 'RT_1',
                isOutdated: false,
                isResolved: false,
                line: 12,
                path: 'src/a.ts',
              },
            ],
          },
        },
      },
    },
  },
])

const activityResponder = (cmd: readonly string[]): string => {
  if (cmd.includes('graphql')) {
    return ACTIVITY_GRAPHQL_PAGES
  }
  const apiPath = cmd.at(-1) ?? ''
  if (apiPath.includes('/issues/')) {
    return JSON.stringify([
      [
        {
          body: 'hi',
          created_at: '2026-01-01T02:00:00Z',
          html_url: 'https://c/11',
          id: 11,
          user: { login: 'izak' },
        },
      ],
    ])
  }
  if (apiPath.includes('/reviews')) {
    return '[[]]'
  }
  return JSON.stringify([
    [
      {
        body: 'hm',
        created_at: '2026-01-01T03:00:00Z',
        html_url: 'https://c/21',
        id: 21,
        line: 12,
        path: 'src/a.ts',
        user: { login: 'ana' },
      },
    ],
  ])
}

describe('fetchPullRequestActivity', () => {
  it.effect('marries the REST timeline with the GraphQL half', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(activityResponder)

      const activity = yield* fetchPullRequestActivity(worktreePath, 'o/r', 7)

      // The timeline stays chronological; each entry now carries the node
      // id reactions are addressed by.
      expect(activity.comments.map((comment) => comment.id)).toEqual([11, 21])
      expect(activity.comments[0]?.nodeId).toBe('IC_1')
      expect(activity.comments[0]?.reactions).toEqual([
        { content: 'heart', count: 1, viewerHasReacted: false },
      ])
      expect(activity.comments[1]?.nodeId).toBe('RC_1')

      expect(activity.reviewThreads).toHaveLength(1)
      const thread = activity.reviewThreads[0]
      expect(thread?.id).toBe('RT_1')
      expect(thread?.path).toBe('src/a.ts')
      expect(thread?.line).toBe(12)
      expect(thread?.side).toBe('right')
      expect(thread?.comments[0]?.id).toBe('RC_1')

      // Asked and answered both appear, each once.
      expect(activity.reviewers.map((reviewer) => reviewer.login)).toEqual([
        'sam',
        'ana',
      ])
      expect(activity.commits).toEqual([
        {
          additions: 5,
          authors: [{ avatarUrl: null, login: 'izak', name: 'Izak' }],
          committedDate: '2026-01-01T00:00:00Z',
          deletions: 1,
          messageHeadline: 'feat: x',
          oid: 'abc1234',
        },
      ])
      expect(activity.reactions).toEqual([
        { content: 'thumbsUp', count: 2, viewerHasReacted: true },
      ])
      expect(activity.threadsTruncated).toBe(false)
    })
  )

  it.effect('fails rather than reading a refused query as no activity', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh((cmd) =>
        cmd.includes('graphql')
          ? JSON.stringify([{ data: null }])
          : activityResponder(cmd)
      )

      const failure = yield* Effect.flip(
        fetchPullRequestActivity(worktreePath, 'o/r', 7)
      )
      assert.strictEqual(failure._tag, 'GhApiFailure')
      expect(failure.message).toContain('no pull request')
    })
  )
})

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

const DIFF_FILES = [
  {
    additions: 1,
    deletions: 1,
    filename: 'src/a.ts',
    patch: '@@ -1 +1 @@\n-a\n+b',
    status: 'modified',
  },
  {
    additions: 2,
    deletions: 0,
    filename: 'new.ts',
    patch: '@@ -0,0 +1,2 @@\n+x\n+y',
    status: 'added',
  },
  {
    additions: 0,
    deletions: 1,
    filename: 'gone.ts',
    patch: '@@ -1 +0,0 @@\n-z',
    status: 'removed',
  },
  {
    additions: 0,
    deletions: 0,
    filename: 'b.ts',
    previous_filename: 'old-b.ts',
    status: 'renamed',
  },
  { additions: 3, deletions: 1, filename: 'img.png', status: 'modified' },
]

describe('fetchPullRequestDiff', () => {
  it.effect('assembles the files API into one unified patch', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() => JSON.stringify(DIFF_FILES))

      const diff = yield* fetchPullRequestDiff(worktreePath, 'o/r', 7)

      expect(diff.patch).toContain('diff --git a/src/a.ts b/src/a.ts')
      expect(diff.patch).toContain('new file mode 100644')
      expect(diff.patch).toContain('--- /dev/null\n+++ b/new.ts')
      expect(diff.patch).toContain('deleted file mode 100644')
      expect(diff.patch).toContain('+++ /dev/null')
      expect(diff.patch).toContain('rename from old-b.ts')
      expect(diff.patch).toContain('rename to b.ts')
      // The binary file is a hole in the patch; the pure rename is not.
      expect(diff.truncated).toBe(true)
      expect(diff.omittedFileStats).toEqual([
        { additions: 3, deletions: 1, path: 'img.png' },
      ])
      // Five files is less than a whole page, so the diff ends here.
      expect(diff.nextCursor).toBeNull()

      const apiPath = recordedCommands()[0]?.at(-1)
      expect(apiPath).toBe('repos/o/r/pulls/7/files?per_page=100&page=1')
    })
  )

  it.effect('hands back a cursor once a page comes back full', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      const fullPage = Array.from({ length: 100 }, (_, index) => ({
        additions: 1,
        deletions: 0,
        filename: `file-${index}.ts`,
        patch: '@@ -0,0 +1 @@\n+x',
        status: 'added',
      }))
      mockGh(() => JSON.stringify(fullPage))

      const diff = yield* fetchPullRequestDiff(worktreePath, 'o/r', 7, {
        cursor: '2',
      })
      expect(diff.nextCursor).toBe('3')

      const apiPath = recordedCommands()[0]?.at(-1)
      expect(apiPath).toBe('repos/o/r/pulls/7/files?per_page=100&page=2')
    })
  )

  it.effect('refuses a cursor this walk never handed out', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      const failure = yield* Effect.flip(
        fetchPullRequestDiff(worktreePath, 'o/r', 7, { cursor: 'abc' })
      )
      assert.strictEqual(failure._tag, 'GhApiFailure')
      expect(spawnMock).not.toHaveBeenCalled()
    })
  )

  it.effect('reads one commit from the commit endpoint', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() => JSON.stringify(DIFF_FILES.slice(0, 1)))

      yield* fetchPullRequestDiff(worktreePath, 'o/r', 7, {
        commit: 'abcdef1234',
      })

      const cmd = recordedCommands()[0]
      expect(cmd).toContain('repos/o/r/commits/abcdef1234?per_page=100&page=1')
      expect(cmd).toContain('--jq')
      expect(cmd).toContain('.files // []')
    })
  )

  it.effect('refuses a commit that is not a sha', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      const failure = yield* Effect.flip(
        fetchPullRequestDiff(worktreePath, 'o/r', 7, { commit: 'main; rm' })
      )
      assert.strictEqual(failure._tag, 'GhApiFailure')
      expect(spawnMock).not.toHaveBeenCalled()
    })
  )
})

describe('buildFilesPatch', () => {
  it('renders a file with no hunks as a header alone', () => {
    const { patch, truncated } = buildFilesPatch([
      {
        additions: 0,
        deletions: 0,
        filename: 'b.ts',
        previous_filename: 'a.ts',
        status: 'renamed',
      },
    ])
    expect(patch).toBe(
      'diff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts\n--- a/a.ts\n+++ b/b.ts\n'
    )
    expect(truncated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Diff file contents
// ---------------------------------------------------------------------------

describe('fetchPullRequestDiffFileContents', () => {
  it.effect('reads both sides at the revisions the pull request names', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh((cmd) => {
        const apiPath = cmd.at(-1) ?? ''
        if (apiPath.includes('| @tsv')) {
          return 'aaaaaaa1\tbbbbbbb2\n'
        }
        return apiPath.includes('ref=aaaaaaa1') ? 'old text' : 'new text'
      })

      const contents = yield* fetchPullRequestDiffFileContents(
        worktreePath,
        'o/r',
        7,
        { changeType: 'change', newPath: 'src/a.ts', oldPath: 'src/a.ts' }
      )
      expect(contents).toEqual({
        newContents: 'new text',
        oldContents: 'old text',
      })

      const contentPaths = recordedCommands()
        .slice(1)
        .map((cmd) => cmd.at(-1))
      expect(contentPaths).toEqual([
        'repos/o/r/contents/src/a.ts?ref=aaaaaaa1',
        'repos/o/r/contents/src/a.ts?ref=bbbbbbb2',
      ])
    })
  )

  it.effect('refuses a binary blob rather than rendering garbage', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh((cmd) => {
        const apiPath = cmd.at(-1) ?? ''
        if (apiPath.includes('| @tsv')) {
          return 'aaaaaaa1\tbbbbbbb2\n'
        }
        return 'binary\0blob'
      })

      const failure = yield* Effect.flip(
        fetchPullRequestDiffFileContents(worktreePath, 'o/r', 7, {
          changeType: 'change',
          newPath: 'img.png',
          oldPath: 'img.png',
        })
      )
      expect(failure.message).toContain('is binary')
    })
  )
})

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

describe('mutations', () => {
  it.effect('posts a comment with the body over stdin', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() => '')

      yield* commentOnPullRequest(worktreePath, 'o/r', 7, 'Hello there')

      expect(recordedCommands()[0]).toEqual([
        'gh',
        'pr',
        'comment',
        '7',
        '--repo',
        'o/r',
        '--body-file',
        '-',
      ])
      expect(yield* Effect.promise(() => stdinTextOf(0))).toBe('Hello there')
    })
  )

  it.effect('edits title and body together, the body over stdin', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() => '')

      yield* editPullRequest(worktreePath, 'o/r', 7, {
        body: 'New body',
        title: 'New title',
      })

      expect(recordedCommands()[0]).toEqual([
        'gh',
        'pr',
        'edit',
        '7',
        '--repo',
        'o/r',
        '--title',
        'New title',
        '--body-file',
        '-',
      ])
      expect(yield* Effect.promise(() => stdinTextOf(0))).toBe('New body')
    })
  )

  it.effect('refuses an edit naming neither title nor body', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      const failure = yield* Effect.flip(
        editPullRequest(worktreePath, 'o/r', 7, {})
      )
      expect(failure.message).toContain('Nothing to edit')
      expect(spawnMock).not.toHaveBeenCalled()
    })
  )

  it.effect('maps each action onto its gh pr subcommand', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() => '')

      yield* runPullRequestAction(worktreePath, 'o/r', 7, {
        action: 'merge',
        mergeMethod: 'squash',
      })
      yield* runPullRequestAction(worktreePath, 'o/r', 7, { action: 'draft' })
      yield* runPullRequestAction(worktreePath, 'o/r', 7, {
        action: 'enableAutoMerge',
        mergeMethod: 'rebase',
      })
      yield* runPullRequestAction(worktreePath, 'o/r', 7, {
        action: 'updateBranch',
        updateMethod: 'rebase',
      })

      expect(recordedCommands()).toEqual([
        ['gh', 'pr', 'merge', '7', '--repo', 'o/r', '--squash'],
        ['gh', 'pr', 'ready', '7', '--repo', 'o/r', '--undo'],
        ['gh', 'pr', 'merge', '7', '--repo', 'o/r', '--auto', '--rebase'],
        ['gh', 'pr', 'update-branch', '7', '--repo', 'o/r', '--rebase'],
      ])
    })
  )

  it.effect('submits a whole review as one request body', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() => '')

      yield* submitPullRequestReview(worktreePath, 'o/r', 7, {
        body: 'Please fix',
        comments: [
          {
            body: 'Wrong here',
            path: 'src/a.ts',
            position: { kind: 'added', newLine: 5 },
          },
          {
            body: 'And here',
            path: 'src/b.ts',
            position: { kind: 'context', newLine: 9, oldLine: 8, side: 'left' },
          },
        ],
        verdict: 'requestChanges',
      })

      expect(recordedCommands()[0]).toContain('repos/o/r/pulls/7/reviews')
      const payload = JSON.parse(
        yield* Effect.promise(() => stdinTextOf(0))
      ) as {
        body: string
        comments: readonly {
          body: string
          line: number
          path: string
          side: string
        }[]
        event: string
      }
      expect(payload.event).toBe('REQUEST_CHANGES')
      expect(payload.body).toBe('Please fix')
      expect(payload.comments).toEqual([
        { body: 'Wrong here', line: 5, path: 'src/a.ts', side: 'RIGHT' },
        { body: 'And here', line: 8, path: 'src/b.ts', side: 'LEFT' },
      ])
    })
  )

  it.effect('replies to a thread through the GraphQL mutation', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() => '')

      yield* replyToReviewThread(worktreePath, 'RT_1', 'Good point')

      expect(recordedCommands()[0]).toEqual([
        'gh',
        'api',
        'graphql',
        '--input',
        '-',
      ])
      const request = JSON.parse(
        yield* Effect.promise(() => stdinTextOf(0))
      ) as { query: string; variables: Record<string, string> }
      expect(request.query).toContain('addPullRequestReviewThreadReply')
      expect(request.variables).toEqual({
        body: 'Good point',
        threadId: 'RT_1',
      })
    })
  )

  it.effect('resolves and unresolves through their own mutations', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() => '')

      yield* setReviewThreadResolution(worktreePath, 'RT_1', true)
      yield* setReviewThreadResolution(worktreePath, 'RT_1', false)

      const first = JSON.parse(yield* Effect.promise(() => stdinTextOf(0))) as {
        query: string
      }
      const second = JSON.parse(
        yield* Effect.promise(() => stdinTextOf(1))
      ) as { query: string }
      expect(first.query).toContain('resolveReviewThread')
      expect(second.query).toContain('unresolveReviewThread')
    })
  )

  it.effect('reacts to a named subject without looking anything up', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() => '')

      yield* setPullRequestReaction(worktreePath, 'o/r', 7, {
        content: 'thumbsUp',
        reacted: true,
        subjectId: 'IC_1',
      })

      expect(recordedCommands()).toHaveLength(1)
      const request = JSON.parse(
        yield* Effect.promise(() => stdinTextOf(0))
      ) as { query: string; variables: Record<string, string> }
      expect(request.query).toContain('addReaction')
      expect(request.variables).toEqual({
        content: 'THUMBS_UP',
        subjectId: 'IC_1',
      })
    })
  )

  it.effect('resolves the pull request node id when no subject is named', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh((cmd) =>
        cmd.includes('--input')
          ? ''
          : JSON.stringify({
              data: { repository: { pullRequest: { id: 'PR_9' } } },
            })
      )

      yield* setPullRequestReaction(worktreePath, 'o/r', 7, {
        content: 'eyes',
        reacted: false,
      })

      expect(recordedCommands()).toHaveLength(2)
      const request = JSON.parse(
        yield* Effect.promise(() => stdinTextOf(1))
      ) as { query: string; variables: Record<string, string> }
      expect(request.query).toContain('removeReaction')
      expect(request.variables).toEqual({ content: 'EYES', subjectId: 'PR_9' })
    })
  )

  it.effect('posts and deletes reviewer requests with one body', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() => '')

      yield* setReviewerRequest(worktreePath, 'o/r', 7, {
        requested: true,
        reviewers: [
          { id: 'sam', kind: 'user' },
          { id: 'core', kind: 'team' },
        ],
      })
      yield* setReviewerRequest(worktreePath, 'o/r', 7, {
        requested: false,
        reviewers: [{ id: 'sam', kind: 'user' }],
      })

      const commands = recordedCommands()
      expect(commands[0]).toContain('POST')
      expect(commands[1]).toContain('DELETE')
      expect(commands[0]).toContain('repos/o/r/pulls/7/requested_reviewers')
      const body = JSON.parse(yield* Effect.promise(() => stdinTextOf(0))) as {
        reviewers: readonly string[]
        team_reviewers: readonly string[]
      }
      expect(body).toEqual({ reviewers: ['sam'], team_reviewers: ['core'] })
    })
  )
})

// ---------------------------------------------------------------------------
// Reviewer candidates
// ---------------------------------------------------------------------------

describe('fetchReviewerCandidates', () => {
  it.effect('drops the author and marks whoever is already asked', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(() =>
        JSON.stringify({
          data: {
            repository: {
              assignableUsers: {
                nodes: [
                  { login: 'izak', name: 'Izak' },
                  { login: 'sam', name: 'Sam' },
                  { login: 'ana', name: 'Ana' },
                ],
                pageInfo: { hasNextPage: true },
              },
              pullRequest: {
                author: { login: 'izak' },
                reviewRequests: {
                  nodes: [
                    { requestedReviewer: { login: 'sam', name: 'Sam' } },
                    { requestedReviewer: { name: 'Core', slug: 'core' } },
                  ],
                },
              },
            },
          },
        })
      )

      const list = yield* fetchReviewerCandidates(worktreePath, 'o/r', 7)

      expect(list.truncated).toBe(true)
      expect(
        list.candidates.map((candidate) => [
          candidate.id,
          candidate.kind,
          candidate.isRequested,
        ])
      ).toEqual([
        ['sam', 'user', true],
        ['core', 'team', true],
        ['ana', 'user', false],
      ])
    })
  )
})
