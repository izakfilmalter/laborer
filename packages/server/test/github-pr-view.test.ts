import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { afterEach, vi } from 'vitest'
import type { SpawnResult } from '../src/lib/spawn.js'
import { spawn } from '../src/lib/spawn.js'
import {
  parseGithubRepo,
  resolveOriginRepoSlug,
  runGhPrViewWithOriginFallback,
} from '../src/services/github-pr-view.js'

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

/** A child that never exits, so only the finalizer can end the fiber. */
const neverExits = (kill: () => boolean): SpawnResult => ({
  exited: new Promise<number>(() => undefined),
  kill,
  spawned: Promise.resolve(2),
  stderr: streamOf(''),
  stdout: streamOf(''),
})

/**
 * Built per call, not shared: a `ReadableStream` can only be drained once, so
 * a module-level result would hand the second test an empty remote URL.
 */
const originRemote = (): SpawnResult => ({
  exited: Promise.resolve(0),
  kill: () => true,
  spawned: Promise.resolve(1),
  stderr: streamOf(''),
  stdout: streamOf('git@github.com:acme/widgets.git\n'),
})

afterEach(() => {
  spawnMock.mockReset()
})

describe('parseGithubRepo', () => {
  it.each([
    ['https://github.com/acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
    ['git@github.com:acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
    [' https://github.com/acme/widgets ', { owner: 'acme', repo: 'widgets' }],
    ['https://example.com/acme/widgets.git', null],
  ])('parses %s', (remoteUrl, expected) => {
    expect(parseGithubRepo(remoteUrl)).toEqual(expected)
  })
})

describe('scoped child processes', () => {
  it.effect('kills the gh process when the caller is interrupted', () =>
    Effect.gen(function* () {
      const kill = vi.fn(() => true)
      let ghSpawned: () => void = () => undefined
      const ghStarted = new Promise<void>((resolve) => {
        ghSpawned = resolve
      })

      spawnMock.mockImplementation(((cmd: string[]) => {
        if (cmd[0] === 'git') {
          return originRemote()
        }

        ghSpawned()
        return neverExits(kill)
      }) as typeof spawn)

      const fiber = yield* Effect.forkChild(
        runGhPrViewWithOriginFallback(
          '/tmp/worktree',
          'feature',
          'number',
          (error) => error
        )
      )
      yield* Effect.promise(() => ghStarted)
      yield* Fiber.interrupt(fiber)

      expect(kill).toHaveBeenCalled()
    })
  )

  it.effect('kills the git process when the caller is interrupted', () =>
    Effect.gen(function* () {
      const kill = vi.fn(() => true)
      let gitSpawned: () => void = () => undefined
      const gitStarted = new Promise<void>((resolve) => {
        gitSpawned = resolve
      })

      spawnMock.mockImplementation((() => {
        gitSpawned()
        return neverExits(kill)
      }) as typeof spawn)

      const fiber = yield* Effect.forkChild(
        resolveOriginRepoSlug('/tmp/worktree')
      )
      yield* Effect.promise(() => gitStarted)
      yield* Fiber.interrupt(fiber)

      expect(kill).toHaveBeenCalled()
    })
  )

  it.effect('still resolves the origin slug when nothing interrupts it', () =>
    Effect.gen(function* () {
      spawnMock.mockImplementation((() => originRemote()) as typeof spawn)

      expect(yield* resolveOriginRepoSlug('/tmp/worktree')).toBe('acme/widgets')
    })
  )

  it.effect('reports no slug when the worktree has no origin remote', () =>
    Effect.gen(function* () {
      spawnMock.mockImplementation((() => ({
        exited: Promise.resolve(1),
        kill: () => true,
        spawned: Promise.resolve(1),
        stderr: streamOf(''),
        stdout: streamOf(''),
      })) as typeof spawn)

      expect(yield* resolveOriginRepoSlug('/tmp/worktree')).toBeNull()
    })
  )

  it.effect('reports no slug when git cannot be spawned at all', () =>
    Effect.gen(function* () {
      spawnMock.mockImplementation((() => {
        throw new Error('spawn git ENOENT')
      }) as typeof spawn)

      expect(yield* resolveOriginRepoSlug('/tmp/worktree')).toBeNull()
    })
  )
})
