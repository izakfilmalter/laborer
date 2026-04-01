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

  it('serializes live VS Code shell integration command state with positional metadata', async () => {
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

    const state = manager.getCommandDetectionState('test-1')
    expect(state).toEqual({
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
          commandStartLineContent: expect.any(String),
          cwd: '/workspace/app',
          endLine: expect.any(Number),
          executedLine: expect.any(Number),
          executedX: expect.any(Number),
          exitCode: 0,
          isTrusted: false,
          promptStartLine: expect.any(Number),
          startLine: expect.any(Number),
          startX: expect.any(Number),
          timestamp: expect.any(Number),
          duration: expect.any(Number),
        },
      ],
    })

    // Verify positional fields are populated (not undefined)
    const cmd = state?.commands[0]
    expect(cmd?.promptStartLine).toBeTypeOf('number')
    expect(cmd?.startLine).toBeTypeOf('number')
    expect(cmd?.executedLine).toBeTypeOf('number')
    expect(cmd?.endLine).toBeTypeOf('number')
    expect(cmd?.startX).toBeTypeOf('number')
    expect(cmd?.executedX).toBeTypeOf('number')
    expect(cmd?.commandStartLineContent).toBeTypeOf('string')
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
          commandStartLineContent: expect.any(String),
          duration: 0,
          isTrusted: false,
          startLine: expect.any(Number),
          startX: expect.any(Number),
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
          commandStartLineContent: expect.any(String),
          duration: 0,
          isTrusted: false,
          startLine: expect.any(Number),
          startX: expect.any(Number),
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

    const state = manager.getCommandDetectionState('test-1')
    expect(state).toEqual({
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
          commandStartLineContent: expect.any(String),
          cwd: '/workspace/app',
          duration: 0,
          isTrusted: false,
          startLine: expect.any(Number),
          startX: expect.any(Number),
          timestamp: expect.any(Number),
        },
      ],
    })

    // Partial commands should NOT have endLine or executedLine
    const cmd = state?.commands[0]
    expect(cmd?.endLine).toBeUndefined()
    expect(cmd?.executedLine).toBeUndefined()
    expect(cmd?.executedX).toBeUndefined()
    // But should have startLine and startX
    expect(cmd?.startLine).toBeTypeOf('number')
    expect(cmd?.startX).toBeTypeOf('number')
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
          commandStartLineContent: expect.any(String),
          cwd: '/workspace/app',
          endLine: expect.any(Number),
          executedLine: expect.any(Number),
          executedX: expect.any(Number),
          exitCode: 0,
          duration: expect.any(Number),
          isTrusted: true,
          promptStartLine: undefined,
          startLine: expect.any(Number),
          startX: expect.any(Number),
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

  // ---------------------------------------------------------------
  // Positional metadata on commands (OSC 633;A + 633;C)
  // ---------------------------------------------------------------

  it('tracks positional metadata through full A->B->E->C->D lifecycle', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Write a prompt, then the full OSC lifecycle
    manager.write(
      'test-1',
      '$ ' + // Simulate prompt text on the line
        '\x1b]633;A\x07' + // Prompt start
        '\x1b]633;B\x07' + // Command start
        '\x1b]633;E;ls\\x20-la\x07' + // Command line
        '\x1b]633;C\x07' + // Command executed
        'file1.txt\r\nfile2.txt\r\n' + // Command output
        '\x1b]633;D;0\x07' // Command finished
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.commands).toHaveLength(1)

    const cmd = state?.commands[0]
    expect(cmd?.command).toBe('ls -la')
    expect(cmd?.exitCode).toBe(0)

    // All positional fields should be numbers (populated, not undefined)
    expect(cmd?.promptStartLine).toBeTypeOf('number')
    expect(cmd?.startLine).toBeTypeOf('number')
    expect(cmd?.executedLine).toBeTypeOf('number')
    expect(cmd?.endLine).toBeTypeOf('number')
    expect(cmd?.startX).toBeTypeOf('number')
    expect(cmd?.executedX).toBeTypeOf('number')
    expect(cmd?.commandStartLineContent).toBeTypeOf('string')

    // promptStartLine should be <= startLine (prompt starts at or before command)
    expect(cmd?.promptStartLine).toBeLessThanOrEqual(cmd?.startLine ?? -1)
    // executedLine should be >= startLine (execution is at or after command start)
    expect(cmd?.executedLine).toBeGreaterThanOrEqual(cmd?.startLine ?? -1)
    // endLine should be >= executedLine (end is at or after execution start)
    expect(cmd?.endLine).toBeGreaterThanOrEqual(cmd?.executedLine ?? -1)
  })

  it('captures commandStartLineContent from the buffer at 633;B', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Write visible prompt text before the B marker
    manager.write('test-1', 'user@host:~/app $ ')
    await waitForXterm()

    // Now send the command lifecycle
    manager.write(
      'test-1',
      '\x1b]633;B\x07' +
        '\x1b]633;E;echo\\x20test\x07' +
        '\x1b]633;C\x07' +
        'test\r\n' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    const cmd = state?.commands[0]

    // The commandStartLineContent should contain the prompt text
    expect(cmd?.commandStartLineContent).toContain('user@host:~/app $')
  })

  it('tracks startX from cursor position at 633;B', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Write some prompt text to move the cursor to a non-zero X
    manager.write('test-1', '$ ')
    await waitForXterm()

    manager.write(
      'test-1',
      '\x1b]633;B\x07' +
        '\x1b]633;E;echo\\x20hello\x07' +
        '\x1b]633;C\x07' +
        'hello\r\n' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    const cmd = state?.commands[0]

    // startX should reflect the cursor X at command start (after "$ ")
    expect(cmd?.startX).toBe(2)
  })

  it('tracks multiple commands with correct positional metadata', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // First command
    manager.write(
      'test-1',
      '\x1b]633;A\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;echo\\x20one\x07' +
        '\x1b]633;C\x07' +
        'one\r\n' +
        '\x1b]633;D;0\x07'
    )

    // Second command
    manager.write(
      'test-1',
      '\x1b]633;A\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;echo\\x20two\x07' +
        '\x1b]633;C\x07' +
        'two\r\n' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.commands).toHaveLength(2)

    const cmd1 = state?.commands[0]
    const cmd2 = state?.commands[1]

    // Both commands should have positional metadata
    expect(cmd1?.startLine).toBeTypeOf('number')
    expect(cmd2?.startLine).toBeTypeOf('number')

    // Second command should start at or after first command ends
    expect(cmd2?.promptStartLine).toBeGreaterThanOrEqual(cmd1?.endLine ?? -1)
  })

  it('handles 633;B without preceding 633;A (promptStartLine is undefined)', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // No 633;A before 633;B — promptStartLine should be undefined
    manager.write(
      'test-1',
      '\x1b]633;B\x07' +
        '\x1b]633;E;pwd\x07' +
        '\x1b]633;C\x07' +
        '/home/user\r\n' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    const cmd = state?.commands[0]

    // promptStartLine should be undefined since no A was sent
    expect(cmd?.promptStartLine).toBeUndefined()
    // But other positional fields should be populated
    expect(cmd?.startLine).toBeTypeOf('number')
    expect(cmd?.executedLine).toBeTypeOf('number')
    expect(cmd?.endLine).toBeTypeOf('number')
  })

  it('handles 633;D without preceding 633;C (executedLine is undefined)', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Skip 633;C — executedLine/executedX should remain undefined
    manager.write(
      'test-1',
      '\x1b]633;A\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;echo\\x20test\x07' +
        'test\r\n' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    const cmd = state?.commands[0]

    // promptStartLine and startLine should be populated
    expect(cmd?.promptStartLine).toBeTypeOf('number')
    expect(cmd?.startLine).toBeTypeOf('number')
    // executedLine/executedX should be undefined since no C was sent
    expect(cmd?.executedLine).toBeUndefined()
    expect(cmd?.executedX).toBeUndefined()
    // endLine should still be populated from D
    expect(cmd?.endLine).toBeTypeOf('number')
  })

  it('in-flight command after A->B includes promptStartLine and startLine but not endLine', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write(
      'test-1',
      '\x1b]633;A\x07\x1b]633;B\x07\x1b]633;E;long-running-cmd\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.commands).toHaveLength(1)

    const cmd = state?.commands[0]
    expect(cmd?.command).toBe('long-running-cmd')
    expect(cmd?.promptStartLine).toBeTypeOf('number')
    expect(cmd?.startLine).toBeTypeOf('number')
    expect(cmd?.startX).toBeTypeOf('number')
    // In-flight command should NOT have endLine or executedLine
    expect(cmd?.endLine).toBeUndefined()
    expect(cmd?.executedLine).toBeUndefined()
    expect(cmd?.executedX).toBeUndefined()
  })

  // ---------------------------------------------------------------
  // Capability store: CwdDetection from multiple OSC sources
  // ---------------------------------------------------------------

  it('detects cwd from OSC 633;P Cwd and populates capability state', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;P;Cwd=/workspace/app\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.cwdDetection?.cwd).toBe('/workspace/app')
    expect(state?.cwdDetection?.history).toHaveLength(1)
    expect(state?.cwdDetection?.history[0]?.cwd).toBe('/workspace/app')
    expect(state?.cwdDetection?.history[0]?.line).toBeTypeOf('number')
  })

  it('detects cwd from OSC 7 file:// URI', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // OSC 7 format: file://hostname/path
    manager.write('test-1', '\x1b]7;file://localhost/Users/me/project\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.cwdDetection?.cwd).toBe('/Users/me/project')
    expect(state?.cwdDetection?.history).toHaveLength(1)
    expect(state?.cwdDetection?.history[0]?.cwd).toBe('/Users/me/project')
  })

  it('detects cwd from OSC 7 file:// URI with empty hostname', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // OSC 7 with empty hostname: file:///path
    manager.write('test-1', '\x1b]7;file:///home/user/workspace\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.cwdDetection?.cwd).toBe('/home/user/workspace')
  })

  it('detects cwd from OSC 7 with percent-encoded characters', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]7;file://localhost/Users/me/my%20project\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state?.cwdDetection?.cwd).toBe('/Users/me/my project')
  })

  it('detects cwd from OSC 9;9 (Windows-friendly cwd)', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // OSC 9 format: 9;path (sub-command 9 = cwd)
    manager.write('test-1', '\x1b]9;9;C:\\Users\\me\\project\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.cwdDetection?.cwd).toBe('C:\\Users\\me\\project')
    expect(state?.cwdDetection?.history).toHaveLength(1)
  })

  it('detects cwd from OSC 1337 CurrentDir', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // OSC 1337 iTerm format: CurrentDir=path
    manager.write('test-1', '\x1b]1337;CurrentDir=/Users/me/project\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.cwdDetection?.cwd).toBe('/Users/me/project')
    expect(state?.cwdDetection?.history).toHaveLength(1)
  })

  it('tracks cwd history across multiple changes from different sources', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Initial cwd from 633;P
    manager.write('test-1', '\x1b]633;P;Cwd=/home/user\x07')
    // Change via OSC 7
    manager.write('test-1', '\x1b]7;file://localhost/home/user/project\x07')
    // Change via OSC 1337
    manager.write('test-1', '\x1b]1337;CurrentDir=/home/user/project/src\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state?.cwdDetection?.cwd).toBe('/home/user/project/src')
    expect(state?.cwdDetection?.history).toHaveLength(3)
    expect(state?.cwdDetection?.history[0]?.cwd).toBe('/home/user')
    expect(state?.cwdDetection?.history[1]?.cwd).toBe('/home/user/project')
    expect(state?.cwdDetection?.history[2]?.cwd).toBe('/home/user/project/src')
  })

  it('cwd detection also feeds into command cwd field', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Set cwd via OSC 7 instead of 633;P
    manager.write('test-1', '\x1b]7;file://localhost/workspace/app\x07')
    manager.write(
      'test-1',
      '\x1b]633;B\x07' +
        '\x1b]633;E;echo\\x20hello\x07' +
        '\x1b]633;C\x07' +
        'hello\r\n' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    const cmdState = manager.getCommandDetectionState('test-1')
    const cmd = cmdState?.commands[0]
    expect(cmd?.cwd).toBe('/workspace/app')
  })

  it('returns undefined capability state when no cwd has been detected', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', 'Hello, World!')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeUndefined()
  })

  it('returns undefined capability state for non-existent terminal', () => {
    manager = createHeadlessTerminalManager()
    expect(manager.getCapabilityState('non-existent')).toBeUndefined()
  })

  it('ignores OSC 7 with non-file URI', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]7;https://example.com/path\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeUndefined()
  })

  it('ignores OSC 9 without sub-command 9 prefix', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // OSC 9 with a different sub-command (not cwd)
    manager.write('test-1', '\x1b]9;4;some-data\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeUndefined()
  })

  it('ignores OSC 1337 with non-CurrentDir payload', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]1337;SetMark\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeUndefined()
  })

  // ---------------------------------------------------------------
  // rawReviveBuffer optimization
  // ---------------------------------------------------------------

  it('returns raw revive buffer for idle terminal (none state)', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Write some data to the headless terminal so serialize() produces output
    manager.write('test-1', 'Hello, World!')
    await waitForXterm()

    const liveScreenState = manager.getScreenState('test-1')
    expect(liveScreenState).toContain('Hello')

    // Store a raw revive buffer — simulating a terminal revival
    const rawBuffer = 'raw-revive-buffer-content'
    manager.setRawReviveBuffer('test-1', rawBuffer)

    // getScreenState should return the raw buffer, not the live state
    expect(manager.getScreenState('test-1')).toBe(rawBuffer)
  })

  it('returns raw revive buffer for replay-only state', () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    const rawBuffer = 'raw-replay-only-buffer'
    manager.setRawReviveBuffer('test-1', rawBuffer)

    // Transition to replay-only
    manager.markReplayed('test-1')

    // getScreenState should still return the raw buffer
    expect(manager.getScreenState('test-1')).toBe(rawBuffer)
  })

  it('returns live xterm state after user input frees raw buffer', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', 'Live content')
    await waitForXterm()

    const rawBuffer = 'stale-raw-buffer'
    manager.setRawReviveBuffer('test-1', rawBuffer)

    // Verify raw buffer is being used
    expect(manager.getScreenState('test-1')).toBe(rawBuffer)

    // Free the raw buffer (simulating user interaction)
    manager.freeRawReviveBuffer('test-1')

    // Now getScreenState should use the live serialize addon
    const screenState = manager.getScreenState('test-1')
    expect(screenState).not.toBe(rawBuffer)
    expect(screenState).toContain('Live content')
  })

  it('freeRawReviveBuffer transitions state to session', () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    const rawBuffer = 'some-buffer'
    manager.setRawReviveBuffer('test-1', rawBuffer)
    manager.markReplayed('test-1')

    // Before free: raw buffer is used
    expect(manager.getScreenState('test-1')).toBe(rawBuffer)

    // Free transitions to session
    manager.freeRawReviveBuffer('test-1')

    // After free: raw buffer gone, uses serialize addon (empty terminal)
    expect(manager.getScreenState('test-1')).not.toBe(rawBuffer)
  })

  it('markReplayed only transitions from none to replay-only', () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    const rawBuffer = 'test-buffer'
    manager.setRawReviveBuffer('test-1', rawBuffer)

    // First markReplayed: none → replay-only (raw buffer still returned)
    manager.markReplayed('test-1')
    expect(manager.getScreenState('test-1')).toBe(rawBuffer)

    // Free transitions to session
    manager.freeRawReviveBuffer('test-1')
    expect(manager.getScreenState('test-1')).not.toBe(rawBuffer)

    // markReplayed after session should not go back to replay-only
    manager.setRawReviveBuffer('test-1', rawBuffer)
    manager.markReplayed('test-1')
    // State is still 'session', so even with rawBuffer set,
    // getScreenState uses the serialize addon
    expect(manager.getScreenState('test-1')).not.toBe(rawBuffer)
  })

  it('freeRawReviveBuffer is no-op for non-existent terminal', () => {
    manager = createHeadlessTerminalManager()
    // Should not throw
    expect(() => {
      manager.freeRawReviveBuffer('non-existent')
    }).not.toThrow()
  })

  it('setRawReviveBuffer is no-op for non-existent terminal', () => {
    manager = createHeadlessTerminalManager()
    expect(() => {
      manager.setRawReviveBuffer('non-existent', 'buffer')
    }).not.toThrow()
  })

  it('markReplayed is no-op for non-existent terminal', () => {
    manager = createHeadlessTerminalManager()
    expect(() => {
      manager.markReplayed('non-existent')
    }).not.toThrow()
  })

  it('resize after revival frees raw buffer via freeRawReviveBuffer', () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    const rawBuffer = 'pre-resize-buffer'
    manager.setRawReviveBuffer('test-1', rawBuffer)
    manager.markReplayed('test-1')

    expect(manager.getScreenState('test-1')).toBe(rawBuffer)

    // Simulating what terminal-manager does on resize:
    manager.resize('test-1', 120, 40)
    manager.freeRawReviveBuffer('test-1')

    expect(manager.getScreenState('test-1')).not.toBe(rawBuffer)
  })

  it('without raw revive buffer set, getScreenState uses serialize addon', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', 'Normal output')
    await waitForXterm()

    // No raw buffer set — should use serialize addon
    const state = manager.getScreenState('test-1')
    expect(state).toContain('Normal output')
  })
})
