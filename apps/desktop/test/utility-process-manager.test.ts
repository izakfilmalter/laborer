/**
 * Unit tests for the UtilityProcessManager.
 *
 * Since the manager depends on Electron's `utilityProcess.fork()` and
 * `MessageChannelMain`, which are not available in a regular Node.js
 * test environment, these tests mock the Electron APIs and verify:
 *
 * 1. fork() creates a utility process with correct env and MessagePort pair
 * 2. fork() replaces an existing process for the same service name
 * 3. kill() marks the process as intentionally stopped
 * 4. kill() cleans up on already-exited processes
 * 5. restart() kills the old process and forks a new one
 * 6. killAll() kills all tracked processes
 * 7. killAllAndWait() waits for processes to exit
 * 8. Unexpected exit fires the exit handler
 * 9. MessagePort is closed on process exit
 * 10. Environment strips blocked vars and sets LABORER_ENTRYPOINT
 */

import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock Electron APIs using vi.hoisted so classes are available in vi.mock
// ---------------------------------------------------------------------------

const {
  MockPort,
  MockMessageChannelMain,
  MockUtilityProcess,
  forkedProcesses,
  createdChannels,
  mockFork,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as {
    EventEmitter: typeof EventEmitter
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PassThrough } = require('node:stream') as {
    PassThrough: typeof import('node:stream').PassThrough
  }

  class HoistedMockPort {
    closed = false
    readonly messages: unknown[] = []
    readonly transfers: unknown[][] = []

    postMessage(message: unknown, transfer?: unknown[]): void {
      this.messages.push(message)
      this.transfers.push(transfer ?? [])
    }

    close(): void {
      this.closed = true
    }

    start(): void {
      // no-op
    }
  }

  const hoistedForkedProcesses: HoistedMockUtilityProcess[] = []
  const hoistedCreatedChannels: {
    port1: HoistedMockPort
    port2: HoistedMockPort
  }[] = []

  class HoistedMockMessageChannelMain {
    port1: HoistedMockPort
    port2: HoistedMockPort

    constructor() {
      this.port1 = new HoistedMockPort()
      this.port2 = new HoistedMockPort()
      hoistedCreatedChannels.push({
        port1: this.port1,
        port2: this.port2,
      })
    }
  }

  class HoistedMockUtilityProcess extends EE {
    pid: number | undefined = undefined
    stdout: InstanceType<typeof PassThrough> | null = new PassThrough()
    stderr: InstanceType<typeof PassThrough> | null = new PassThrough()
    readonly modulePath: string
    readonly args: string[]
    readonly options: Record<string, unknown>
    killed = false
    private readonly postedMessages: {
      message: unknown
      transfer: unknown[] | undefined
    }[] = []

    constructor(
      modulePath: string,
      args: string[],
      options: Record<string, unknown>
    ) {
      super()
      this.modulePath = modulePath
      this.args = args
      this.options = options
      hoistedForkedProcesses.push(this)
    }

    kill(): boolean {
      this.killed = true
      this.pid = undefined
      return true
    }

    postMessage(message: unknown, transfer?: unknown[]): void {
      this.postedMessages.push({ message, transfer })
    }

    getPostedMessages(): {
      message: unknown
      transfer: unknown[] | undefined
    }[] {
      return this.postedMessages
    }

    simulateSpawn(pid: number): void {
      this.pid = pid
      this.emit('spawn')
    }

    simulateExit(code: number): void {
      this.pid = undefined
      this.emit('exit', code)
    }

    simulateMessage(message: unknown): void {
      this.emit('message', message)
    }
  }

  const hoistedMockFork = vi.fn(
    (
      modulePath: string,
      args?: string[],
      options?: Record<string, unknown>
    ): HoistedMockUtilityProcess => {
      return new HoistedMockUtilityProcess(
        modulePath,
        args ?? [],
        options ?? {}
      )
    }
  )

  return {
    MockPort: HoistedMockPort,
    MockMessageChannelMain: HoistedMockMessageChannelMain,
    MockUtilityProcess: HoistedMockUtilityProcess,
    forkedProcesses: hoistedForkedProcesses,
    createdChannels: hoistedCreatedChannels,
    mockFork: hoistedMockFork,
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/mock/app/path',
    getPath: (_name: string) => '/mock/appData',
  },
  utilityProcess: {
    fork: (...args: unknown[]) =>
      mockFork(
        args[0] as string,
        args[1] as string[],
        args[2] as Record<string, unknown>
      ),
  },
  MessageChannelMain: MockMessageChannelMain,
}))

