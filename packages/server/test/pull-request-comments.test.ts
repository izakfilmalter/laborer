import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { afterEach, vi } from 'vitest'
import type { SpawnResult } from '../src/lib/spawn.js'
import { spawn } from '../src/lib/spawn.js'
import {
  fetchPullRequestComments,
  fetchUnresolvedReviewThreadCount,
  parsePaginatedJsonArray,
} from '../src/services/pull-request-comments.js'

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
  Effect.sync(() => mkdtempSync(join(tmpdir(), 'pr-comments-'))),
  (dir) => Effect.sync(() => rmSync(dir, { force: true, recursive: true }))
)

afterEach(() => {
  spawnMock.mockReset()
})

describe('paginated gh api output', () => {
  it('flattens the pages --slurp wraps in one outer array', () => {
    expect(parsePaginatedJsonArray('[[{"id":1}],[{"id":2}]]')).toEqual([
      { id: 1 },
      { id: 2 },
    ])
  })

  it('keeps bodies that would break a textual page split intact', () => {
    expect(
      parsePaginatedJsonArray(
        '[[{"id":1,"body":"see the [spec][1] and [adr][2]"}],[{"id":2}]]'
      )
    ).toEqual([{ body: 'see the [spec][1] and [adr][2]', id: 1 }, { id: 2 }])
  })

  it('reads a single unwrapped page', () => {
    expect(parsePaginatedJsonArray('[{"id":1},{"id":2}]')).toEqual([
      { id: 1 },
      { id: 2 },
    ])
  })

  it('reads an empty conversation', () => {
    expect(parsePaginatedJsonArray('[[]]')).toEqual([])
  })

  it('reads no output as no comments', () => {
    expect(parsePaginatedJsonArray('   ')).toEqual([])
  })
})

/**
 * Every `gh api` call answers with `stdout`.
 *
 * The result is built inside the implementation rather than hoisted, because
 * a `ReadableStream` can only be drained once and the three collections are
 * three separate spawns.
 */
const mockGhApi = (stdout: string) => {
  spawnMock.mockImplementation((() => ({
    exited: Promise.resolve(0),
    kill: () => true,
    spawned: Promise.resolve(2),
    stderr: streamOf(''),
    stdout: streamOf(stdout),
  })) as typeof spawn)
}

/** The `gh api <path>` argument of every request the mock recorded. */
const requestedApiPaths = (): readonly string[] =>
  spawnMock.mock.calls.map(([cmd]) => (cmd as string[]).at(-1) as string)

describe('fetchPullRequestComments', () => {
  it.effect('names the missing worktree instead of blaming gh', () =>
    Effect.gen(function* () {
      const missingPath = join(tmpdir(), 'pr-comments-gone')
      const failure = yield* Effect.flip(
        fetchPullRequestComments(missingPath, 'izakfilmalter/laborer', 7)
      )

      assert.strictEqual(failure._tag, 'GhApiFailure')
      expect(failure.message).toBe(`Worktree no longer exists: ${missingPath}`)
      expect(spawnMock).not.toHaveBeenCalled()
    })
  )

  it.effect(
    'asks about the repository it was given, not the worktree origin',
    () =>
      Effect.gen(function* () {
        const worktreePath = yield* makeWorktreeDir
        mockGhApi('[[]]')

        yield* fetchPullRequestComments(worktreePath, 'upstream/parent', 42)

        // A fork clone's origin is not the repository the number belongs to,
        // so all three collections have to name the upstream repository.
        expect(requestedApiPaths()).toEqual([
          'repos/upstream/parent/issues/42/comments?per_page=100',
          'repos/upstream/parent/pulls/42/reviews?per_page=100',
          'repos/upstream/parent/pulls/42/comments?per_page=100',
        ])
        // The origin remote is beside the point, so nothing reads it.
        expect(
          spawnMock.mock.calls.filter(([cmd]) => cmd[0] === 'git')
        ).toHaveLength(0)
      })
  )

  it.effect('kills the gh process when the caller is interrupted', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      const kill = vi.fn(() => true)
      let ghSpawned: () => void = () => undefined
      const ghStarted = new Promise<void>((resolve) => {
        ghSpawned = resolve
      })

      spawnMock.mockImplementation((() => {
        ghSpawned()
        return {
          // `gh` that never finishes: only the kill can end this fiber.
          exited: new Promise<number>(() => undefined),
          kill,
          spawned: Promise.resolve(2),
          stderr: streamOf(''),
          stdout: streamOf(''),
        } satisfies SpawnResult
      }) as typeof spawn)

      const fiber = yield* Effect.forkChild(
        fetchPullRequestComments(worktreePath, 'izakfilmalter/laborer', 7)
      )
      yield* Effect.promise(() => ghStarted)
      yield* Fiber.interrupt(fiber)

      expect(kill).toHaveBeenCalled()
    })
  )
})

