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

describe('fetchPullRequestComments', () => {
  it.effect('names the missing worktree instead of blaming gh', () =>
    Effect.gen(function* () {
      const missingPath = join(tmpdir(), 'pr-comments-gone')
      const failure = yield* Effect.flip(
        fetchPullRequestComments(missingPath, 7)
      )

      assert.strictEqual(failure._tag, 'GhApiFailure')
      expect(failure.message).toBe(`Worktree no longer exists: ${missingPath}`)
      expect(spawnMock).not.toHaveBeenCalled()
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

      spawnMock.mockImplementation(((cmd: string[]) => {
        if (cmd[0] === 'git') {
          return {
            exited: Promise.resolve(0),
            kill: () => true,
            pid: 1,
            stderr: streamOf(''),
            stdout: streamOf('git@github.com:izakfilmalter/laborer.git\n'),
          } satisfies SpawnResult
        }

        ghSpawned()
        return {
          // `gh` that never finishes: only the kill can end this fiber.
          exited: new Promise<number>(() => undefined),
          kill,
          pid: 2,
          stderr: streamOf(''),
          stdout: streamOf(''),
        } satisfies SpawnResult
      }) as typeof spawn)

      const fiber = yield* Effect.forkChild(
        fetchPullRequestComments(worktreePath, 7)
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

/** `git config` answers the origin, `gh` answers whatever the test sets. */
const mockGh = (stdout: string, exitCode = 0) => {
  spawnMock.mockImplementation(((cmd: string[]) =>
    cmd[0] === 'git'
      ? {
          exited: Promise.resolve(0),
          kill: () => true,
          pid: 1,
          stderr: streamOf(''),
          stdout: streamOf('git@github.com:izakfilmalter/laborer.git\n'),
        }
      : {
          exited: Promise.resolve(exitCode),
          kill: () => true,
          pid: 2,
          stderr: streamOf(exitCode === 0 ? '' : stdout),
          stdout: streamOf(exitCode === 0 ? stdout : ''),
        }) as typeof spawn)
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

      expect(yield* fetchUnresolvedReviewThreadCount(worktreePath, 7)).toBe(3)
    })
  )

  it.effect('asks GitHub only about the pull request it was given', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(JSON.stringify([threadPage([])]))

      yield* fetchUnresolvedReviewThreadCount(worktreePath, 42)

      const ghCall = spawnMock.mock.calls.find(
        ([cmd]) => cmd[0] === 'gh'
      )?.[0] as string[]
      expect(ghCall).toContain('graphql')
      expect(ghCall).toContain('number=42')
      expect(ghCall).toContain('repo=laborer')
      expect(ghCall).toContain('owner=izakfilmalter')
    })
  )

  it.effect('reads a fully settled pull request as zero', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(JSON.stringify([threadPage([true, true])]))

      expect(yield* fetchUnresolvedReviewThreadCount(worktreePath, 7)).toBe(0)
    })
  )

  it.effect('fails rather than reading a refused query as nothing to do', () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeWorktreeDir
      mockGh(JSON.stringify([{ data: null }]))

      const failure = yield* Effect.flip(
        fetchUnresolvedReviewThreadCount(worktreePath, 7)
      )

      assert.strictEqual(failure._tag, 'GhApiFailure')
      expect(failure.message).toContain('no pull request')
    })
  )

  it.effect('names the missing worktree instead of blaming gh', () =>
    Effect.gen(function* () {
      const missingPath = join(tmpdir(), 'pr-threads-gone')

      const failure = yield* Effect.flip(
        fetchUnresolvedReviewThreadCount(missingPath, 7)
      )

      expect(failure.message).toBe(`Worktree no longer exists: ${missingPath}`)
      expect(spawnMock).not.toHaveBeenCalled()
    })
  )
})
