/**
 * Tests for the git-specific spawn helper.
 *
 * Verifies that `spawnGit` correctly:
 * - Runs git commands and captures stdout/stderr/exitCode
 * - Adds GIT_OPTIONAL_LOCKS=0 for read-only commands
 * - Reads stdout concurrently with process exit (no deadlock)
 * - Enforces a timeout on long-running git processes
 *
 * @see packages/server/src/lib/spawn-git.ts
 */

import { describe, expect, it } from 'vitest'
import { spawn } from '../src/lib/spawn.js'
import { spawnGit } from '../src/lib/spawn-git.js'

const GIT_VERSION_PATTERN = /^git version/

describe('spawnGit', () => {
  // -------------------------------------------------------------------------
  // Basic functionality
  // -------------------------------------------------------------------------

  it('runs a git command and returns stdout, stderr, and exitCode', async () => {
    const result = await spawnGit(['--version'], { cwd: process.cwd() })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(GIT_VERSION_PATTERN)
    expect(result.stderr).toBe('')
  })

  // -------------------------------------------------------------------------
  // GIT_OPTIONAL_LOCKS=0 for read-only commands
  // -------------------------------------------------------------------------

  it('sets GIT_OPTIONAL_LOCKS=0 when readOnly is true', async () => {
    const { buildEnv } = await import('../src/lib/spawn-git.js')
    const env = buildEnv({ cwd: process.cwd(), readOnly: true })
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
  })

  it('does not set GIT_OPTIONAL_LOCKS when readOnly is false', async () => {
    const { buildEnv } = await import('../src/lib/spawn-git.js')
    const env = buildEnv({ cwd: process.cwd(), readOnly: false })
    expect(env.GIT_OPTIONAL_LOCKS).toBeUndefined()
  })

  it('does not set GIT_OPTIONAL_LOCKS when readOnly is omitted', async () => {
    const { buildEnv } = await import('../src/lib/spawn-git.js')
    const env = buildEnv({ cwd: process.cwd() })
    expect(env.GIT_OPTIONAL_LOCKS).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Concurrent stdout reading (no pipe buffer deadlock)
  // -------------------------------------------------------------------------

  it('does not deadlock when git produces large stdout output', async () => {
    // The pipe buffer on most systems is ~64KB. If stdout reading is
    // sequential (await exit then read stdout), a process producing
    // more than 64KB will block on write and never exit — deadlock.
    // This test generates substantial output to verify concurrent reading.
    //
    // Since spawnGit only runs `git`, we use `git help -a` which
    // produces substantial output on most installations.
    const result = await spawnGit(['help', '-a'], {
      cwd: process.cwd(),
      readOnly: true,
    })
    expect(result.exitCode).toBe(0)
    // git help -a output varies but should be at least a few KB
    expect(result.stdout.length).toBeGreaterThan(100)
  }, 10_000)

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  it('rejects when the process exceeds the timeout', async () => {
    // Test the timeout mechanism using `withTimeout` directly with a
    // `sleep` process. The timeout logic in spawnGit is the same.
    const { withTimeout } = await import('../src/lib/spawn-git.js')
    const proc = spawn(['sleep', '999'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await expect(withTimeout(proc, 200)).rejects.toThrow('timed out')
  }, 5000)

  it('does not reject when the process completes within the timeout', async () => {
    const result = await spawnGit(['--version'], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(0)
  })

  it('uses default 30s timeout when timeoutMs is not specified', async () => {
    // Verify the default timeout is applied (the command completes
    // well within 30s, so this just ensures no error is thrown).
    const result = await spawnGit(['--version'], { cwd: process.cwd() })
    expect(result.exitCode).toBe(0)
  })

  // -------------------------------------------------------------------------
  // AbortSignal support
  // -------------------------------------------------------------------------

  it('rejects when the AbortSignal fires', async () => {
    // Test abort using `withTimeout` directly with a `sleep` process
    // (same approach as the timeout test). spawnGit prepends `git` to
    // args so we can't spawn `sleep` through it directly.
    const { withTimeout } = await import('../src/lib/spawn-git.js')
    const controller = new AbortController()
    const proc = spawn(['sleep', '999'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const promise = withTimeout(proc, 30_000, controller.signal)

    // Give the process a moment to start, then abort
    setTimeout(() => controller.abort(), 100)

    // The promise should reject because the process was killed
    await expect(promise).rejects.toThrow('aborted')
  }, 5000)

  it('rejects immediately when the signal is already aborted', async () => {
    const { withTimeout } = await import('../src/lib/spawn-git.js')
    const controller = new AbortController()
    controller.abort() // Abort before spawning

    const proc = spawn(['sleep', '999'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const promise = withTimeout(proc, 30_000, controller.signal)

    // Should reject immediately — no need to wait
    await expect(promise).rejects.toThrow('aborted')
  }, 5000)
})
