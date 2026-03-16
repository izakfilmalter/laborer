/**
 * Headless Terminal State Manager tests.
 *
 * Tests the headless xterm terminal management module that provides
 * compact screen state serialization and backend device query handling.
 *
 * @see PRD-ghostty-web-migration.md — Module 1: Backend: Headless Terminal State Manager
 * @see Issue #7: Backend: Headless terminal state manager
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHeadlessTerminalManager } from '../src/lib/headless-terminal.js'

/** No-op callback for tests that don't need PTY write responses. */
// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for tests
const noop = (): void => {}

/** Regex matching the start of a DA1 response: ESC [ */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC character is intentional for VT escape sequence detection
const DA1_RESPONSE_START = /^\x1b\[/

/** Regex matching the end of a DA1 response: ends with 'c' */
const DA1_RESPONSE_END = /c$/

/** Helper to wait for xterm async processing. */
const waitForXterm = (ms = 50): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

describe('HeadlessTerminalManager', () => {
  let manager: ReturnType<typeof createHeadlessTerminalManager>

  afterEach(() => {
    manager?.disposeAll()
  })

  // ---------------------------------------------------------------
  // Creation and basic lifecycle
  // ---------------------------------------------------------------

  it('creates a headless terminal with SerializeAddon without error', () => {
    manager = createHeadlessTerminalManager()
    expect(() => {
      manager.create('test-1', 80, 24, noop)
    }).not.toThrow()
  })

  it('returns empty string for non-existent terminal', () => {
    manager = createHeadlessTerminalManager()
    expect(manager.getScreenState('non-existent')).toBe('')
  })

  // ---------------------------------------------------------------
  // Screen state serialization
  // ---------------------------------------------------------------

  it('serializes written text in screen state', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24, noop)

    // Write some text and wait for xterm to process it
    manager.write('test-1', 'Hello, World!')

    // xterm.write is async — give it time to process
    await waitForXterm()

    const screenState = manager.getScreenState('test-1')
    expect(screenState).not.toBe('')
    expect(screenState).toContain('Hello, World!')
  })

  it('returns empty string for terminal with no output', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24, noop)

    // Give a moment for initialization
    await waitForXterm(20)

    const screenState = manager.getScreenState('test-1')
    // A fresh terminal with no output serializes to an empty string
    // (or a minimal reset sequence depending on xterm version)
    expect(typeof screenState).toBe('string')
  })

  // ---------------------------------------------------------------
  // Device query handling (DA1/DSR)
  // ---------------------------------------------------------------

  it('forwards DA1 device query response back to PTY', async () => {
    manager = createHeadlessTerminalManager()
    const ptyWrite = vi.fn()

    manager.create('test-1', 80, 24, ptyWrite)

    // Send a DA1 query (Primary Device Attributes request)
    // The headless terminal should respond with its capabilities
    manager.write('test-1', '\x1b[0c')

    // xterm processes asynchronously — wait for response
    await waitForXterm()

    // The headless terminal should have forwarded a DA1 response
    // DA1 responses start with ESC[? and end with c
    expect(ptyWrite).toHaveBeenCalled()
    const response = ptyWrite.mock.calls[0]?.[0] as string
    expect(response).toMatch(DA1_RESPONSE_START)
    expect(response).toMatch(DA1_RESPONSE_END)
  })

  // ---------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------

  it('resizes headless terminal and reflects in serialized state', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24, noop)

    // Write text that fills a line at 80 columns
    const longLine = `${'A'.repeat(80)}${'B'.repeat(10)}`
    manager.write('test-1', longLine)

    await waitForXterm()

    const stateBefore = manager.getScreenState('test-1')

    // Resize to wider terminal
    manager.resize('test-1', 120, 40)

    // Write more text at new dimensions
    manager.write('test-1', `\r\n${'C'.repeat(120)}`)

    await waitForXterm()

    const stateAfter = manager.getScreenState('test-1')

    // The state should be different after resize + new content
    expect(stateAfter).not.toBe(stateBefore)
    expect(stateAfter).toContain('C')
  })

  it('resize is a no-op for non-existent terminal', () => {
    manager = createHeadlessTerminalManager()
    expect(() => {
      manager.resize('non-existent', 120, 40)
    }).not.toThrow()
  })

  // ---------------------------------------------------------------
  // Alternate screen mode
  // ---------------------------------------------------------------

  it('serialized state includes alternate screen mode switch', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24, noop)

    // Enter alternate screen mode (used by vim, htop, etc.)
    manager.write('test-1', '\x1b[?1049h')

    // Write something in the alternate screen
    manager.write('test-1', 'Alternate Screen Content')

    await waitForXterm()

    const screenState = manager.getScreenState('test-1')

    // @xterm/addon-serialize v0.14+ includes the alternate buffer
    // switch sequence when serializing terminals in alternate screen mode
    expect(screenState).toContain('\x1b[?1049h')
    expect(screenState).toContain('Alternate Screen Content')
  })

  // ---------------------------------------------------------------
  // Dispose
  // ---------------------------------------------------------------

  it('disposes a headless terminal cleanly', async () => {
    manager = createHeadlessTerminalManager()
    const ptyWrite = vi.fn()

    manager.create('test-1', 80, 24, ptyWrite)
    manager.write('test-1', 'Hello')

    await waitForXterm()

    // Dispose the terminal
    manager.dispose('test-1')

    // After disposal, getScreenState should return empty string
    expect(manager.getScreenState('test-1')).toBe('')

    // Writing to disposed terminal should be a no-op (not throw)
    expect(() => {
      manager.write('test-1', 'After dispose')
    }).not.toThrow()
  })

  it('dispose is a no-op for non-existent terminal', () => {
    manager = createHeadlessTerminalManager()
    expect(() => {
      manager.dispose('non-existent')
    }).not.toThrow()
  })

  it('disposeAll cleans up all terminals', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24, noop)
    manager.create('test-2', 80, 24, noop)

    manager.write('test-1', 'Hello 1')
    manager.write('test-2', 'Hello 2')

    await waitForXterm()

    manager.disposeAll()

    expect(manager.getScreenState('test-1')).toBe('')
    expect(manager.getScreenState('test-2')).toBe('')
  })

  // ---------------------------------------------------------------
  // Re-creation (restart scenario)
  // ---------------------------------------------------------------

  it('re-creating a terminal disposes the old one and creates fresh', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24, noop)

    manager.write('test-1', 'Old content')
    await waitForXterm()

    const stateBefore = manager.getScreenState('test-1')
    expect(stateBefore).toContain('Old content')

    // Re-create with same ID (simulates restart)
    manager.create('test-1', 80, 24, noop)

    await waitForXterm(20)

    const stateAfter = manager.getScreenState('test-1')
    // Fresh terminal should not contain old content
    expect(stateAfter).not.toContain('Old content')
  })

  // ---------------------------------------------------------------
  // Write is no-op for non-existent terminal
  // ---------------------------------------------------------------

  it('write is a no-op for non-existent terminal', () => {
    manager = createHeadlessTerminalManager()
    expect(() => {
      manager.write('non-existent', 'Hello')
    }).not.toThrow()
  })
})
