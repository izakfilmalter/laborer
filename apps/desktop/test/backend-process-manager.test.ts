import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCreateWriteStream,
  mockExistsSync,
  mockMkdirSync,
  mockSpawn,
  spawnedProcesses,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as {
    EventEmitter: typeof import('node:events').EventEmitter
  }

  class MockChildProcess extends EventEmitter {
    readonly args: string[]
    readonly command: string
    readonly options: Record<string, unknown>
    readonly stderr = new EventEmitter()
    readonly stdout = new EventEmitter()
    readonly stdio: unknown[]
    exitCode: number | null = null
    signalCode: string | null = null

    constructor(
      command: string,
      args: string[],
      options: Record<string, unknown>
    ) {
      super()
      this.command = command
      this.args = args
      this.options = options
      this.stdio = [
        null,
        this.stdout,
        this.stderr,
        { end: vi.fn(), write: vi.fn() },
      ]
    }

    kill(signal?: string): boolean {
      this.signalCode = signal ?? null
      this.emit('exit', null, signal)
      return true
    }
  }

  const processes: MockChildProcess[] = []
  const spawn = vi.fn(
    (command: string, args: string[], options: Record<string, unknown>) => {
      const child = new MockChildProcess(command, args, options)
      processes.push(child)
      return child
    }
  )

  return {
    mockCreateWriteStream: vi.fn(() => ({ end: vi.fn(), write: vi.fn() })),
    mockExistsSync: vi.fn(() => true),
    mockMkdirSync: vi.fn(),
    mockSpawn: spawn,
    spawnedProcesses: processes,
  }
})

vi.mock('node:fs', () => ({
  createWriteStream: mockCreateWriteStream,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}))

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/Applications/Laborer.app/Contents/Resources/app',
    getPath: (name: string) =>
      name === 'home'
        ? '/Users/tester'
        : '/Users/tester/Library/Application Support/Laborer',
    isPackaged: true,
  },
}))

describe('BackendProcessManager', () => {
  beforeEach(() => {
    mockSpawn.mockClear()
    mockExistsSync.mockClear()
    mockMkdirSync.mockClear()
    mockCreateWriteStream.mockClear()
    spawnedProcesses.length = 0
  })

  it('starts the server backend as a Node child process with a loopback WebSocket endpoint', async () => {
    const { BackendProcessManager } = await import(
      '../src/backend-process-manager.js'
    )
    const manager = new BackendProcessManager({
      authToken: 'secret-token',
      port: 17_321,
    })

    const endpoint = manager.start()

    expect(endpoint.wsUrl).toBe('ws://127.0.0.1:17321/?token=secret-token')
    expect(mockSpawn).toHaveBeenCalledOnce()
    expect(mockExistsSync).toHaveBeenCalledWith(
      '/Applications/Laborer.app/Contents/Resources/app/packages/server/dist/main.mjs'
    )
    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/Users/tester/Library/Application Support/Laborer/logs',
      { recursive: true }
    )
    expect(spawnedProcesses[0]?.command).toBe(process.execPath)
    expect(spawnedProcesses[0]?.args).toEqual([
      '/Applications/Laborer.app/Contents/Resources/app/packages/server/dist/main.mjs',
      '--bootstrap-fd',
      '3',
    ])
    expect(spawnedProcesses[0]?.options).toMatchObject({
      cwd: '/Users/tester',
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    expect(
      (spawnedProcesses[0]?.options.env as Record<string, string>)
        .ELECTRON_RUN_AS_NODE
    ).toBe('1')
    expect(
      (spawnedProcesses[0]?.options.env as Record<string, string>)
        .LABORER_BACKEND_CHILD
    ).toBe('1')
    expect(
      (spawnedProcesses[0]?.options.env as Record<string, string>)
        .LABORER_SERVER_PORT
    ).toBeUndefined()
    expect(
      (spawnedProcesses[0]?.options.env as Record<string, string>)
        .LABORER_SERVER_AUTH_TOKEN
    ).toBeUndefined()
    expect(
      (spawnedProcesses[0]?.stdio[3] as { write: ReturnType<typeof vi.fn> })
        .write
    ).toHaveBeenCalledWith(
      `${JSON.stringify({ authToken: 'secret-token', host: '127.0.0.1', port: 17_321 })}\n`
    )

    manager.stop()
  })

  it('restarts the backend on the same port and auth token', async () => {
    vi.useFakeTimers()
    try {
      const { BackendProcessManager } = await import(
        '../src/backend-process-manager.js'
      )
      const manager = new BackendProcessManager({
        authToken: 'stable-token',
        port: 24_680,
      })

      expect(manager.start().wsUrl).toBe(
        'ws://127.0.0.1:24680/?token=stable-token'
      )
      spawnedProcesses[0]?.emit('exit', 1, null)

      await vi.advanceTimersByTimeAsync(500)

      expect(mockSpawn).toHaveBeenCalledTimes(2)
      expect(
        (spawnedProcesses[1]?.stdio[3] as { write: ReturnType<typeof vi.fn> })
          .write
      ).toHaveBeenCalledWith(
        `${JSON.stringify({ authToken: 'stable-token', host: '127.0.0.1', port: 24_680 })}\n`
      )
      expect(manager.start().wsUrl).toBe(
        'ws://127.0.0.1:24680/?token=stable-token'
      )

      manager.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
