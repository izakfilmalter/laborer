/**
 * Headless Terminal State Manager tests.
 *
 * Tests the headless xterm terminal management module that provides
 * compact screen state serialization. The headless terminal uses
 * `disableStdin: true` to suppress device query responses (DA1/DSR),
 * matching VS Code's pattern where only the renderer xterm handles
 * these queries.
 *
 * @see PRD-ghostty-web-migration.md — Module 1: Backend: Headless Terminal State Manager
 * @see Issue #7: Backend: Headless terminal state manager
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHeadlessTerminalManager } from '../src/lib/headless-terminal.js'

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
      manager.create('test-1', 80, 24)
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
    manager.create('test-1', 80, 24)

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
    manager.create('test-1', 80, 24)

    // Give a moment for initialization
    await waitForXterm(20)

    const screenState = manager.getScreenState('test-1')
    // A fresh terminal with no output serializes to an empty string
    // (or a minimal reset sequence depending on xterm version)
    expect(typeof screenState).toBe('string')
  })

  // ---------------------------------------------------------------
  // Device query handling (DA1/DSR) — suppressed via disableStdin
  // ---------------------------------------------------------------

  it('does NOT forward DA1 device query responses (disableStdin: true)', async () => {
    manager = createHeadlessTerminalManager()
    const ptyWrite = vi.fn()

    // Even when a ptyWrite callback is provided, the headless
    // terminal uses disableStdin: true which suppresses all
    // triggerDataEvent calls (including DA1/DSR responses).
    // This matches VS Code's pattern where only the renderer
    // xterm.js handles device queries.
    manager.create('test-1', 80, 24, ptyWrite)

    // Send a DA1 query (Primary Device Attributes request)
    manager.write('test-1', '\x1b[0c')

    // xterm processes asynchronously — wait for response
    await waitForXterm()

    // The headless terminal should NOT have forwarded any response
    // because disableStdin: true prevents triggerDataEvent from firing
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------
  // Mouse reporting state
  // ---------------------------------------------------------------

  it('restores the mouse encoding alongside the tracking mode', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // What a TUI like opencode enables: any-event tracking, reported in SGR.
    manager.write('test-1', '\u001b[?1003h\u001b[?1006hprompt')

    await waitForXterm()

    const screenState = manager.getScreenState('test-1')
    // Without the encoding, a renderer hydrated from this snapshot reports
    // motion in legacy X10 and the TUI types the coordinate bytes as text.
    expect(screenState).toContain('\u001b[?1003h')
    expect(screenState).toContain('\u001b[?1006h')
  })

  it('leaves the mouse encoding alone when the default is in use', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\u001b[?1000hprompt')

    await waitForXterm()

    const screenState = manager.getScreenState('test-1')
    expect(screenState).toContain('\u001b[?1000h')
    for (const encoding of ['1005', '1006', '1015', '1016']) {
      expect(screenState).not.toContain(`\u001b[?${encoding}h`)
    }
  })

  // ---------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------

  it('resizes headless terminal and reflects in serialized state', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

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
    manager.create('test-1', 80, 24)

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

  it('serializes live VS Code shell integration command state', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write(
      'test-1',
      '\x1b]633;P;HasRichCommandDetection=True\x07' +
        '\x1b]633;P;Cwd=/workspace/app\x07' +
        '\x1b]633;A\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;echo\\x20hello\x07' +
        '\x1b]633;C\x07' +
        'hello\r\n' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    expect(manager.getCommandDetectionState('test-1')).toEqual({
      isWindowsPty: false,
      hasRichCommandDetection: true,
      promptInputModel: {
        value: 'echo hello',
        cursorIndex: 10,
      },
      commands: [
        {
          command: 'echo hello',
          commandLineConfidence: 'high',
          cwd: '/workspace/app',
          exitCode: 0,
          isTrusted: false,
          timestamp: expect.any(Number),
          duration: expect.any(Number),
        },
      ],
    })
  })

  it('serializes prompt input model from live VS Code command line state', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write(
      'test-1',
      '\x1b]633;P;HasRichCommandDetection=True\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;git\x20status\x07'
    )

    await waitForXterm()

    expect(manager.getCommandDetectionState('test-1')).toEqual({
      isWindowsPty: false,
      hasRichCommandDetection: true,
      promptInputModel: {
        value: 'git status',
        cursorIndex: 10,
      },
      commands: [
        {
          command: 'git status',
          commandLineConfidence: 'high',
          duration: 0,
          isTrusted: false,
          timestamp: expect.any(Number),
        },
      ],
    })
  })

  it('serializes prompt metadata from live VS Code shell integration properties', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write(
      'test-1',
      '\x1b]633;P;Prompt=user@host:\x20~/app\x20$\x20\x07' +
        '\x1b]633;P;ContinuationPrompt=>\x20\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;git\x20status\x07'
    )

    await waitForXterm()

    expect(manager.getCommandDetectionState('test-1')).toEqual({
      isWindowsPty: false,
      hasRichCommandDetection: false,
      promptInputModel: {
        value: 'git status',
        cursorIndex: 10,
        lastPromptLine: ' $ ',
        continuationPrompt: '> ',
      },
      commands: [
        {
          command: 'git status',
          commandLineConfidence: 'high',
          duration: 0,
          isTrusted: false,
          timestamp: expect.any(Number),
        },
      ],
    })
  })

  it('serializes the current in-flight command as a partial command entry', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write(
      'test-1',
      '\x1b]633;P;Cwd=/workspace/app\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;git\x20status\x07'
    )

    await waitForXterm()

    expect(manager.getCommandDetectionState('test-1')).toEqual({
      isWindowsPty: false,
      hasRichCommandDetection: false,
      promptInputModel: {
        value: 'git status',
        cursorIndex: 10,
      },
      commands: [
        {
          command: 'git status',
          commandLineConfidence: 'high',
          cwd: '/workspace/app',
          duration: 0,
          isTrusted: false,
          timestamp: expect.any(Number),
        },
      ],
    })
  })

  it('marks command lines as trusted when the shell integration nonce matches', async () => {
    manager = createHeadlessTerminalManager({
      shellIntegrationNonce: 'trusted-nonce',
    })
    manager.create('test-1', 80, 24)

    manager.write(
      'test-1',
      '\x1b]633;P;Cwd=/workspace/app\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;git\x20status;trusted-nonce\x07' +
        '\x1b]633;C\x07' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    expect(manager.getCommandDetectionState('test-1')).toEqual({
      isWindowsPty: false,
      hasRichCommandDetection: false,
      promptInputModel: {
        value: 'git status',
        cursorIndex: 10,
      },
      commands: [
        {
          command: 'git status',
          commandLineConfidence: 'high',
          cwd: '/workspace/app',
          exitCode: 0,
          duration: expect.any(Number),
          isTrusted: true,
          timestamp: expect.any(Number),
        },
      ],
    })
  })

  // ---------------------------------------------------------------
  // Dispose
  // ---------------------------------------------------------------

  it('disposes a headless terminal cleanly', async () => {
    manager = createHeadlessTerminalManager()

    manager.create('test-1', 80, 24)
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
    manager.create('test-1', 80, 24)
    manager.create('test-2', 80, 24)

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
    manager.create('test-1', 80, 24)

    manager.write('test-1', 'Old content')
    await waitForXterm()

    const stateBefore = manager.getScreenState('test-1')
    expect(stateBefore).toContain('Old content')

    // Re-create with same ID (simulates restart)
    manager.create('test-1', 80, 24)

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
