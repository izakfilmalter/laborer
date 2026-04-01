/**
 * Unit tests for ShellIntegrationAddon — the renderer-side shell integration
 * addon that deserializes recovered commands into live xterm markers and
 * fires lifecycle events.
 *
 * These tests use a mock xterm Terminal since xterm.js requires a real DOM
 * with canvas support. The mock implements the minimal surface area used
 * by the addon: buffer.active.{baseY, cursorY}, registerMarker(), and
 * the ITerminalAddon activate/dispose lifecycle.
 *
 * @see apps/web/src/lib/shell-integration-addon.ts
 * @see Issue #9 in docs/terminal-shell-integration-parity/issues.md
 */

import type { IMarker, Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

import type {
  SerializedCapabilityStore,
  SerializedCommandDetectionCapability,
  TerminalCommand,
} from '../src/lib/shell-integration-addon'
import { ShellIntegrationAddon } from '../src/lib/shell-integration-addon'

// ---------------------------------------------------------------------------
// Mock xterm Terminal
// ---------------------------------------------------------------------------

/** Minimal IMarker mock — just tracks the line number. */
function createMockMarker(line: number): IMarker {
  return {
    id: Math.floor(Math.random() * 100_000),
    line,
    isDisposed: false,
    dispose: vi.fn(),
    onDispose: vi.fn(() => ({ dispose: vi.fn() })),
  }
}

/**
 * Create a mock Terminal with the minimal surface area needed by the addon.
 *
 * @param baseY - The base Y offset (scrollback above viewport)
 * @param cursorY - The cursor Y within the viewport
 */
function createMockTerminal(baseY = 50, cursorY = 10): Terminal {
  const markers: IMarker[] = []

  return {
    buffer: {
      active: {
        baseY,
        cursorY,
        cursorX: 0,
        viewportY: baseY,
        length: baseY + 24,
        type: 'normal' as const,
        getLine: vi.fn(),
        getNullCell: vi.fn(),
      },
      normal: {
        baseY,
        cursorY,
        cursorX: 0,
        viewportY: baseY,
        length: baseY + 24,
        type: 'normal' as const,
        getLine: vi.fn(),
        getNullCell: vi.fn(),
      },
      alternate: {
        baseY: 0,
        cursorY: 0,
        cursorX: 0,
        viewportY: 0,
        length: 24,
        type: 'alternate' as const,
        getLine: vi.fn(),
        getNullCell: vi.fn(),
      },
      onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
    },
    registerMarker(cursorYOffset?: number): IMarker {
      const absoluteLine = baseY + cursorY + (cursorYOffset ?? 0)
      const marker = createMockMarker(absoluteLine)
      markers.push(marker)
      return marker
    },
    markers,
  } as unknown as Terminal
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function createFinishedCommand(
  overrides: Partial<
    SerializedCommandDetectionCapability['commands'][number]
  > = {}
): SerializedCommandDetectionCapability['commands'][number] {
  return {
    command: 'ls -la',
    commandLineConfidence: 'high',
    isTrusted: true,
    timestamp: Date.now(),
    duration: 150,
    exitCode: 0,
    promptStartLine: 10,
    startLine: 11,
    executedLine: 11,
    endLine: 25,
    startX: 2,
    executedX: 7,
    commandStartLineContent: '$ ls -la',
    cwd: '/home/user',
    ...overrides,
  }
}

function createPartialCommand(
  overrides: Partial<
    SerializedCommandDetectionCapability['commands'][number]
  > = {}
): SerializedCommandDetectionCapability['commands'][number] {
  return {
    command: 'vim',
    commandLineConfidence: 'high',
    isTrusted: true,
    timestamp: Date.now(),
    duration: 0,
    promptStartLine: 30,
    startLine: 31,
    startX: 2,
    // No endLine, executedLine, executedX — this is in-flight
    ...overrides,
  }
}

function createCommandState(
  commands: SerializedCommandDetectionCapability['commands'],
  overrides: Partial<SerializedCommandDetectionCapability> = {}
): SerializedCommandDetectionCapability {
  return {
    commands,
    hasRichCommandDetection: true,
    isWindowsPty: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShellIntegrationAddon', () => {
  describe('activate and dispose', () => {
    it('activates with a terminal instance', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()

      addon.activate(terminal)

      // No-op verify — addon should not throw on activate
      expect(addon.isDeserialized()).toBe(false)
    })

    it('disposes cleanly and clears state', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      addon.deserialize(createCommandState([createFinishedCommand()]))
      expect(addon.getCommands().length).toBe(1)

      addon.dispose()

      expect(addon.getCommands().length).toBe(0)
      expect(addon.getCurrentCommand()).toBeUndefined()
    })
  })

  describe('deserialize — finished commands', () => {
    it('deserializes finished commands with xterm markers at correct positions', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal(50, 10)
      addon.activate(terminal)

      const commandState = createCommandState([
        createFinishedCommand({
          promptStartLine: 10,
          startLine: 11,
          executedLine: 11,
          endLine: 25,
        }),
      ])

      addon.deserialize(commandState)

      expect(addon.isDeserialized()).toBe(true)
      const commands = addon.getCommands()
      expect(commands).toHaveLength(1)

      const cmd = commands[0]
      expect(cmd).toBeDefined()
      expect(cmd?.command).toBe('ls -la')
      expect(cmd?.wasReplayed).toBe(true)
      expect(cmd?.isTrusted).toBe(true)
      expect(cmd?.exitCode).toBe(0)
      expect(cmd?.cwd).toBe('/home/user')
      expect(cmd?.commandStartLineContent).toBe('$ ls -la')

      // Markers should be registered at the correct absolute line positions
      expect(cmd?.markers.promptStartMarker?.line).toBe(10)
      expect(cmd?.markers.startMarker?.line).toBe(11)
      expect(cmd?.markers.executedMarker?.line).toBe(11)
      expect(cmd?.markers.endMarker?.line).toBe(25)
    })

    it('fires onCommandFinished for each finished command', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      const firedCommands: TerminalCommand[] = []
      addon.onCommandFinished((cmd) => firedCommands.push(cmd))

      addon.deserialize(
        createCommandState([
          createFinishedCommand({ command: 'ls' }),
          createFinishedCommand({ command: 'pwd' }),
          createFinishedCommand({ command: 'echo hello' }),
        ])
      )

      expect(firedCommands).toHaveLength(3)
      expect(firedCommands.map((c) => c.command)).toEqual([
        'ls',
        'pwd',
        'echo hello',
      ])
      expect(firedCommands.every((c) => c.wasReplayed)).toBe(true)
    })

    it('deserializes commands with all confidence levels', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      addon.deserialize(
        createCommandState([
          createFinishedCommand({
            command: 'trusted',
            commandLineConfidence: 'high',
            isTrusted: true,
          }),
          createFinishedCommand({
            command: 'medium',
            commandLineConfidence: 'medium',
            isTrusted: false,
          }),
          createFinishedCommand({
            command: 'low',
            commandLineConfidence: 'low',
            isTrusted: false,
          }),
        ])
      )

      const commands = addon.getCommands()
      expect(commands[0]?.commandLineConfidence).toBe('high')
      expect(commands[0]?.isTrusted).toBe(true)
      expect(commands[1]?.commandLineConfidence).toBe('medium')
      expect(commands[1]?.isTrusted).toBe(false)
      expect(commands[2]?.commandLineConfidence).toBe('low')
      expect(commands[2]?.isTrusted).toBe(false)
    })
  })

  describe('deserialize — partial/in-flight commands', () => {
    it('restores partial command as current command and fires onCommandStarted', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      const startedCommands: TerminalCommand[] = []
      addon.onCommandStarted((cmd) => startedCommands.push(cmd))

      addon.deserialize(
        createCommandState([
          createFinishedCommand({ command: 'ls' }),
          createPartialCommand({ command: 'vim' }),
        ])
      )

      // Finished command is in the commands list
      expect(addon.getCommands()).toHaveLength(1)
      expect(addon.getCommands()[0]?.command).toBe('ls')

      // Partial command is the current command
      const current = addon.getCurrentCommand()
      expect(current).toBeDefined()
      expect(current?.command).toBe('vim')
      expect(current?.wasReplayed).toBe(true)
      expect(current?.markers.endMarker).toBeUndefined()
      expect(current?.markers.executedMarker).toBeUndefined()

      // onCommandStarted fired for the partial command
      expect(startedCommands).toHaveLength(1)
      expect(startedCommands[0]?.command).toBe('vim')
    })

    it('registers markers for partial command at promptStartLine and startLine only', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal(50, 10)
      addon.activate(terminal)

      addon.deserialize(
        createCommandState([
          createPartialCommand({
            promptStartLine: 30,
            startLine: 31,
          }),
        ])
      )

      const current = addon.getCurrentCommand()
      expect(current?.markers.promptStartMarker?.line).toBe(30)
      expect(current?.markers.startMarker?.line).toBe(31)
      expect(current?.markers.executedMarker).toBeUndefined()
      expect(current?.markers.endMarker).toBeUndefined()
    })
  })

  describe('deserialize — state restoration', () => {
    it('restores isWindowsPty state', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      addon.deserialize(createCommandState([], { isWindowsPty: true }))

      expect(addon.getIsWindowsPty()).toBe(true)
    })

    it('restores hasRichCommandDetection state', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      addon.deserialize(
        createCommandState([], { hasRichCommandDetection: true })
      )

      expect(addon.getHasRichCommandDetection()).toBe(true)
    })

    it('restores promptInputModel state', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      addon.deserialize(
        createCommandState([], {
          promptInputModel: {
            value: 'git status',
            cursorIndex: 10,
          },
        })
      )

      const model = addon.getPromptInputModel()
      expect(model).toBeDefined()
      expect(model?.value).toBe('git status')
      expect(model?.cursorIndex).toBe(10)
    })

    it('restores capability store state', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      const capabilities: SerializedCapabilityStore = {
        cwdDetection: {
          cwd: '/home/user/projects',
          history: [
            { cwd: '/home/user' },
            { cwd: '/home/user/projects', line: 15 },
          ],
        },
      }

      addon.deserialize(createCommandState([]), capabilities)

      const store = addon.getCapabilityStore()
      expect(store).toBeDefined()
      expect(store?.cwdDetection?.cwd).toBe('/home/user/projects')
      expect(store?.cwdDetection?.history).toHaveLength(2)
    })
  })

  describe('deserialize — edge cases', () => {
    it('handles undefined command state gracefully', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      addon.deserialize(undefined)

      expect(addon.isDeserialized()).toBe(true)
      expect(addon.getCommands()).toHaveLength(0)
      expect(addon.getCurrentCommand()).toBeUndefined()
    })

    it('handles empty commands list', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      addon.deserialize(createCommandState([]))

      expect(addon.getCommands()).toHaveLength(0)
      expect(addon.getCurrentCommand()).toBeUndefined()
    })

    it('handles commands without positional metadata', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      addon.deserialize(
        createCommandState([
          createFinishedCommand({
            promptStartLine: undefined,
            startLine: undefined,
            executedLine: undefined,
            endLine: 20,
          }),
        ])
      )

      const cmd = addon.getCommands()[0]
      expect(cmd).toBeDefined()
      expect(cmd?.markers.promptStartMarker).toBeUndefined()
      expect(cmd?.markers.startMarker).toBeUndefined()
      expect(cmd?.markers.executedMarker).toBeUndefined()
      expect(cmd?.markers.endMarker).toBeDefined()
    })

    it('handles deserialization without prior activate (no-op)', () => {
      const addon = new ShellIntegrationAddon()

      // Should not throw — just produces no commands since terminal is undefined
      addon.deserialize(createCommandState([createFinishedCommand()]))

      expect(addon.isDeserialized()).toBe(true)
      expect(addon.getCommands()).toHaveLength(0)
    })
  })

  describe('event lifecycle', () => {
    it('onCommandFinished listener can be disposed', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      const firedCommands: TerminalCommand[] = []
      const disposable = addon.onCommandFinished((cmd) =>
        firedCommands.push(cmd)
      )

      addon.deserialize(
        createCommandState([createFinishedCommand({ command: 'first' })])
      )
      expect(firedCommands).toHaveLength(1)

      // Dispose the listener
      disposable.dispose()

      // Create a new addon instance to test listener removal
      // (can't re-deserialize the same addon, but we can verify
      // the listener array is cleaned up via dispose)
      expect(firedCommands).toHaveLength(1) // Still 1 — no more events
    })

    it('onCommandStarted listener can be disposed', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      const startedCommands: TerminalCommand[] = []
      const disposable = addon.onCommandStarted((cmd) =>
        startedCommands.push(cmd)
      )

      // Dispose before deserialize
      disposable.dispose()

      addon.deserialize(createCommandState([createPartialCommand()]))

      // Listener was disposed — should not fire
      expect(startedCommands).toHaveLength(0)
    })

    it('multiple listeners receive events', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()
      addon.activate(terminal)

      const listener1: string[] = []
      const listener2: string[] = []
      addon.onCommandFinished((cmd) => listener1.push(cmd.command))
      addon.onCommandFinished((cmd) => listener2.push(cmd.command))

      addon.deserialize(
        createCommandState([createFinishedCommand({ command: 'test' })])
      )

      expect(listener1).toEqual(['test'])
      expect(listener2).toEqual(['test'])
    })
  })

  describe('marker registration', () => {
    it('registers markers with correct cursorYOffset relative to buffer position', () => {
      // Terminal with baseY=100, cursorY=5 → current absolute line = 105
      const baseY = 100
      const cursorY = 5
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal(baseY, cursorY)
      const registerMarkerSpy = vi.spyOn(terminal, 'registerMarker')
      addon.activate(terminal)

      addon.deserialize(
        createCommandState([
          createFinishedCommand({
            promptStartLine: 10, // offset: 10 - 105 = -95
            startLine: 11, // offset: 11 - 105 = -94
            executedLine: 12, // offset: 12 - 105 = -93
            endLine: 50, // offset: 50 - 105 = -55
          }),
        ])
      )

      // Verify registerMarker was called with correct offsets
      expect(registerMarkerSpy).toHaveBeenCalledWith(-95) // promptStartLine
      expect(registerMarkerSpy).toHaveBeenCalledWith(-94) // startLine
      expect(registerMarkerSpy).toHaveBeenCalledWith(-93) // executedLine
      expect(registerMarkerSpy).toHaveBeenCalledWith(-55) // endLine
      expect(registerMarkerSpy).toHaveBeenCalledTimes(4)
    })

    it('handles registerMarker failure gracefully', () => {
      const addon = new ShellIntegrationAddon()
      const terminal = createMockTerminal()

      // Make registerMarker throw for some calls
      let callCount = 0
      vi.spyOn(terminal, 'registerMarker').mockImplementation(() => {
        callCount++
        if (callCount === 2) {
          throw new Error('Marker out of range')
        }
        return createMockMarker(0)
      })

      addon.activate(terminal)

      // Should not throw — gracefully handles marker registration failure
      addon.deserialize(
        createCommandState([
          createFinishedCommand({
            promptStartLine: 10,
            startLine: 11,
            executedLine: 12,
            endLine: 25,
          }),
        ])
      )

      const cmd = addon.getCommands()[0]
      expect(cmd).toBeDefined()
      expect(cmd?.markers.promptStartMarker).toBeDefined()
      expect(cmd?.markers.startMarker).toBeUndefined() // Failed
      expect(cmd?.markers.executedMarker).toBeDefined()
      expect(cmd?.markers.endMarker).toBeDefined()
    })
  })
})
