/**
 * Terminal Session Persistence Tests
 *
 * Verifies the replay buffer, serialization/deserialization, and
 * state restoration logic for terminal session persistence.
 *
 * @see packages/terminal/src/services/terminal-session-persistence.ts
 * @see Issue #18: Terminal session persistence across restarts
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHeadlessTerminalManager } from '../src/lib/headless-terminal.js'
import type { SerializedState } from '../src/services/terminal-session-persistence.js'
import {
  createTerminalSessionPersistence,
  DEFAULT_REPLAY_BUFFER_SIZE,
  MAX_STATE_AGE_MS,
  PERSISTENCE_DIR,
  ReplayBuffer,
  STATE_FILE,
} from '../src/services/terminal-session-persistence.js'

// ---------------------------------------------------------------------------
// ReplayBuffer unit tests
// ---------------------------------------------------------------------------

describe('ReplayBuffer', () => {
  it('stores written data', () => {
    const buffer = new ReplayBuffer()
    buffer.write('Hello, ')
    buffer.write('world!')
    expect(buffer.getContents()).toBe('Hello, world!')
  })

  it('reports correct size', () => {
    const buffer = new ReplayBuffer()
    buffer.write('abc')
    expect(buffer.size).toBe(3)
    buffer.write('def')
    expect(buffer.size).toBe(6)
  })

  it('clears buffer contents', () => {
    const buffer = new ReplayBuffer()
    buffer.write('data')
    buffer.clear()
    expect(buffer.getContents()).toBe('')
    expect(buffer.size).toBe(0)
  })

  it('trims older content when exceeding maxSize', () => {
    const buffer = new ReplayBuffer(20)
    buffer.write('line1\nline2\nline3\nline4\n')
    // Buffer should trim from the front at a newline boundary
    const contents = buffer.getContents()
    expect(contents.length).toBeLessThanOrEqual(20)
    // Should retain the most recent content
    expect(contents).toContain('line4')
  })

  it('trims without newline boundary when no newline found', () => {
    const buffer = new ReplayBuffer(10)
    buffer.write('abcdefghijklmno') // 15 chars, no newlines
    const contents = buffer.getContents()
    expect(contents.length).toBeLessThanOrEqual(10)
    // Should contain the most recent characters
    expect(contents).toContain('o')
  })

  it('handles exact maxSize without trimming', () => {
    const buffer = new ReplayBuffer(5)
    buffer.write('12345')
    expect(buffer.getContents()).toBe('12345')
    expect(buffer.size).toBe(5)
  })

  it('handles multiple writes that collectively exceed maxSize', () => {
    const buffer = new ReplayBuffer(10)
    buffer.write('abc\n')
    buffer.write('def\n')
    buffer.write('ghi\n')
    const contents = buffer.getContents()
    expect(contents.length).toBeLessThanOrEqual(10)
    // Most recent content should be preserved
    expect(contents).toContain('ghi')
  })
})

// ---------------------------------------------------------------------------
// TerminalSessionPersistence unit tests
// ---------------------------------------------------------------------------

describe('createTerminalSessionPersistence', () => {
  const stateFilePath = join(PERSISTENCE_DIR, STATE_FILE)

  beforeEach(() => {
    // Clean up any existing state file
    try {
      unlinkSync(stateFilePath)
    } catch {
      // File may not exist
    }
  })

  afterEach(() => {
    // Clean up
    try {
      unlinkSync(stateFilePath)
    } catch {
      // File may not exist
    }
  })

  describe('registerTerminal', () => {
    it('creates a replay buffer for a new terminal', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.registerTerminal('term-1', 80, 24)
      // Buffer should be empty but exist
      expect(persistence.getReplayBuffer('term-1')).toBe('')
    })

    it('stores dimensions', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.registerTerminal('term-1', 120, 40)
      const dims = persistence.getDimensions('term-1')
      expect(dims).toEqual({ cols: 120, rows: 40 })
    })

    it('does not overwrite existing buffer on re-register', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.registerTerminal('term-1', 80, 24)
      persistence.writeOutput('term-1', 'existing data')
      persistence.registerTerminal('term-1', 80, 24)
      expect(persistence.getReplayBuffer('term-1')).toBe('existing data')
    })
  })

  describe('unregisterTerminal', () => {
    it('removes replay buffer and dimensions', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.registerTerminal('term-1', 80, 24)
      persistence.writeOutput('term-1', 'data')
      persistence.unregisterTerminal('term-1')
      expect(persistence.getReplayBuffer('term-1')).toBeUndefined()
      expect(persistence.getDimensions('term-1')).toBeUndefined()
    })
  })

  describe('writeOutput', () => {
    it('appends data to the replay buffer', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.registerTerminal('term-1', 80, 24)
      persistence.writeOutput('term-1', 'Hello ')
      persistence.writeOutput('term-1', 'World')
      expect(persistence.getReplayBuffer('term-1')).toBe('Hello World')
    })

    it('no-ops for unregistered terminals', () => {
      const persistence = createTerminalSessionPersistence()
      // Should not throw
      persistence.writeOutput('unknown', 'data')
      expect(persistence.getReplayBuffer('unknown')).toBeUndefined()
    })
  })

  describe('updateDimensions', () => {
    it('updates stored dimensions', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.registerTerminal('term-1', 80, 24)
      persistence.updateDimensions('term-1', 120, 40)
      expect(persistence.getDimensions('term-1')).toEqual({
        cols: 120,
        rows: 40,
      })
    })

    it('no-ops for unregistered terminals', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.updateDimensions('unknown', 120, 40)
      expect(persistence.getDimensions('unknown')).toBeUndefined()
    })
  })

  describe('clear', () => {
    it('removes all replay buffers and dimensions', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.registerTerminal('term-1', 80, 24)
      persistence.registerTerminal('term-2', 120, 40)
      persistence.writeOutput('term-1', 'data1')
      persistence.writeOutput('term-2', 'data2')
      persistence.clear()
      expect(persistence.getReplayBuffer('term-1')).toBeUndefined()
      expect(persistence.getReplayBuffer('term-2')).toBeUndefined()
      expect(persistence.getDimensions('term-1')).toBeUndefined()
      expect(persistence.getDimensions('term-2')).toBeUndefined()
    })
  })

  describe('serializeState', () => {
    it('writes resize-bounded replay events to disk for running terminals', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.registerTerminal('term-1', 80, 24)
      persistence.writeOutput('term-1', 'Hello\r\n')
      persistence.updateDimensions('term-1', 120, 40)
      persistence.writeOutput('term-1', '$ ')

      persistence.serializeState(
        () => [
          {
            id: 'term-1',
            workspaceId: 'ws-1',
            command: '/bin/zsh',
            args: [],
            cwd: '/home/user',
            env: { TERM: 'xterm-256color' },
            status: 'running' as const,
          },
        ],
        (id) => (id === 'term-1' ? '<screen-state>' : '')
      )

      expect(existsSync(stateFilePath)).toBe(true)
      const raw = readFileSync(stateFilePath, 'utf-8')
      const state = JSON.parse(raw) as SerializedState
      expect(state.version).toBe(2)
      expect(state.terminals).toHaveLength(1)
      const first = state.terminals[0]
      expect(first).toBeDefined()
      expect(first).toMatchObject({
        id: 'term-1',
        command: '/bin/zsh',
        replayBuffer: 'Hello\r\n$ ',
        replayEvent: {
          events: [
            {
              cols: 80,
              data: 'Hello\r\n',
              rows: 24,
            },
            {
              cols: 120,
              data: '$ ',
              rows: 40,
            },
          ],
        },
        screenState: '<screen-state>',
        cols: 120,
        rows: 40,
      })
    })

    it('skips stopped terminals', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.registerTerminal('term-1', 80, 24)

      persistence.serializeState(
        () => [
          {
            id: 'term-1',
            workspaceId: 'ws-1',
            command: '/bin/zsh',
            args: [],
            cwd: '/home/user',
            env: {},
            status: 'stopped' as const,
          },
        ],
        () => ''
      )

      // No state file should be written for stopped-only terminals
      expect(existsSync(stateFilePath)).toBe(false)
    })

    it('preserves restored command metadata when serializing again', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.registerTerminal('term-1', 80, 24)
      persistence.restoreReplayEvent('term-1', {
        commands: {
          isWindowsPty: false,
          hasRichCommandDetection: true,
          commands: [
            {
              command: 'ls',
              commandLineConfidence: 'high',
              isTrusted: true,
              timestamp: 123,
              duration: 45,
            },
          ],
        },
        events: [
          {
            cols: 80,
            rows: 24,
            data: 'restored output\r\n',
          },
        ],
      })

      persistence.serializeState(
        () => [
          {
            id: 'term-1',
            workspaceId: 'ws-1',
            command: '/bin/zsh',
            args: [],
            cwd: '/home/user',
            env: { TERM: 'xterm-256color' },
            status: 'running' as const,
          },
        ],
        () => ''
      )

      const raw = readFileSync(stateFilePath, 'utf-8')
      const state = JSON.parse(raw) as SerializedState
      expect(state.terminals[0]?.replayEvent.commands).toEqual({
        isWindowsPty: false,
        hasRichCommandDetection: true,
        commands: [
          {
            command: 'ls',
            commandLineConfidence: 'high',
            isTrusted: true,
            timestamp: 123,
            duration: 45,
          },
        ],
      })
    })

    it('serializes live command metadata from terminal runtime state', async () => {
      const persistence = createTerminalSessionPersistence()
      const headlessManager = createHeadlessTerminalManager()
      persistence.registerTerminal('term-1', 80, 24)
      headlessManager.create('term-1', 80, 24)

      headlessManager.write(
        'term-1',
        '\x1b]633;P;HasRichCommandDetection=True\x07' +
          '\x1b]633;P;Prompt=/workspace/app\x20$\x20\x07' +
          '\x1b]633;P;ContinuationPrompt=>\x20\x07' +
          '\x1b]633;P;Cwd=/workspace/app\x07' +
          '\x1b]633;A\x07' +
          '\x1b]633;B\x07' +
          '\x1b]633;E;pwd\x07' +
          '\x1b]633;C\x07' +
          '/workspace/app\r\n' +
          '\x1b]633;D;0\x07'
      )

      await new Promise((resolve) => setTimeout(resolve, 50))

      persistence.writeOutput('term-1', '/workspace/app\r\n')
      persistence.serializeState(
        () => [
          {
            id: 'term-1',
            workspaceId: 'ws-1',
            command: '/bin/zsh',
            args: [],
            cwd: '/workspace/app',
            env: { TERM: 'xterm-256color' },
            status: 'running' as const,
          },
        ],
        () => '',
        (id) => headlessManager.getCommandDetectionState(id)
      )

      const raw = readFileSync(stateFilePath, 'utf-8')
      const state = JSON.parse(raw) as SerializedState

      expect(state.terminals[0]?.replayEvent.commands).toEqual({
        isWindowsPty: false,
        hasRichCommandDetection: true,
        promptInputModel: {
          value: 'pwd',
          cursorIndex: 3,
          lastPromptLine: ' $ ',
          continuationPrompt: '> ',
        },
        commands: [
          expect.objectContaining({
            command: 'pwd',
            commandLineConfidence: 'high',
            cwd: '/workspace/app',
            exitCode: 0,
            isTrusted: false,
          }),
        ],
      })

      headlessManager.disposeAll()
    })

    it('persists the current in-flight command from terminal runtime state', async () => {
      const persistence = createTerminalSessionPersistence()
      const headlessManager = createHeadlessTerminalManager()
      persistence.registerTerminal('term-1', 80, 24)
      headlessManager.create('term-1', 80, 24)

      headlessManager.write(
        'term-1',
        '\x1b]633;P;Cwd=/workspace/app\x07' +
          '\x1b]633;B\x07' +
          '\x1b]633;E;git\x20status\x07'
      )

      await new Promise((resolve) => setTimeout(resolve, 50))

      persistence.writeOutput('term-1', 'git status')
      persistence.serializeState(
        () => [
          {
            id: 'term-1',
            workspaceId: 'ws-1',
            command: '/bin/zsh',
            args: [],
            cwd: '/workspace/app',
            env: { TERM: 'xterm-256color' },
            status: 'running' as const,
          },
        ],
        () => '',
        (id) => headlessManager.getCommandDetectionState(id)
      )

      const raw = readFileSync(stateFilePath, 'utf-8')
      const state = JSON.parse(raw) as SerializedState

      expect(state.terminals[0]?.replayEvent.commands).toEqual({
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

      headlessManager.disposeAll()
    })

    it('persists trusted command lines from shell integration nonce matches', async () => {
      const persistence = createTerminalSessionPersistence()
      const headlessManager = createHeadlessTerminalManager({
        shellIntegrationNonce: 'trusted-nonce',
      })
      persistence.registerTerminal('term-1', 80, 24)
      headlessManager.create('term-1', 80, 24)

      headlessManager.write(
        'term-1',
        '\x1b]633;P;Cwd=/workspace/app\x07' +
          '\x1b]633;B\x07' +
          '\x1b]633;E;git\x20status;trusted-nonce\x07' +
          '\x1b]633;C\x07' +
          '\x1b]633;D;0\x07'
      )

      await new Promise((resolve) => setTimeout(resolve, 50))

      persistence.writeOutput('term-1', 'git status\r\n')
      persistence.serializeState(
        () => [
          {
            id: 'term-1',
            workspaceId: 'ws-1',
            command: '/bin/zsh',
            args: [],
            cwd: '/workspace/app',
            env: { TERM: 'xterm-256color' },
            status: 'running' as const,
          },
        ],
        () => '',
        (id) => headlessManager.getCommandDetectionState(id)
      )

      const raw = readFileSync(stateFilePath, 'utf-8')
      const state = JSON.parse(raw) as SerializedState

      expect(state.terminals[0]?.replayEvent.commands).toEqual({
        isWindowsPty: false,
        hasRichCommandDetection: false,
        promptInputModel: {
          value: 'git status',
          cursorIndex: 10,
        },
        commands: [
          expect.objectContaining({
            command: 'git status',
            commandLineConfidence: 'high',
            cwd: '/workspace/app',
            exitCode: 0,
            isTrusted: true,
          }),
        ],
      })

      headlessManager.disposeAll()
    })

    it('does not write when no terminals exist', () => {
      const persistence = createTerminalSessionPersistence()
      persistence.serializeState(
        () => [],
        () => ''
      )
      expect(existsSync(stateFilePath)).toBe(false)
    })
  })

  describe('loadPersistedState', () => {
    it('returns null when no state file exists', () => {
      const persistence = createTerminalSessionPersistence()
      expect(persistence.loadPersistedState()).toBeNull()
    })

    it('loads valid state and deletes the file', () => {
      const state: SerializedState = {
        version: 2,
        timestamp: Date.now(),
        terminals: [
          {
            id: 'term-1',
            workspaceId: 'ws-1',
            command: '/bin/zsh',
            args: [],
            cwd: '/home/user',
            env: { TERM: 'xterm-256color' },
            cols: 80,
            rows: 24,
            replayBuffer: 'saved output',
            replayEvent: {
              events: [{ cols: 80, rows: 24, data: 'saved output' }],
            },
            screenState: '<screen>',
          },
        ],
      }

      mkdirSync(PERSISTENCE_DIR, { recursive: true })
      writeFileSync(stateFilePath, JSON.stringify(state), 'utf-8')

      const persistence = createTerminalSessionPersistence()
      const loaded = persistence.loadPersistedState()

      expect(loaded).not.toBeNull()
      expect(loaded?.terminals).toHaveLength(1)
      const loadedFirst = loaded?.terminals[0]
      expect(loadedFirst).toMatchObject({
        id: 'term-1',
        replayBuffer: 'saved output',
        replayEvent: {
          events: [{ cols: 80, rows: 24, data: 'saved output' }],
        },
      })

      // File should be deleted after loading
      expect(existsSync(stateFilePath)).toBe(false)
    })

    it('rejects stale state files', () => {
      const state: SerializedState = {
        version: 2,
        timestamp: Date.now() - MAX_STATE_AGE_MS - 1000,
        terminals: [
          {
            id: 'term-1',
            workspaceId: 'ws-1',
            command: '/bin/zsh',
            args: [],
            cwd: '/home/user',
            env: {},
            cols: 80,
            rows: 24,
            replayBuffer: '',
            replayEvent: {
              events: [{ cols: 80, rows: 24, data: '' }],
            },
            screenState: '',
          },
        ],
      }

      mkdirSync(PERSISTENCE_DIR, { recursive: true })
      writeFileSync(stateFilePath, JSON.stringify(state), 'utf-8')

      const persistence = createTerminalSessionPersistence()
      expect(persistence.loadPersistedState()).toBeNull()
    })

    it('rejects invalid version', () => {
      const state = {
        version: 99,
        timestamp: Date.now(),
        terminals: [],
      }

      mkdirSync(PERSISTENCE_DIR, { recursive: true })
      writeFileSync(stateFilePath, JSON.stringify(state), 'utf-8')

      const persistence = createTerminalSessionPersistence()
      expect(persistence.loadPersistedState()).toBeNull()
    })

    it('handles corrupt JSON gracefully', () => {
      mkdirSync(PERSISTENCE_DIR, { recursive: true })
      writeFileSync(stateFilePath, 'not-json!!!', 'utf-8')

      const persistence = createTerminalSessionPersistence()
      expect(persistence.loadPersistedState()).toBeNull()

      // Corrupt file should be cleaned up
      expect(existsSync(stateFilePath)).toBe(false)
    })

    it('rejects empty terminal arrays', () => {
      const state: SerializedState = {
        version: 2,
        timestamp: Date.now(),
        terminals: [],
      }

      mkdirSync(PERSISTENCE_DIR, { recursive: true })
      writeFileSync(stateFilePath, JSON.stringify(state), 'utf-8')

      const persistence = createTerminalSessionPersistence()
      expect(persistence.loadPersistedState()).toBeNull()
    })
  })

  describe('round-trip serialization', () => {
    it('serializes and deserializes terminal state correctly', () => {
      const persistence1 = createTerminalSessionPersistence()
      persistence1.registerTerminal('term-1', 100, 30)
      persistence1.registerTerminal('term-2', 120, 40)
      persistence1.writeOutput('term-1', 'output for terminal 1\r\n')
      persistence1.writeOutput('term-2', 'output for terminal 2\r\n')

      persistence1.serializeState(
        () => [
          {
            id: 'term-1',
            workspaceId: 'ws-1',
            command: '/bin/zsh',
            args: [],
            cwd: '/home/user',
            env: { SHELL: '/bin/zsh' },
            status: 'running' as const,
          },
          {
            id: 'term-2',
            workspaceId: 'ws-1',
            command: 'vim',
            args: ['file.txt'],
            cwd: '/home/user/project',
            env: { EDITOR: 'vim' },
            status: 'running' as const,
          },
        ],
        (id) => `<screen-${id}>`
      )

      const persistence2 = createTerminalSessionPersistence()
      const loaded = persistence2.loadPersistedState()

      expect(loaded).not.toBeNull()
      expect(loaded?.terminals).toHaveLength(2)

      const terminals = loaded?.terminals ?? []
      const t1 = terminals.find((t) => t.id === 'term-1')
      expect(t1).toMatchObject({
        command: '/bin/zsh',
        cols: 100,
        rows: 30,
        replayBuffer: 'output for terminal 1\r\n',
        replayEvent: {
          events: [
            {
              cols: 100,
              data: 'output for terminal 1\r\n',
              rows: 30,
            },
          ],
        },
        screenState: '<screen-term-1>',
      })
      expect(t1?.env.SHELL).toBe('/bin/zsh')

      const t2 = terminals.find((t) => t.id === 'term-2')
      expect(t2).toMatchObject({
        command: 'vim',
        args: ['file.txt'],
        cols: 120,
        rows: 40,
        replayBuffer: 'output for terminal 2\r\n',
        replayEvent: {
          events: [
            {
              cols: 120,
              data: 'output for terminal 2\r\n',
              rows: 40,
            },
          ],
        },
      })
    })
  })

  describe('constants', () => {
    it('has reasonable default replay buffer size', () => {
      // 200KB default
      expect(DEFAULT_REPLAY_BUFFER_SIZE).toBe(200 * 1024)
    })

    it('has reasonable max state age', () => {
      // 5 minutes
      expect(MAX_STATE_AGE_MS).toBe(5 * 60 * 1000)
    })
  })
})