// Import after mocks are set up
import {
  type ProcessExitHandler,
  type ServiceName,
  UtilityProcessManager,
} from '../src/utility-process-manager.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function getProcess(index: number): InstanceType<typeof MockUtilityProcess> {
  const proc = forkedProcesses[index]
  if (!proc) {
    throw new Error(`No forked process at index ${index}`)
  }
  return proc
}

function getChannel(index: number): {
  port1: InstanceType<typeof MockPort>
  port2: InstanceType<typeof MockPort>
} {
  const channel = createdChannels[index]
  if (!channel) {
    throw new Error(`No channel at index ${index}`)
  }
  return channel
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UtilityProcessManager', () => {
  let manager: UtilityProcessManager

  beforeEach(() => {
    manager = new UtilityProcessManager()
    forkedProcesses.length = 0
    createdChannels.length = 0
    mockFork.mockClear()
  })

  afterEach(() => {
    manager.killAll()
  })

  // -----------------------------------------------------------------------
  // fork()
  // -----------------------------------------------------------------------

  describe('fork()', () => {
    it('forks a utility process and returns a MessagePort', () => {
      const port = manager.fork('terminal')

      expect(port).toBeDefined()
      expect(forkedProcesses).toHaveLength(1)
      expect(createdChannels).toHaveLength(1)
    })

    it('passes the bootstrap script as the module path', () => {
      manager.fork('server')

      const proc = getProcess(0)
      expect(proc.modulePath).toContain('utility-process-bootstrap.cjs')
    })

    it('sets LABORER_ENTRYPOINT in the environment', () => {
      manager.fork('terminal')

      const proc = getProcess(0)
      const env = proc.options.env as Record<string, string>
      expect(env.LABORER_ENTRYPOINT).toBeDefined()
      expect(env.LABORER_ENTRYPOINT).toContain(
        'packages/terminal/dist/utility-main.mjs'
      )
    })

    it('strips ELECTRON_RUN_AS_NODE from the environment', () => {
      const original = process.env.ELECTRON_RUN_AS_NODE
      process.env.ELECTRON_RUN_AS_NODE = '1'

      try {
        manager.fork('server')
        const proc = getProcess(0)
        const env = proc.options.env as Record<string, string>
        expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
      } finally {
        if (original !== undefined) {
          process.env.ELECTRON_RUN_AS_NODE = original
        } else {
          Reflect.deleteProperty(process.env, 'ELECTRON_RUN_AS_NODE')
        }
      }
    })

    it('strips DEBUG from the environment', () => {
      const original = process.env.DEBUG
      process.env.DEBUG = 'some:debug'

      try {
        manager.fork('server')
        const proc = getProcess(0)
        const env = proc.options.env as Record<string, string>
        expect(env.DEBUG).toBeUndefined()
      } finally {
        if (original !== undefined) {
          process.env.DEBUG = original
        } else {
          Reflect.deleteProperty(process.env, 'DEBUG')
        }
      }
    })

    it('uses pipe stdio mode', () => {
      manager.fork('terminal')
      const proc = getProcess(0)
      expect(proc.options.stdio).toBe('pipe')
    })

    it('sets a descriptive service name', () => {
      manager.fork('file-watcher')
      const proc = getProcess(0)
      expect(proc.options.serviceName).toBe('laborer-file-watcher')
    })

    it('sends the utility-side port to the child on spawn', async () => {
      manager.fork('terminal')
      const child = getProcess(0)
      child.simulateSpawn(1234)
      await flushMicrotasks()

      const messages = child.getPostedMessages()
      expect(messages).toHaveLength(1)
      const firstMessage = messages[0]
      expect(firstMessage).toBeDefined()
      expect(firstMessage?.message).toEqual({ type: 'port' })
      expect(firstMessage?.transfer).toHaveLength(1)
    })

    it('tracks PID after spawn', () => {
      manager.fork('server')
      const child = getProcess(0)

      expect(manager.getPid('server')).toBeUndefined()

      child.simulateSpawn(5678)
      expect(manager.getPid('server')).toBe(5678)
    })

    it('kills existing process when forking a duplicate name', () => {
      manager.fork('terminal')
      const first = getProcess(0)
      first.simulateSpawn(1000)

      manager.fork('terminal')

      expect(first.killed).toBe(true)
      expect(forkedProcesses).toHaveLength(2)
    })

    it('resolves correct entrypoint for each service', () => {
      const services: ServiceName[] = [
        'server',
        'terminal',
        'file-watcher',
        'mcp',
      ]

      for (const service of services) {
        manager.fork(service)
      }

      const envs = forkedProcesses.map(
        (p) => (p.options.env as Record<string, string>).LABORER_ENTRYPOINT
      )

      expect(envs[0]).toContain('packages/server/dist/main.mjs')
      expect(envs[1]).toContain('packages/terminal/dist/utility-main.mjs')
      expect(envs[2]).toContain('packages/file-watcher/dist/main.mjs')
      expect(envs[3]).toContain('packages/mcp/dist/main.mjs')
    })
  })

  // -----------------------------------------------------------------------
  // kill()
  // -----------------------------------------------------------------------

  describe('kill()', () => {
    it('kills a running process', () => {
      manager.fork('terminal')
      const child = getProcess(0)
      child.simulateSpawn(1234)

      manager.kill('terminal')

      expect(child.killed).toBe(true)
    })

    it('is a no-op for unknown service names', () => {
      // Should not throw.
      manager.kill('terminal')
    })

    it('cleans up if process already exited', () => {
      manager.fork('server')
      // Don't simulate spawn — pid stays undefined.

      manager.kill('server')

      expect(manager.isRunning('server')).toBe(false)
    })

    it('marks process as intentionally stopped', () => {
      const exitHandler = vi.fn()
      manager.setExitHandler(exitHandler)

      manager.fork('terminal')
      const child = getProcess(0)
      child.simulateSpawn(1234)

      manager.kill('terminal')
      child.simulateExit(0)

      // Exit handler should NOT be called for intentional kills.
      expect(exitHandler).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // restart()
  // -----------------------------------------------------------------------

  describe('restart()', () => {
    it('kills the old process and forks a new one', async () => {
      manager.fork('terminal')
      const firstChild = getProcess(0)
      firstChild.simulateSpawn(1000)

      // Simulate the exit immediately on kill.
      const originalKill = firstChild.kill.bind(firstChild)
      firstChild.kill = () => {
        const result = originalKill()
        firstChild.simulateExit(0)
        return result
      }

      const newPort = await manager.restart('terminal')

      expect(firstChild.killed).toBe(true)
      expect(newPort).toBeDefined()
      expect(forkedProcesses).toHaveLength(2)
    })

    it('works even if no existing process', async () => {
      const port = await manager.restart('server')
      expect(port).toBeDefined()
      expect(forkedProcesses).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // killAll()
  // -----------------------------------------------------------------------

  describe('killAll()', () => {
    it('kills all tracked processes', () => {
      manager.fork('server')
      manager.fork('terminal')
      manager.fork('file-watcher')

      getProcess(0).simulateSpawn(1000)
      getProcess(1).simulateSpawn(2000)
      getProcess(2).simulateSpawn(3000)

      manager.killAll()

      expect(getProcess(0).killed).toBe(true)
      expect(getProcess(1).killed).toBe(true)
      expect(getProcess(2).killed).toBe(true)
    })

    it('suppresses unexpected exit handlers after killAll', () => {
      const exitHandler = vi.fn()
      manager.setExitHandler(exitHandler)

      manager.fork('terminal')
      getProcess(0).simulateSpawn(1234)

      manager.killAll()
      getProcess(0).simulateExit(1)

      expect(exitHandler).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // killAllAndWait()
  // -----------------------------------------------------------------------

  describe('killAllAndWait()', () => {
    it('resolves after all processes exit', async () => {
      manager.fork('server')
      manager.fork('terminal')
      getProcess(0).simulateSpawn(1000)
      getProcess(1).simulateSpawn(2000)

      const promise = manager.killAllAndWait(2000)

      // Simulate exits.
      getProcess(0).simulateExit(0)
      getProcess(1).simulateExit(0)

      await promise
    })

    it('resolves on timeout even if processes do not exit', async () => {
      manager.fork('server')
      getProcess(0).simulateSpawn(1000)

      // Don't simulate exit — should still resolve after timeout.
      await manager.killAllAndWait(100)
    })

    it('handles empty process list', async () => {
      await manager.killAllAndWait()
    })
  })

  // -----------------------------------------------------------------------
  // Unexpected exit
  // -----------------------------------------------------------------------

  describe('unexpected exit handling', () => {
    it('fires exit handler on unexpected exit', () => {
      const exitHandler = vi.fn<ProcessExitHandler>()
      manager.setExitHandler(exitHandler)

      manager.fork('terminal')
      const child = getProcess(0)
      child.simulateSpawn(1234)

      // Simulate unexpected exit (not killed by manager).
      child.simulateExit(1)

      expect(exitHandler).toHaveBeenCalledOnce()
      expect(exitHandler).toHaveBeenCalledWith('terminal', 1, '')
    })

    it('does not fire exit handler when process was intentionally killed', () => {
      const exitHandler = vi.fn()
      manager.setExitHandler(exitHandler)

      manager.fork('terminal')
      const child = getProcess(0)
      child.simulateSpawn(1234)

      manager.kill('terminal')
      child.simulateExit(0)

      expect(exitHandler).not.toHaveBeenCalled()
    })

    it('does not fire exit handler after killAll', () => {
      const exitHandler = vi.fn()
      manager.setExitHandler(exitHandler)

      manager.fork('server')
      getProcess(0).simulateSpawn(1000)

      manager.killAll()
      getProcess(0).simulateExit(1)

      expect(exitHandler).not.toHaveBeenCalled()
    })

    it('includes stderr in exit handler callback', async () => {
      const exitHandler = vi.fn<ProcessExitHandler>()
      manager.setExitHandler(exitHandler)

      manager.fork('terminal')
      const child = getProcess(0)
      child.simulateSpawn(1234)

      // Write to the PassThrough stderr stream — createInterface will
      // process these into lines.
      child.stderr?.write('Error: something went wrong\n')
      child.stderr?.write('Stack trace line 1\n')

      // Give readline time to process the buffered data.
      await flushMicrotasks()

      // Simulate unexpected exit.
      child.simulateExit(1)

      expect(exitHandler).toHaveBeenCalledOnce()
      const lastStderr = exitHandler.mock.calls[0]?.[2] ?? ''
      expect(lastStderr).toContain('Error: something went wrong')
      expect(lastStderr).toContain('Stack trace line 1')
    })
  })

  // -----------------------------------------------------------------------
  // MessagePort lifecycle
  // -----------------------------------------------------------------------

  describe('MessagePort lifecycle', () => {
    it('closes the port when the process exits', () => {
      manager.fork('terminal')
      const child = getProcess(0)
      const channel = getChannel(0)
      child.simulateSpawn(1234)

      child.simulateExit(0)

      expect(channel.port1.closed).toBe(true)
    })

    it('getPort() returns the port for a running process', () => {
      manager.fork('server')
      getProcess(0).simulateSpawn(1000)

      const port = manager.getPort('server')
      expect(port).toBeDefined()
    })

    it('getPort() returns undefined for a non-existent process', () => {
      expect(manager.getPort('server')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // isRunning()
  // -----------------------------------------------------------------------

  describe('isRunning()', () => {
    it('returns false before spawn', () => {
      manager.fork('terminal')
      expect(manager.isRunning('terminal')).toBe(false)
    })

    it('returns true after spawn', () => {
      manager.fork('terminal')
      getProcess(0).simulateSpawn(1234)
      expect(manager.isRunning('terminal')).toBe(true)
    })

    it('returns false after exit', () => {
      manager.fork('terminal')
      getProcess(0).simulateSpawn(1234)
      getProcess(0).simulateExit(0)
      expect(manager.isRunning('terminal')).toBe(false)
    })

    it('returns false for unknown service', () => {
      expect(manager.isRunning('terminal')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // getProcess()
  // -----------------------------------------------------------------------

  describe('getProcess()', () => {
    it('returns the UtilityProcess after spawn', () => {
      manager.fork('terminal')
      const child = getProcess(0)
      child.simulateSpawn(1234)

      const proc = manager.getProcess('terminal')
      expect(proc).toBeDefined()
      expect(proc).toBe(child)
    })

    it('returns undefined before spawn', () => {
      manager.fork('terminal')
      expect(manager.getProcess('terminal')).toBeUndefined()
    })

    it('returns undefined after exit', () => {
      manager.fork('terminal')
      const child = getProcess(0)
      child.simulateSpawn(1234)
      child.simulateExit(0)

      expect(manager.getProcess('terminal')).toBeUndefined()
    })

    it('returns undefined for unknown service', () => {
      expect(manager.getProcess('terminal')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Bootstrap message handling
  // -----------------------------------------------------------------------

  describe('bootstrap messages', () => {
    it('logs ready message without errors', () => {
      manager.fork('terminal')
      const child = getProcess(0)
      child.simulateSpawn(1234)

      // Should not throw.
      child.simulateMessage({ type: 'ready' })
    })

    it('logs error message without crashing', () => {
      manager.fork('terminal')
      const child = getProcess(0)
      child.simulateSpawn(1234)

      // Should not throw.
      child.simulateMessage({
        type: 'error',
        message: 'Failed to load entrypoint',
      })
    })
  })
})
