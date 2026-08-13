/**
 * Tests for the utility process bootstrap script.
 *
 * Since the bootstrap runs inside Electron utility processes (which have
 * `process.parentPort`), these tests verify the bootstrap logic by:
 *
 * 1. Mocking `process.parentPort` before dynamically importing the bootstrap
 * 2. Verifying messages sent via `postMessage` and process exit behavior
 *
 * The bootstrap auto-executes on import, so each test resets modules and
 * sets up fresh mocks before importing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UtilityProcessBootstrapMessage } from '../src/utility-process-types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Collected messages sent via `process.parentPort.postMessage()`. */
let postedMessages: UtilityProcessBootstrapMessage[] = []

/** Track the original process.exit so we can restore it. */
const originalExit = process.exit

/**
 * Wait for the bootstrap's async `bootstrap()` function to settle.
 *
 * The bootstrap calls an async function on import. We need to flush
 * the microtask queue to let it resolve or reject.
 */
async function waitForBootstrap(): Promise<void> {
  // Flush multiple microtask cycles to ensure the dynamic import()
  // and subsequent postMessage/exit calls have all resolved.
  await new Promise((resolve) => setTimeout(resolve, 100))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('utility process bootstrap', () => {
  beforeEach(() => {
    vi.resetModules()
    postedMessages = []
  })

  afterEach(() => {
    Reflect.deleteProperty(process, 'parentPort')
    vi.unstubAllEnvs()
    // Restore original process.exit.
    process.exit = originalExit
  })

  it('exits with code 1 when process.parentPort is not available', async () => {
    // Ensure parentPort does not exist.
    Reflect.deleteProperty(process, 'parentPort')

    const exitSpy = vi.fn<(code?: number) => never>()
    process.exit = exitSpy as any

    await import('../src/utility-process-bootstrap.js')
    await waitForBootstrap()

    expect(exitSpy).toHaveBeenCalledWith(1)
    // No parentPort means no messages can be sent.
    expect(postedMessages).toHaveLength(0)
  })

  it('exits with code 1 and sends error when LABORER_ENTRYPOINT is not set', async () => {
    const mockParentPort = {
      postMessage: vi.fn((message: UtilityProcessBootstrapMessage) => {
        postedMessages.push(message)
      }),
    }
    ;(process as any).parentPort = mockParentPort

    const exitSpy = vi.fn<(code?: number) => never>()
    process.exit = exitSpy as any

    vi.stubEnv('LABORER_ENTRYPOINT', '')

    await import('../src/utility-process-bootstrap.js')
    await waitForBootstrap()

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(postedMessages).toHaveLength(1)
    expect(postedMessages[0]).toEqual({
      type: 'error',
      message: expect.stringContaining('LABORER_ENTRYPOINT'),
    })
  })

  it('sends ready message when entrypoint loads successfully', async () => {
    const mockParentPort = {
      postMessage: vi.fn((message: UtilityProcessBootstrapMessage) => {
        postedMessages.push(message)
      }),
    }
    ;(process as any).parentPort = mockParentPort

    const exitSpy = vi.fn<(code?: number) => never>()
    process.exit = exitSpy as any

    // Create a temporary dummy entrypoint that exports nothing (just loads).
    const dummyEntrypoint = new URL(
      './fixtures/dummy-entrypoint.mjs',
      import.meta.url
    ).href

    vi.stubEnv('LABORER_ENTRYPOINT', dummyEntrypoint)

    await import('../src/utility-process-bootstrap.js')
    await waitForBootstrap()

    expect(postedMessages).toHaveLength(1)
    expect(postedMessages[0]).toEqual({ type: 'ready' })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('sends error message and exits with code 1 when entrypoint fails to load', async () => {
    const mockParentPort = {
      postMessage: vi.fn((message: UtilityProcessBootstrapMessage) => {
        postedMessages.push(message)
      }),
    }
    ;(process as any).parentPort = mockParentPort

    const exitSpy = vi.fn<(code?: number) => never>()
    process.exit = exitSpy as any

    const nonExistentPath = '/tmp/laborer-test-nonexistent-module.mjs'
    vi.stubEnv('LABORER_ENTRYPOINT', nonExistentPath)

    await import('../src/utility-process-bootstrap.js')
    await waitForBootstrap()

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(postedMessages).toHaveLength(1)
    expect(postedMessages[0]?.type).toBe('error')
    expect(postedMessages[0]).toHaveProperty(
      'message',
      expect.stringContaining(nonExistentPath)
    )
  })
})
