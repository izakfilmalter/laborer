/**
 * Tests for terminal spawn utilities used during layout reconciliation.
 *
 * When the app starts with persisted layouts referencing stale terminal
 * IDs, the reconciliation process respawns terminals. These tests verify:
 *
 * - Retry behaviour when the server is still initializing
 * - Preservation of stale terminal IDs when spawns permanently fail
 * - Correct mapping of old → new terminal IDs on success
 *
 * @see apps/web/src/panels/reconcile-spawn.ts
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createSpawnGuard,
  respawnStaleTerminals,
  retryOnInitializing,
  type SpawnResult,
  spawnWithRetry,
} from '../src/panels/reconcile-spawn'

// ---------------------------------------------------------------------------
// retryOnInitializing
// ---------------------------------------------------------------------------

describe('retryOnInitializing', () => {
  it('retries the operation on "still initializing" errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('still initializing — please retry shortly')
      )
      .mockResolvedValueOnce('success')

    const result = await retryOnInitializing(fn, {
      maxRetries: 3,
      baseDelayMs: 0,
    })

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('returns undefined after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('still initializing'))

    const result = await retryOnInitializing(fn, {
      maxRetries: 2,
      baseDelayMs: 0,
    })

    expect(result).toBeUndefined()
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('does not retry on non-initializing errors', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('network error'))

    const result = await retryOnInitializing(fn, {
      maxRetries: 5,
      baseDelayMs: 0,
    })

    expect(result).toBeUndefined()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// spawnWithRetry
// ---------------------------------------------------------------------------

describe('spawnWithRetry', () => {
  it('retries on "still initializing" error and eventually succeeds', async () => {
    const spawnFn = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          '@laborer/WorkspaceProvider is still initializing — please retry shortly'
        )
      )
      .mockRejectedValueOnce(
        new Error(
          '@laborer/WorkspaceProvider is still initializing — please retry shortly'
        )
      )
      .mockResolvedValueOnce({
        id: 'term-new',
        command: '/bin/zsh',
        status: 'running',
      })

    const result = await spawnWithRetry('ws-1', spawnFn, {
      maxRetries: 5,
      baseDelayMs: 0, // no real delay in tests
    })

    expect(result).toEqual({
      id: 'term-new',
      command: '/bin/zsh',
      status: 'running',
    })
    // First attempt + 2 retries = 3 calls
    expect(spawnFn).toHaveBeenCalledTimes(3)
    // Each call should pass the correct workspace ID
    expect(spawnFn).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
  })

  it('returns undefined after exhausting all retries', async () => {
    const initError = new Error(
      '@laborer/WorkspaceProvider is still initializing — please retry shortly'
    )
    const spawnFn = vi.fn().mockRejectedValue(initError)

    const result = await spawnWithRetry('ws-1', spawnFn, {
      maxRetries: 2,
      baseDelayMs: 0,
    })

    expect(result).toBeUndefined()
    // 1 initial + 2 retries = 3 total attempts
    expect(spawnFn).toHaveBeenCalledTimes(3)
  })

  it('does not retry on non-initializing errors', async () => {
    const spawnFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Something else went wrong'))

    const result = await spawnWithRetry('ws-1', spawnFn, {
      maxRetries: 5,
      baseDelayMs: 0,
    })

    expect(result).toBeUndefined()
    // Should fail immediately without retrying
    expect(spawnFn).toHaveBeenCalledTimes(1)
  })

  it('succeeds on first attempt without retrying', async () => {
    const spawnFn = vi.fn().mockResolvedValueOnce({
      id: 'term-1',
      command: '/bin/zsh',
      status: 'running',
    })

    const result = await spawnWithRetry('ws-1', spawnFn, {
      maxRetries: 5,
      baseDelayMs: 0,
    })

    expect(result).toEqual({
      id: 'term-1',
      command: '/bin/zsh',
      status: 'running',
    })
    expect(spawnFn).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// respawnStaleTerminals
// ---------------------------------------------------------------------------

describe('respawnStaleTerminals', () => {
  it('preserves stale terminal IDs in effective live set when spawn fails', async () => {
    const staleLeaves = [{ workspaceId: 'ws-1', terminalId: 'term-stale-1' }]

    // Spawn always fails (server never comes up)
    const spawnFn = vi.fn().mockRejectedValue(new Error('Something went wrong'))

    const commitFn = vi.fn()

    await respawnStaleTerminals({
      staleLeaves,
      spawnFn,
      liveIds: new Set<string>(),
      commitReconciledLayouts: commitFn,
      spawnRetryOptions: { maxRetries: 0, baseDelayMs: 0 },
    })

    // commitReconciledLayouts should be called with the stale ID
    // in the effective live set so reconciliation does NOT strip it
    expect(commitFn).toHaveBeenCalledTimes(1)
    const [effectiveLiveIds, respawnedIds] = commitFn.mock.calls[0] as [
      ReadonlySet<string>,
      ReadonlyMap<string, string>,
    ]
    expect(effectiveLiveIds.has('term-stale-1')).toBe(true)
    expect(respawnedIds.size).toBe(0)
  })

  it('replaces stale IDs with new ones when spawn succeeds', async () => {
    const staleLeaves = [
      { workspaceId: 'ws-1', terminalId: 'term-stale-1' },
      { workspaceId: 'ws-2', terminalId: 'term-stale-2' },
    ]

    let callCount = 0
    const spawnFn = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({
        id: `term-new-${callCount}`,
        command: '/bin/zsh',
        status: 'running',
      })
    })

    const commitFn = vi.fn()
    const onSpawnedFn = vi.fn()

    await respawnStaleTerminals({
      staleLeaves,
      spawnFn,
      liveIds: new Set<string>(),
      commitReconciledLayouts: commitFn,
      onTerminalSpawned: onSpawnedFn,
      spawnRetryOptions: { maxRetries: 0, baseDelayMs: 0 },
    })

    expect(commitFn).toHaveBeenCalledTimes(1)
    const [effectiveLiveIds, respawnedIds] = commitFn.mock.calls[0] as [
      ReadonlySet<string>,
      ReadonlyMap<string, string>,
    ]

    // No stale IDs in the live set — all were successfully respawned
    expect(effectiveLiveIds.size).toBe(0)

    // Old → new mapping is correct
    expect(respawnedIds.get('term-stale-1')).toBe('term-new-1')
    expect(respawnedIds.get('term-stale-2')).toBe('term-new-2')

    // onTerminalSpawned was called for each success
    expect(onSpawnedFn).toHaveBeenCalledTimes(2)
    expect(onSpawnedFn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'term-new-1' }),
      'ws-1'
    )
    expect(onSpawnedFn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'term-new-2' }),
      'ws-2'
    )
  })

  it('handles mixed success and failure across leaves', async () => {
    const staleLeaves = [
      { workspaceId: 'ws-ok', terminalId: 'term-ok' },
      { workspaceId: 'ws-fail', terminalId: 'term-fail' },
      { workspaceId: 'ws-ok-2', terminalId: 'term-ok-2' },
    ]

    const spawnFn = vi
      .fn()
      .mockImplementation((payload: { workspaceId: string }) => {
        if (payload.workspaceId === 'ws-fail') {
          return Promise.reject(new Error('Permanent failure'))
        }
        return Promise.resolve({
          id: `new-${payload.workspaceId}`,
          command: '/bin/zsh',
          status: 'running',
        })
      })

    const commitFn = vi.fn()

    await respawnStaleTerminals({
      staleLeaves,
      spawnFn,
      liveIds: new Set(['term-existing']),
      commitReconciledLayouts: commitFn,
      spawnRetryOptions: { maxRetries: 0, baseDelayMs: 0 },
    })

    const [effectiveLiveIds, respawnedIds] = commitFn.mock.calls[0] as [
      ReadonlySet<string>,
      ReadonlyMap<string, string>,
    ]

    // Failed stale ID is preserved in effective live set
    expect(effectiveLiveIds.has('term-fail')).toBe(true)
    // Existing live IDs are also preserved
    expect(effectiveLiveIds.has('term-existing')).toBe(true)
    // Successful stale IDs are NOT in the live set (they're in respawnedIds)
    expect(effectiveLiveIds.has('term-ok')).toBe(false)

    // Successful mappings
    expect(respawnedIds.get('term-ok')).toBe('new-ws-ok')
    expect(respawnedIds.get('term-ok-2')).toBe('new-ws-ok-2')
    // Failed mapping does not exist
    expect(respawnedIds.has('term-fail')).toBe(false)
  })

  it('skips leaves without workspaceId or terminalId', async () => {
    const staleLeaves = [
      { workspaceId: undefined, terminalId: 'term-1' },
      { workspaceId: 'ws-1', terminalId: undefined },
      { workspaceId: 'ws-2', terminalId: 'term-2' },
    ]

    const spawnFn = vi.fn().mockResolvedValue({
      id: 'term-new',
      command: '/bin/zsh',
      status: 'running',
    })

    const commitFn = vi.fn()

    await respawnStaleTerminals({
      staleLeaves,
      spawnFn,
      liveIds: new Set<string>(),
      commitReconciledLayouts: commitFn,
      spawnRetryOptions: { maxRetries: 0, baseDelayMs: 0 },
    })

    // Only the third leaf with both IDs should trigger a spawn
    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledWith({ workspaceId: 'ws-2' })
  })
})

// ---------------------------------------------------------------------------
// Concurrent spawns across different panes
// ---------------------------------------------------------------------------

describe('concurrent spawns across different panes', () => {
  it('both spawns succeed when the spawn function is truly independent per call', async () => {
    const guard = createSpawnGuard()

    // Simulate two independent spawn functions — each call gets its own
    // Promise that resolves independently, mirroring VS Code's pattern
    // where each TerminalInstance owns its own TerminalProcessManager.
    let resolveFirst!: (value: SpawnResult) => void
    let resolveSecond!: (value: SpawnResult) => void

    const spawnFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SpawnResult>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<SpawnResult>((resolve) => {
            resolveSecond = resolve
          })
      )

    // Start spawns for two different panes concurrently
    const firstPromise = guard.run('pane-1', () =>
      retryOnInitializing(() => spawnFn(), { maxRetries: 0 })
    )
    const secondPromise = guard.run('pane-2', () =>
      retryOnInitializing(() => spawnFn(), { maxRetries: 0 })
    )

    // Both spawns should be in-flight simultaneously
    expect(guard.isSpawning('pane-1')).toBe(true)
    expect(guard.isSpawning('pane-2')).toBe(true)
    expect(spawnFn).toHaveBeenCalledTimes(2)

    // Resolve them in reverse order to verify independence
    resolveSecond({ id: 'term-2', command: '/bin/zsh', status: 'running' })
    const secondResult = await secondPromise

    // Second completes — first should still be in-flight
    expect(secondResult).toEqual({
      id: 'term-2',
      command: '/bin/zsh',
      status: 'running',
    })
    expect(guard.isSpawning('pane-1')).toBe(true)
    expect(guard.isSpawning('pane-2')).toBe(false)

    // Now resolve the first
    resolveFirst({ id: 'term-1', command: '/bin/zsh', status: 'running' })
    const firstResult = await firstPromise

    expect(firstResult).toEqual({
      id: 'term-1',
      command: '/bin/zsh',
      status: 'running',
    })
    expect(guard.isSpawning('pane-1')).toBe(false)
  })

  it('a "latest-wins" spawn function causes the first spawn to fail', async () => {
    const guard = createSpawnGuard()

    // Simulate the bug: a "latest-wins" spawn function where calling it
    // a second time rejects the first call's promise. This models the
    // AtomResultFn mutation atom behaviour that interrupts the previous
    // fiber when a new value is set.
    let rejectPrevious: ((reason: Error) => void) | undefined

    const latestWinsSpawnFn = vi.fn().mockImplementation(() => {
      // If a previous call is still in-flight, reject it
      if (rejectPrevious) {
        rejectPrevious(new Error('Interrupted by newer spawn'))
      }
      return new Promise<SpawnResult>((resolve, reject) => {
        rejectPrevious = reject
        // Auto-resolve after a short delay to simulate server response
        setTimeout(
          () =>
            resolve({
              id: `term-${Math.random()}`,
              command: '/bin/zsh',
              status: 'running',
            }),
          10
        )
      })
    })

    // Start spawns for two different panes concurrently
    const firstPromise = guard.run('pane-1', () =>
      retryOnInitializing(() => latestWinsSpawnFn(), { maxRetries: 0 })
    )
    const secondPromise = guard.run('pane-2', () =>
      retryOnInitializing(() => latestWinsSpawnFn(), { maxRetries: 0 })
    )

    const firstResult = await firstPromise
    const secondResult = await secondPromise

    // The first spawn was interrupted — retryOnInitializing swallowed
    // the error and returned undefined. This is the bug.
    expect(firstResult).toBeUndefined()
    // Only the second spawn succeeded
    expect(secondResult).toBeDefined()
    expect((secondResult as SpawnResult | undefined)?.id).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// createSpawnGuard
// ---------------------------------------------------------------------------

describe('createSpawnGuard', () => {
  it('executes the spawn function when no spawn is in-flight for the key', async () => {
    const guard = createSpawnGuard()
    const fn = vi.fn().mockResolvedValue('result')

    const result = await guard.run('pane-1', fn)

    expect(result).toBe('result')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('drops concurrent spawns for the same key', async () => {
    const guard = createSpawnGuard()
    let resolveFirst!: (value: string) => void
    const firstFn = vi.fn().mockReturnValue(
      new Promise<string>((resolve) => {
        resolveFirst = resolve
      })
    )
    const secondFn = vi.fn().mockResolvedValue('second')

    // Start first spawn (doesn't resolve yet)
    const firstPromise = guard.run('pane-1', firstFn)

    // Second spawn for same key should be dropped
    const secondResult = await guard.run('pane-1', secondFn)

    expect(secondResult).toBeUndefined()
    expect(secondFn).not.toHaveBeenCalled()

    // Resolve first spawn
    resolveFirst('first')
    const firstResult = await firstPromise

    expect(firstResult).toBe('first')
    expect(firstFn).toHaveBeenCalledTimes(1)
  })

  it('allows spawns for different keys concurrently', async () => {
    const guard = createSpawnGuard()
    let resolveFirst!: (value: string) => void
    const firstFn = vi.fn().mockReturnValue(
      new Promise<string>((resolve) => {
        resolveFirst = resolve
      })
    )
    const secondFn = vi.fn().mockResolvedValue('second')

    // Start spawn for pane-1 (doesn't resolve yet)
    const firstPromise = guard.run('pane-1', firstFn)

    // Spawn for pane-2 should proceed (different key)
    const secondResult = await guard.run('pane-2', secondFn)

    expect(secondResult).toBe('second')
    expect(secondFn).toHaveBeenCalledTimes(1)

    resolveFirst('first')
    await firstPromise
  })

  it('clears the guard after spawn succeeds', async () => {
    const guard = createSpawnGuard()
    const fn = vi.fn().mockResolvedValue('result')

    await guard.run('pane-1', fn)
    // After completion, same key should be available again
    const result = await guard.run('pane-1', fn)

    expect(result).toBe('result')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('clears the guard after spawn fails', async () => {
    const guard = createSpawnGuard()
    const failFn = vi.fn().mockRejectedValue(new Error('spawn failed'))
    const successFn = vi.fn().mockResolvedValue('success')

    // First spawn fails
    const failResult = await guard.run('pane-1', failFn)
    expect(failResult).toBeUndefined()

    // Guard should be cleared — next spawn proceeds
    const successResult = await guard.run('pane-1', successFn)
    expect(successResult).toBe('success')
    expect(successFn).toHaveBeenCalledTimes(1)
  })

  it('reports whether a spawn is in-flight for a key', async () => {
    const guard = createSpawnGuard()
    let resolveSpawn!: (value: string) => void
    const fn = vi.fn().mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSpawn = resolve
      })
    )

    expect(guard.isSpawning('pane-1')).toBe(false)

    const promise = guard.run('pane-1', fn)
    expect(guard.isSpawning('pane-1')).toBe(true)

    resolveSpawn('done')
    await promise
    expect(guard.isSpawning('pane-1')).toBe(false)
  })
})
