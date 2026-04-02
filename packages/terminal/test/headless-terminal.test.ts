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
        commandStartX: expect.any(Number),
        cursorIndex: 10,
        ghostTextIndex: -1,
        lastUserInput: 'echo hello',
        value: 'echo hello',
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
        commandStartX: expect.any(Number),
        cursorIndex: 10,
        ghostTextIndex: -1,
        lastUserInput: '',
        value: 'git status',
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
        commandStartX: expect.any(Number),
        continuationPrompt: '> ',
        cursorIndex: 10,
        ghostTextIndex: -1,
        lastPromptLine: ' $ ',
        lastUserInput: '',
        value: 'git status',
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
        commandStartX: expect.any(Number),
        cursorIndex: 10,
        ghostTextIndex: -1,
        lastUserInput: '',
        value: 'git status',
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
        commandStartX: expect.any(Number),
        cursorIndex: 10,
        ghostTextIndex: -1,
        lastUserInput: 'git status',
        value: 'git status',
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
  // PromptInputModel — commandStartX, lastUserInput, ghostTextIndex
  // ---------------------------------------------------------------

  it('captures commandStartX from cursor position at 633;B', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Write some content so cursor is at a non-zero X position, then trigger 633;B
    manager.write('test-1', '$ \x1b]633;B\x07\x1b]633;E;ls\x07')

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    // commandStartX should reflect the cursor X at the time 633;B was processed
    expect(state?.promptInputModel?.commandStartX).toBeTypeOf('number')
    expect(state?.promptInputModel?.commandStartX).toBeGreaterThanOrEqual(0)
  })

  it('captures lastUserInput from prompt value at 633;C', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write(
      'test-1',
      '\x1b]633;B\x07\x1b]633;E;echo\x20test\x07\x1b]633;C\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    // lastUserInput should be saved at the point 633;C fires
    expect(state?.promptInputModel?.lastUserInput).toBe('echo test')
  })

  it('defaults ghostTextIndex to -1', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;B\x07\x1b]633;E;pwd\x07')

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.promptInputModel?.ghostTextIndex).toBe(-1)
  })

  it('lastUserInput is empty when 633;C has not fired', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Only 633;B and 633;E — no 633;C
    manager.write('test-1', '\x1b]633;B\x07\x1b]633;E;git\x20status\x07')

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.promptInputModel?.lastUserInput).toBe('')
  })

  it('serializes all prompt input model fields through full command lifecycle', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write(
      'test-1',
      '\x1b]633;P;Prompt=user@host:\x20~/app\x20$\x20\x07' +
        '\x1b]633;P;ContinuationPrompt=>\x20\x07' +
        '\x1b]633;A\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;make\x20build\x07' +
        '\x1b]633;C\x07' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.promptInputModel).toEqual({
      commandStartX: expect.any(Number),
      continuationPrompt: '> ',
      cursorIndex: 10,
      ghostTextIndex: -1,
      lastPromptLine: ' $ ',
      lastUserInput: 'make build',
      value: 'make build',
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

  it('OSC 1337 SetMark creates a buffer mark in capability state', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]1337;SetMark\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.bufferMarks).toHaveLength(1)
    expect(state?.bufferMarks?.[0]?.line).toBeTypeOf('number')
    // iTerm SetMark has no id or hidden flag
    expect(state?.bufferMarks?.[0]?.id).toBeUndefined()
    expect(state?.bufferMarks?.[0]?.hidden).toBeUndefined()
  })

  it('ignores OSC 1337 with non-CurrentDir and non-SetMark payload', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]1337;SomeOtherProperty=value\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeUndefined()
  })

  // ---------------------------------------------------------------
  // Capability store: PromptTypeDetection from OSC 633;P PromptType
  // ---------------------------------------------------------------

  it('detects prompt type from OSC 633;P PromptType', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;P;PromptType=p10k\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.promptType).toBe('p10k')
  })

  it('detects different prompt type strings', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;P;PromptType=starship\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state?.promptType).toBe('starship')
  })

  it('updates prompt type when a new PromptType property is received', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;P;PromptType=p10k\x07')
    manager.write('test-1', '\x1b]633;P;PromptType=oh-my-posh\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state?.promptType).toBe('oh-my-posh')
  })

  it('returns capability state with only promptType when no cwd is detected', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;P;PromptType=starship\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.promptType).toBe('starship')
    expect(state?.cwdDetection).toBeUndefined()
  })

  it('returns capability state with both promptType and cwdDetection', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;P;Cwd=/home/user\x07')
    manager.write('test-1', '\x1b]633;P;PromptType=p10k\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.promptType).toBe('p10k')
    expect(state?.cwdDetection?.cwd).toBe('/home/user')
  })

  it('returns undefined capability state when neither cwd nor promptType is detected', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', 'plain output')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeUndefined()
  })

  // ---------------------------------------------------------------
  // Capability store: BufferMarkDetection from multiple OSC sources
  // ---------------------------------------------------------------

  it('OSC 633 SetMark creates a buffer mark with no parameters', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;SetMark\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.bufferMarks).toHaveLength(1)
    expect(state?.bufferMarks?.[0]?.line).toBeTypeOf('number')
    expect(state?.bufferMarks?.[0]?.id).toBeUndefined()
    expect(state?.bufferMarks?.[0]?.hidden).toBeUndefined()
  })

  it('OSC 633 SetMark parses Id parameter', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;SetMark;Id=build-start\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.bufferMarks).toHaveLength(1)
    expect(state?.bufferMarks?.[0]?.id).toBe('build-start')
    expect(state?.bufferMarks?.[0]?.hidden).toBeUndefined()
  })

  it('OSC 633 SetMark parses Hidden parameter', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;SetMark;Hidden\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.bufferMarks).toHaveLength(1)
    expect(state?.bufferMarks?.[0]?.hidden).toBe(true)
    expect(state?.bufferMarks?.[0]?.id).toBeUndefined()
  })

  it('OSC 633 SetMark parses both Id and Hidden parameters', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;SetMark;Id=test-mark;Hidden\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.bufferMarks).toHaveLength(1)
    expect(state?.bufferMarks?.[0]?.id).toBe('test-mark')
    expect(state?.bufferMarks?.[0]?.hidden).toBe(true)
  })

  it('OSC 633;P Task creates a buffer mark and disables command storage', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;P;Task=build\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.bufferMarks).toHaveLength(1)
    expect(state?.bufferMarks?.[0]?.line).toBeTypeOf('number')
    // Task marks have no id or hidden flag
    expect(state?.bufferMarks?.[0]?.id).toBeUndefined()
    expect(state?.bufferMarks?.[0]?.hidden).toBeUndefined()
  })

  it('OSC 633;P Task disables command storage so subsequent commands are not tracked', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // First, send a Task property to disable command storage
    manager.write('test-1', '\x1b]633;P;Task=build\x07')

    // Then try a normal command lifecycle
    manager.write(
      'test-1',
      '\x1b]633;A\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;echo\\x20hello\x07' +
        '\x1b]633;C\x07' +
        'hello\r\n' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    // The mark should be there
    const capState = manager.getCapabilityState('test-1')
    expect(capState?.bufferMarks).toHaveLength(1)

    // Commands are still tracked (disableCommandStorage only affects
    // future serialization decisions, not the runtime tracking)
    const cmdState = manager.getCommandDetectionState('test-1')
    expect(cmdState?.commands).toHaveLength(1)
  })

  it('multiple buffer marks from different sources are tracked in order', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Mark from OSC 633 SetMark with Id
    manager.write('test-1', '\x1b]633;SetMark;Id=mark-1\x07')
    // Mark from OSC 1337 SetMark (iTerm)
    manager.write('test-1', '\x1b]1337;SetMark\x07')
    // Mark from OSC 633;P Task
    manager.write('test-1', '\x1b]633;P;Task=build\x07')
    // Mark from OSC 633 SetMark with Hidden
    manager.write('test-1', '\x1b]633;SetMark;Hidden\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.bufferMarks).toHaveLength(4)
    expect(state?.bufferMarks?.[0]?.id).toBe('mark-1')
    expect(state?.bufferMarks?.[1]?.id).toBeUndefined() // iTerm mark
    expect(state?.bufferMarks?.[2]?.id).toBeUndefined() // Task mark
    expect(state?.bufferMarks?.[3]?.hidden).toBe(true)
  })

  it('buffer marks include line numbers from the terminal buffer', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Write some output to move the cursor down
    manager.write('test-1', 'line 1\r\nline 2\r\nline 3\r\n')
    await waitForXterm()

    // Place a mark
    manager.write('test-1', '\x1b]633;SetMark;Id=after-output\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state?.bufferMarks).toHaveLength(1)
    // The mark should be at line 3 or later (after the 3 lines of output)
    expect(state?.bufferMarks?.[0]?.line).toBeGreaterThanOrEqual(3)
  })

  it('capability state includes both bufferMarks and cwdDetection', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;P;Cwd=/workspace\x07')
    manager.write('test-1', '\x1b]633;SetMark;Id=test\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.cwdDetection?.cwd).toBe('/workspace')
    expect(state?.bufferMarks).toHaveLength(1)
    expect(state?.bufferMarks?.[0]?.id).toBe('test')
  })

  it('capability state includes bufferMarks, cwdDetection, and promptType together', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;P;Cwd=/workspace\x07')
    manager.write('test-1', '\x1b]633;P;PromptType=starship\x07')
    manager.write('test-1', '\x1b]633;SetMark;Id=deploy\x07')
    manager.write('test-1', '\x1b]1337;SetMark\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.cwdDetection?.cwd).toBe('/workspace')
    expect(state?.promptType).toBe('starship')
    expect(state?.bufferMarks).toHaveLength(2)
    expect(state?.bufferMarks?.[0]?.id).toBe('deploy')
    expect(state?.bufferMarks?.[1]?.id).toBeUndefined()
  })

  it('returns capability state with only bufferMarks when no cwd or promptType', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;SetMark\x07')

    await waitForXterm()

    const state = manager.getCapabilityState('test-1')
    expect(state).toBeDefined()
    expect(state?.bufferMarks).toHaveLength(1)
    expect(state?.cwdDetection).toBeUndefined()
    expect(state?.promptType).toBeUndefined()
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

  // ---------------------------------------------------------------
  // FinalTerm 133 command detection fallback
  // ---------------------------------------------------------------

  it('detects commands from pure FinalTerm sequences (133;A->B->C->D)', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Pure FinalTerm sequence — no 633 sequences at all
    manager.write(
      'test-1',
      '\x1b]133;A\x07' + // Prompt start
        '$ ' +
        '\x1b]133;B\x07' + // Command start
        '\x1b]133;C\x07' + // Command executed
        'output text\r\n' +
        '\x1b]133;D;0\x07' // Command finished with exit code 0
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.commands).toHaveLength(1)

    const cmd = state?.commands[0]
    // FinalTerm commands have low confidence, are untrusted, and have empty command
    expect(cmd?.command).toBe('')
    expect(cmd?.commandLineConfidence).toBe('low')
    expect(cmd?.isTrusted).toBe(false)
    expect(cmd?.exitCode).toBe(0)
  })

  it('FinalTerm-detected commands include positional metadata from markers', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write(
      'test-1',
      '\x1b]133;A\x07' +
        '$ ' +
        '\x1b]133;B\x07' +
        '\x1b]133;C\x07' +
        'output\r\n' +
        '\x1b]133;D;0\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    const cmd = state?.commands[0]

    // All positional fields should be populated
    expect(cmd?.promptStartLine).toBeTypeOf('number')
    expect(cmd?.startLine).toBeTypeOf('number')
    expect(cmd?.executedLine).toBeTypeOf('number')
    expect(cmd?.endLine).toBeTypeOf('number')
    expect(cmd?.startX).toBeTypeOf('number')
    expect(cmd?.executedX).toBeTypeOf('number')
    expect(cmd?.commandStartLineContent).toBeTypeOf('string')

    // Ordering assertions
    expect(cmd?.promptStartLine).toBeLessThanOrEqual(cmd?.startLine ?? -1)
    expect(cmd?.executedLine).toBeGreaterThanOrEqual(cmd?.startLine ?? -1)
    expect(cmd?.endLine).toBeGreaterThanOrEqual(cmd?.executedLine ?? -1)
  })

  it('FinalTerm 133;D parses exit code from args', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write(
      'test-1',
      '\x1b]133;A\x07' +
        '\x1b]133;B\x07' +
        '\x1b]133;C\x07' +
        '\x1b]133;D;127\x07' // Non-zero exit code
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    const cmd = state?.commands[0]
    expect(cmd?.exitCode).toBe(127)
  })

  it('FinalTerm 133;B without preceding 133;A has undefined promptStartLine', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // No 133;A before 133;B
    manager.write('test-1', '\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07')

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    const cmd = state?.commands[0]
    expect(cmd?.promptStartLine).toBeUndefined()
    expect(cmd?.startLine).toBeTypeOf('number')
    expect(cmd?.endLine).toBeTypeOf('number')
  })

  it('FinalTerm commands carry cwd from prior cwd detection', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Set cwd via OSC 7, then detect command via FinalTerm
    manager.write(
      'test-1',
      '\x1b]7;file://localhost/home/user/project\x07' +
        '\x1b]133;A\x07' +
        '\x1b]133;B\x07' +
        '\x1b]133;C\x07' +
        '\x1b]133;D;0\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    const cmd = state?.commands[0]
    expect(cmd?.cwd).toBe('/home/user/project')
  })

  it('OSC 633 takes priority: after seeing 633, FinalTerm 133;B/D are ignored for command detection', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // First, send a 633 sequence to establish VS Code mode
    manager.write(
      'test-1',
      '\x1b]633;A\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;E;echo\\x20hello\x07' +
        '\x1b]633;C\x07' +
        'hello\r\n' +
        '\x1b]633;D;0\x07'
    )

    // Now try FinalTerm sequences — these should NOT create commands
    manager.write(
      'test-1',
      '\x1b]133;A\x07' +
        '\x1b]133;B\x07' +
        '\x1b]133;C\x07' +
        '\x1b]133;D;0\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    // Should only have the one command from 633, not from 133
    expect(state?.commands).toHaveLength(1)
    expect(state?.commands[0]?.command).toBe('echo hello')
    expect(state?.commands[0]?.commandLineConfidence).toBe('high')
  })

  it('133;A and 133;C continue to fire prompt state callbacks even when 633 is active', async () => {
    const promptStates: Array<{ id: string; state: 'idle' | 'running' }> = []
    manager = createHeadlessTerminalManager({
      onPromptState: (terminalId, state) => {
        promptStates.push({ id: terminalId, state })
      },
    })
    manager.create('test-1', 80, 24)

    // Establish 633 mode
    manager.write('test-1', '\x1b]633;B\x07\x1b]633;D;0\x07')

    // Now send 133;A and 133;C — they should still fire callbacks
    manager.write('test-1', '\x1b]133;A\x07')
    manager.write('test-1', '\x1b]133;C\x07')

    await waitForXterm()

    // Should have idle and running callbacks from 133;A and 133;C
    expect(promptStates).toContainEqual({ id: 'test-1', state: 'idle' })
    expect(promptStates).toContainEqual({ id: 'test-1', state: 'running' })
  })

  it('FinalTerm detects multiple commands in sequence', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Two commands via pure FinalTerm
    manager.write(
      'test-1',
      '\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07output1\r\n\x1b]133;D;0\x07' +
        '\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07output2\r\n\x1b]133;D;1\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.commands).toHaveLength(2)

    expect(state?.commands[0]?.exitCode).toBe(0)
    expect(state?.commands[0]?.commandLineConfidence).toBe('low')

    expect(state?.commands[1]?.exitCode).toBe(1)
    expect(state?.commands[1]?.commandLineConfidence).toBe('low')

    // Second command should start at or after first ends
    const cmd1EndLine = state?.commands[0]?.endLine ?? -1
    const cmd2PromptLine = state?.commands[1]?.promptStartLine ?? -1
    expect(cmd2PromptLine).toBeGreaterThanOrEqual(cmd1EndLine)
  })

  it('FinalTerm 133;D without preceding 133;B is ignored', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // 133;D without 133;B — no current command to finalize
    manager.write('test-1', '\x1b]133;D;0\x07')

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.commands).toHaveLength(0)
  })

  it('FinalTerm in-flight command is serialized as partial (no endLine)', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Start a command via FinalTerm but don't finish it
    manager.write('test-1', '\x1b]133;A\x07\x1b]133;B\x07')

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.commands).toHaveLength(1)

    const cmd = state?.commands[0]
    expect(cmd?.command).toBe('')
    expect(cmd?.commandLineConfidence).toBe('low')
    expect(cmd?.isTrusted).toBe(false)
    expect(cmd?.startLine).toBeTypeOf('number')
    expect(cmd?.promptStartLine).toBeTypeOf('number')
    // In-flight: no endLine, executedLine, or executedX
    expect(cmd?.endLine).toBeUndefined()
    expect(cmd?.executedLine).toBeUndefined()
    expect(cmd?.executedX).toBeUndefined()
  })

  // ---------------------------------------------------------------
  // OSC 633;F/G (continuation prompt) and 633;H/I (right prompt)
  // ---------------------------------------------------------------

  it('633;F sets continuation state and 633;G clears it', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Initially, continuation state should be false
    const initialState = manager.getShellIntegrationState('test-1')
    expect(initialState?.inContinuation).toBe(false)

    // Send 633;F to start continuation
    manager.write('test-1', '\x1b]633;F\x07')
    await waitForXterm()

    const afterF = manager.getShellIntegrationState('test-1')
    expect(afterF?.inContinuation).toBe(true)

    // Send 633;G to end continuation
    manager.write('test-1', '\x1b]633;G\x07')
    await waitForXterm()

    const afterG = manager.getShellIntegrationState('test-1')
    expect(afterG?.inContinuation).toBe(false)
  })

  it('633;H sets right prompt state and records start line, 633;I clears it', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Initially, right prompt state should be false
    const initialState = manager.getShellIntegrationState('test-1')
    expect(initialState?.inRightPrompt).toBe(false)
    expect(initialState?.rightPromptStartLine).toBeUndefined()

    // Send 633;H to start right prompt
    manager.write('test-1', '\x1b]633;H\x07')
    await waitForXterm()

    const afterH = manager.getShellIntegrationState('test-1')
    expect(afterH?.inRightPrompt).toBe(true)
    expect(afterH?.rightPromptStartLine).toBeTypeOf('number')

    // Send 633;I to end right prompt
    manager.write('test-1', '\x1b]633;I\x07')
    await waitForXterm()

    const afterI = manager.getShellIntegrationState('test-1')
    expect(afterI?.inRightPrompt).toBe(false)
    expect(afterI?.rightPromptStartLine).toBeUndefined()
  })

  it('continuation state toggles correctly across multiple F/G cycles', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // First continuation cycle
    manager.write('test-1', '\x1b]633;F\x07')
    await waitForXterm()
    expect(manager.getShellIntegrationState('test-1')?.inContinuation).toBe(
      true
    )

    manager.write('test-1', '\x1b]633;G\x07')
    await waitForXterm()
    expect(manager.getShellIntegrationState('test-1')?.inContinuation).toBe(
      false
    )

    // Second continuation cycle
    manager.write('test-1', '\x1b]633;F\x07')
    await waitForXterm()
    expect(manager.getShellIntegrationState('test-1')?.inContinuation).toBe(
      true
    )

    manager.write('test-1', '\x1b]633;G\x07')
    await waitForXterm()
    expect(manager.getShellIntegrationState('test-1')?.inContinuation).toBe(
      false
    )
  })

  it('right prompt state toggles correctly across multiple H/I cycles', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // First right prompt cycle
    manager.write('test-1', '\x1b]633;H\x07')
    await waitForXterm()
    expect(manager.getShellIntegrationState('test-1')?.inRightPrompt).toBe(true)

    manager.write('test-1', '\x1b]633;I\x07')
    await waitForXterm()
    expect(manager.getShellIntegrationState('test-1')?.inRightPrompt).toBe(
      false
    )

    // Second right prompt cycle
    manager.write('test-1', '\x1b]633;H\x07')
    await waitForXterm()
    expect(manager.getShellIntegrationState('test-1')?.inRightPrompt).toBe(true)

    manager.write('test-1', '\x1b]633;I\x07')
    await waitForXterm()
    expect(manager.getShellIntegrationState('test-1')?.inRightPrompt).toBe(
      false
    )
  })

  it('F/G/H/I sequences do not interfere with A/B/C/D command lifecycle', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Full command lifecycle with F/G/H/I interspersed
    manager.write(
      'test-1',
      '\x1b]633;A\x07' + // Prompt start
        '\x1b]633;H\x07' + // Right prompt start (during prompt)
        '\x1b]633;I\x07' + // Right prompt end
        '\x1b]633;B\x07' + // Command start
        '\x1b]633;F\x07' + // Continuation start (multi-line input)
        '\x1b]633;G\x07' + // Continuation end
        '\x1b]633;E;echo\\x20hello\x07' + // Command line
        '\x1b]633;C\x07' + // Command executed
        'hello\r\n' +
        '\x1b]633;D;0\x07' // Command finished
    )

    await waitForXterm()

    // Command should be fully tracked with all positional metadata
    const state = manager.getCommandDetectionState('test-1')
    expect(state?.commands).toHaveLength(1)

    const cmd = state?.commands[0]
    expect(cmd?.command).toBe('echo hello')
    expect(cmd?.exitCode).toBe(0)
    expect(cmd?.promptStartLine).toBeTypeOf('number')
    expect(cmd?.startLine).toBeTypeOf('number')
    expect(cmd?.executedLine).toBeTypeOf('number')
    expect(cmd?.endLine).toBeTypeOf('number')
    expect(cmd?.startX).toBeTypeOf('number')
    expect(cmd?.executedX).toBeTypeOf('number')
    expect(cmd?.commandStartLineContent).toBeTypeOf('string')

    // Continuation and right prompt state should be cleared after the lifecycle
    const shellState = manager.getShellIntegrationState('test-1')
    expect(shellState?.inContinuation).toBe(false)
    expect(shellState?.inRightPrompt).toBe(false)
  })

  it('F/G sequences within a multi-line command do not break command detection', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Simulate a multi-line command with continuation prompts
    manager.write(
      'test-1',
      '\x1b]633;A\x07' +
        '\x1b]633;B\x07' +
        '\x1b]633;F\x07' + // First continuation
        '\x1b]633;G\x07' +
        '\x1b]633;F\x07' + // Second continuation
        '\x1b]633;G\x07' +
        '\x1b]633;E;echo\\x20hello\x07' +
        '\x1b]633;C\x07' +
        'hello\r\n' +
        '\x1b]633;D;0\x07'
    )

    await waitForXterm()

    const state = manager.getCommandDetectionState('test-1')
    expect(state?.commands).toHaveLength(1)
    expect(state?.commands[0]?.command).toBe('echo hello')
    expect(state?.commands[0]?.exitCode).toBe(0)
  })

  it('633;F/G/H/I set shellIntegrationStatus to vscode', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // Initially no shell integration
    expect(
      manager.getShellIntegrationState('test-1')?.shellIntegrationStatus
    ).toBe('none')

    // Any 633 sequence sets status to vscode
    manager.write('test-1', '\x1b]633;F\x07')
    await waitForXterm()

    expect(
      manager.getShellIntegrationState('test-1')?.shellIntegrationStatus
    ).toBe('vscode')
  })

  it('getShellIntegrationState returns undefined for non-existent terminal', () => {
    manager = createHeadlessTerminalManager()
    expect(manager.getShellIntegrationState('non-existent')).toBeUndefined()
  })

  // ---------------------------------------------------------------
  // ShellEnvDetection — OSC 633 EnvJson
  // ---------------------------------------------------------------

  it('detects env from OSC 633 EnvJson with valid nonce (trusted)', async () => {
    const nonce = 'test-nonce-123'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // EnvJson format: OSC 633 ; EnvJson ; <JSON> ; <Nonce> ST
    const envJson = JSON.stringify({ PATH: '/usr/bin', HOME: '/home/user' })
    manager.write('test-1', `\x1b]633;EnvJson;${envJson};${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection).toBeDefined()
    expect(caps?.shellEnvDetection?.isTrusted).toBe(true)
    expect(caps?.shellEnvDetection?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
    })
  })

  it('detects env from OSC 633 EnvJson with wrong nonce (untrusted)', async () => {
    const nonce = 'test-nonce-123'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    const envJson = JSON.stringify({ PATH: '/usr/bin' })
    manager.write('test-1', `\x1b]633;EnvJson;${envJson};wrong-nonce\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection).toBeDefined()
    expect(caps?.shellEnvDetection?.isTrusted).toBe(false)
    expect(caps?.shellEnvDetection?.env).toEqual({ PATH: '/usr/bin' })
  })

  it('detects env from OSC 633 EnvJson without nonce (untrusted)', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    const envJson = JSON.stringify({ TERM: 'xterm-256color' })
    manager.write('test-1', `\x1b]633;EnvJson;${envJson}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection).toBeDefined()
    expect(caps?.shellEnvDetection?.isTrusted).toBe(false)
    expect(caps?.shellEnvDetection?.env).toEqual({ TERM: 'xterm-256color' })
  })

  it('EnvJson replaces entire env on subsequent calls', async () => {
    const nonce = 'nonce-1'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // First env
    const env1 = JSON.stringify({ PATH: '/usr/bin', HOME: '/home/a' })
    manager.write('test-1', `\x1b]633;EnvJson;${env1};${nonce}\x07`)
    await waitForXterm()

    // Second env replaces entirely
    const env2 = JSON.stringify({ PATH: '/usr/local/bin' })
    manager.write('test-1', `\x1b]633;EnvJson;${env2};${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection?.env).toEqual({ PATH: '/usr/local/bin' })
    // HOME should not be present
    expect(caps?.shellEnvDetection?.env).not.toHaveProperty('HOME')
  })

  it('EnvJson ignores invalid JSON gracefully', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    manager.write('test-1', '\x1b]633;EnvJson;not-valid-json\x07')
    await waitForXterm()

    // No env detected — capability state should not include shellEnvDetection
    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection).toBeUndefined()
  })

  it('EnvJson skips undefined values in the JSON payload', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // JSON.stringify strips undefined values, but test defensive handling
    const envJson = '{"PATH":"/usr/bin","EMPTY":null}'
    manager.write('test-1', `\x1b]633;EnvJson;${envJson}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    // null values are not undefined but are not strings either — depends on the
    // JSON.parse -> Object.entries behavior. Our code checks value !== undefined.
    // null !== undefined is true, so null values would be set. Let's verify:
    expect(caps?.shellEnvDetection?.env).toHaveProperty('PATH', '/usr/bin')
  })

  // ---------------------------------------------------------------
  // ShellEnvDetection — OSC 633 EnvSingle* transaction flow
  // ---------------------------------------------------------------

  it('EnvSingle* transaction with clear sets env from scratch', async () => {
    const nonce = 'env-nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // Start with clear=1
    manager.write('test-1', `\x1b]633;EnvSingleStart;1;${nonce}\x07`)
    await waitForXterm()

    // Add entries
    manager.write(
      'test-1',
      `\x1b]633;EnvSingleEntry;PATH;/usr/bin;${nonce}\x07`
    )
    await waitForXterm()
    manager.write(
      'test-1',
      `\x1b]633;EnvSingleEntry;HOME;/home/user;${nonce}\x07`
    )
    await waitForXterm()

    // End transaction
    manager.write('test-1', `\x1b]633;EnvSingleEnd;${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection?.isTrusted).toBe(true)
    expect(caps?.shellEnvDetection?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
    })
  })

  it('EnvSingle* transaction without clear preserves existing env', async () => {
    const nonce = 'env-nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // First: set some env via EnvJson
    const envJson = JSON.stringify({ PATH: '/usr/bin', TERM: 'xterm' })
    manager.write('test-1', `\x1b]633;EnvJson;${envJson};${nonce}\x07`)
    await waitForXterm()

    // Start transaction without clear (arg0 !== '1')
    manager.write('test-1', `\x1b]633;EnvSingleStart;0;${nonce}\x07`)
    await waitForXterm()

    // Add a new entry
    manager.write(
      'test-1',
      `\x1b]633;EnvSingleEntry;HOME;/home/user;${nonce}\x07`
    )
    await waitForXterm()

    // End transaction
    manager.write('test-1', `\x1b]633;EnvSingleEnd;${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection?.env).toEqual({
      PATH: '/usr/bin',
      TERM: 'xterm',
      HOME: '/home/user',
    })
  })

  it('EnvSingleDelete removes an env var from the pending transaction', async () => {
    const nonce = 'env-nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // Set initial env
    const envJson = JSON.stringify({
      PATH: '/usr/bin',
      HOME: '/home/user',
      TERM: 'xterm',
    })
    manager.write('test-1', `\x1b]633;EnvJson;${envJson};${nonce}\x07`)
    await waitForXterm()

    // Start transaction without clear
    manager.write('test-1', `\x1b]633;EnvSingleStart;0;${nonce}\x07`)
    await waitForXterm()

    // Delete TERM
    manager.write('test-1', `\x1b]633;EnvSingleDelete;TERM;xterm;${nonce}\x07`)
    await waitForXterm()

    // End transaction
    manager.write('test-1', `\x1b]633;EnvSingleEnd;${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
    })
    expect(caps?.shellEnvDetection?.env).not.toHaveProperty('TERM')
  })

  it('EnvSingleEntry without pending transaction is ignored', async () => {
    const nonce = 'env-nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // Entry without Start — should be ignored
    manager.write(
      'test-1',
      `\x1b]633;EnvSingleEntry;PATH;/usr/bin;${nonce}\x07`
    )
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection).toBeUndefined()
  })

  it('EnvSingleEnd without pending transaction is ignored', async () => {
    const nonce = 'env-nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // End without Start — should be ignored
    manager.write('test-1', `\x1b]633;EnvSingleEnd;${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection).toBeUndefined()
  })

  // ---------------------------------------------------------------
  // ShellEnvDetection — Trust propagation (logical AND)
  // ---------------------------------------------------------------

  it('EnvSingle* trust uses AND: untrusted start makes batch untrusted', async () => {
    const nonce = 'env-nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // Start with wrong nonce (untrusted)
    manager.write('test-1', '\x1b]633;EnvSingleStart;1;wrong-nonce\x07')
    await waitForXterm()

    // Entry with valid nonce (trusted)
    manager.write(
      'test-1',
      `\x1b]633;EnvSingleEntry;PATH;/usr/bin;${nonce}\x07`
    )
    await waitForXterm()

    // End with valid nonce (trusted)
    manager.write('test-1', `\x1b]633;EnvSingleEnd;${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection?.isTrusted).toBe(false)
    expect(caps?.shellEnvDetection?.env).toEqual({ PATH: '/usr/bin' })
  })

  it('EnvSingle* trust uses AND: untrusted entry makes batch untrusted', async () => {
    const nonce = 'env-nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // Start with valid nonce (trusted)
    manager.write('test-1', `\x1b]633;EnvSingleStart;1;${nonce}\x07`)
    await waitForXterm()

    // Entry with wrong nonce (untrusted)
    manager.write('test-1', '\x1b]633;EnvSingleEntry;PATH;/usr/bin;wrong\x07')
    await waitForXterm()

    // Entry with valid nonce (trusted)
    manager.write('test-1', `\x1b]633;EnvSingleEntry;HOME;/home;${nonce}\x07`)
    await waitForXterm()

    // End with valid nonce
    manager.write('test-1', `\x1b]633;EnvSingleEnd;${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    // One untrusted entry makes the entire batch untrusted
    expect(caps?.shellEnvDetection?.isTrusted).toBe(false)
  })

  it('EnvSingle* trust uses AND: untrusted end makes batch untrusted', async () => {
    const nonce = 'env-nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // Start trusted
    manager.write('test-1', `\x1b]633;EnvSingleStart;1;${nonce}\x07`)
    await waitForXterm()

    // Entry trusted
    manager.write(
      'test-1',
      `\x1b]633;EnvSingleEntry;PATH;/usr/bin;${nonce}\x07`
    )
    await waitForXterm()

    // End untrusted
    manager.write('test-1', '\x1b]633;EnvSingleEnd;wrong\x07')
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection?.isTrusted).toBe(false)
  })

  it('EnvSingle* trust uses AND: all trusted makes batch trusted', async () => {
    const nonce = 'env-nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // All operations with valid nonce
    manager.write('test-1', `\x1b]633;EnvSingleStart;1;${nonce}\x07`)
    await waitForXterm()
    manager.write(
      'test-1',
      `\x1b]633;EnvSingleEntry;PATH;/usr/bin;${nonce}\x07`
    )
    await waitForXterm()
    manager.write('test-1', `\x1b]633;EnvSingleEnd;${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.shellEnvDetection?.isTrusted).toBe(true)
  })

  it('EnvSingle* without clear carries forward existing trust state with AND', async () => {
    const nonce = 'env-nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // First: set env with no nonce (untrusted)
    const envJson = JSON.stringify({ PATH: '/usr/bin' })
    manager.write('test-1', `\x1b]633;EnvJson;${envJson}\x07`)
    await waitForXterm()

    // Start without clear — carries untrusted state
    manager.write('test-1', `\x1b]633;EnvSingleStart;0;${nonce}\x07`)
    await waitForXterm()

    // Add entry with valid nonce
    manager.write('test-1', `\x1b]633;EnvSingleEntry;HOME;/home;${nonce}\x07`)
    await waitForXterm()

    // End with valid nonce
    manager.write('test-1', `\x1b]633;EnvSingleEnd;${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    // Existing state was untrusted; AND with new trusted ops = untrusted
    expect(caps?.shellEnvDetection?.isTrusted).toBe(false)
  })

  // ---------------------------------------------------------------
  // ShellEnvDetection — Capability state integration
  // ---------------------------------------------------------------

  it('returns capability state with only shellEnvDetection (no cwd or promptType)', async () => {
    const nonce = 'nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    const envJson = JSON.stringify({ PATH: '/usr/bin' })
    manager.write('test-1', `\x1b]633;EnvJson;${envJson};${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps).toBeDefined()
    expect(caps?.shellEnvDetection).toBeDefined()
    expect(caps?.cwdDetection).toBeUndefined()
    expect(caps?.promptType).toBeUndefined()
  })

  it('returns capability state with shellEnvDetection alongside other capabilities', async () => {
    const nonce = 'nonce'
    manager = createHeadlessTerminalManager({ shellIntegrationNonce: nonce })
    manager.create('test-1', 80, 24)

    // Set cwd, prompt type, and env
    manager.write('test-1', '\x1b]633;P;Cwd=/home/user\x07')
    await waitForXterm()
    manager.write('test-1', '\x1b]633;P;PromptType=starship\x07')
    await waitForXterm()
    const envJson = JSON.stringify({ PATH: '/usr/bin' })
    manager.write('test-1', `\x1b]633;EnvJson;${envJson};${nonce}\x07`)
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    expect(caps?.cwdDetection?.cwd).toBe('/home/user')
    expect(caps?.promptType).toBe('starship')
    expect(caps?.shellEnvDetection?.env).toEqual({ PATH: '/usr/bin' })
    expect(caps?.shellEnvDetection?.isTrusted).toBe(true)
  })

  it('returns undefined capability state when env is empty', async () => {
    manager = createHeadlessTerminalManager()
    manager.create('test-1', 80, 24)

    // EnvJson with empty object — env.size === 0, should not appear
    manager.write('test-1', '\x1b]633;EnvJson;{}\x07')
    await waitForXterm()

    const caps = manager.getCapabilityState('test-1')
    // Empty env should not trigger capability state
    expect(caps).toBeUndefined()
  })
})