/** One `gh api graphql --slurp` page of review threads. */
const threadPage = (resolved: readonly boolean[]) => ({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: resolved.map((isResolved) => ({ isResolved })),
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    },
  },
})

/**
 * `gh` answers whatever the test sets, on stdout or stderr depending on how
 * it exits. Built per call for the same reason as {@link mockGhApi}.
 */
const mockGh = (stdout: string, exitCode = 0) => {
  spawnMock.mockImplementation((() => ({
    exited: Promise.resolve(exitCode),
    kill: () => true,
    spawned: Promise.resolve(2),
    stderr: streamOf(exitCode === 0 ? '' : stdout),
    stdout: streamOf(exitCode === 0 ? stdout : ''),
  })) as typeof spawn)
}

describe('fetchUnresolvedReviewThreadCount', () => {
  it.effect('counts threads nobody resolved, across every page', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(
        JSON.stringify([
          threadPage([true, false, false]),
          threadPage([false, true]),
        ])
      )

      expect(
        yield* fetchUnresolvedReviewThreadCount(
          worktreePath,
          'izakfilmalter/laborer',
          7
        )
      ).toBe(3)
    })
  )

  it.effect(
    'asks about the repository it was given, not the worktree origin',
    () =>
      Effect.gen(function* () {
        const worktreePath = yield* makeWorktreeDir
        mockGh(JSON.stringify([threadPage([])]))

        yield* fetchUnresolvedReviewThreadCount(
          worktreePath,
          'upstream/repo',
          42
        )

        const ghCall = spawnMock.mock.calls.find(
          ([cmd]) => cmd[0] === 'gh'
        )?.[0] as string[]
        expect(ghCall).toContain('graphql')
        expect(ghCall).toContain('number=42')
        expect(ghCall).toContain('repo=repo')
        expect(ghCall).toContain('owner=upstream')
        // The origin remote is beside the point, so nothing reads it.
        expect(
          spawnMock.mock.calls.filter(([cmd]) => cmd[0] === 'git')
        ).toHaveLength(0)
      })
  )

  it.effect('reads a fully settled pull request as zero', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(JSON.stringify([threadPage([true, true])]))

      expect(
        yield* fetchUnresolvedReviewThreadCount(
          worktreePath,
          'izakfilmalter/laborer',
          7
        )
      ).toBe(0)
    })
  )

  it.effect('fails rather than reading a refused query as nothing to do', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(JSON.stringify([{ data: null }]))

      const failure = yield* Effect.flip(
        fetchUnresolvedReviewThreadCount(
          worktreePath,
          'izakfilmalter/laborer',
          7
        )
      )

      assert.strictEqual(failure._tag, 'GhApiFailure')
      expect(failure.message).toContain('no pull request')
    })
  )

  it.effect('fails rather than counting a partially answered page', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      // GraphQL answers with data *and* errors when part of the query was
      // refused: the threads it did return are a short count, not the count.
      mockGh(
        JSON.stringify([
          {
            ...threadPage([false, false]),
            errors: [{ message: 'Something went wrong' }],
          },
        ])
      )

      const failure = yield* Effect.flip(
        fetchUnresolvedReviewThreadCount(
          worktreePath,
          'izakfilmalter/laborer',
          7
        )
      )

      assert.strictEqual(failure._tag, 'GhApiFailure')
      expect(failure.message).toContain('Something went wrong')
    })
  )

  it.effect('names the missing worktree instead of blaming gh', () =>
    Effect.gen(function* () {
      const missingPath = join(tmpdir(), 'pr-threads-gone')

      const failure = yield* Effect.flip(
        fetchUnresolvedReviewThreadCount(
          missingPath,
          'izakfilmalter/laborer',
          7
        )
      )

      expect(failure.message).toBe(`Worktree no longer exists: ${missingPath}`)
      expect(spawnMock).not.toHaveBeenCalled()
    })
  )
})
