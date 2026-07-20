import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createdLogStreams,
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

  /**
   * Fake WriteStream that can emit `error` events like the real one.
   */
  type MockLogStream = InstanceType<typeof EventEmitter> & {
    end: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
  }

  const logStreams: MockLogStream[] = []
  const createWriteStream = vi.fn(() => {
    const stream = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      write: vi.fn(),
    }) as MockLogStream
    logStreams.push(stream)
    return stream
  })

  return {
    createdLogStreams: logStreams,
    mockCreateWriteStream: createWriteStream,
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
    createdLogStreams.length = 0
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
    const readyPromise = manager.waitUntilReady()
    spawnedProcesses[0]?.stdout.emit(
      'data',
      Buffer.from('[server-main] Listening on http://127.0.0.1:17321\n')
    )

    await readyPromise

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

      const endpoint = manager.start()
      const readyPromise = manager.waitUntilReady()
      spawnedProcesses[0]?.stdout.emit(
        'data',
        Buffer.from('[server-main] Listening on http://127.0.0.1:24680\n')
      )
      expect(endpoint).toMatchObject({
        wsUrl: 'ws://127.0.0.1:24680/?token=stable-token',
      })
      await readyPromise
      spawnedProcesses[0]?.emit('exit', 1, null)

      await vi.advanceTimersByTimeAsync(500)

      expect(mockSpawn).toHaveBeenCalledTimes(2)
      expect(
        (spawnedProcesses[1]?.stdio[3] as { write: ReturnType<typeof vi.fn> })
          .write
      ).toHaveBeenCalledWith(
        `${JSON.stringify({ authToken: 'stable-token', host: '127.0.0.1', port: 24_680 })}\n`
      )
      const restartedEndpoint = manager.start()
      const restartedReadyPromise = manager.waitUntilReady()
      spawnedProcesses[1]?.stdout.emit(
        'data',
        Buffer.from('[server-main] Listening on http://127.0.0.1:24680\n')
      )
      expect(restartedEndpoint).toMatchObject({
        wsUrl: 'ws://127.0.0.1:24680/?token=stable-token',
      })
      await restartedReadyPromise

      manager.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps capturing backend logs after the log stream errors', async () => {
    vi.useFakeTimers()
    try {
      const { BACKEND_LOG_REOPEN_MIN_INTERVAL_MS, BackendProcessManager } =
        await import('../src/backend-process-manager.js')
      const manager = new BackendProcessManager({
        authToken: 'secret-token',
        port: 17_321,
      })
      manager.start()

      const firstStream = createdLogStreams[0]
      expect(firstStream).toBeDefined()

      // Logs flow into backend.log normally.
      const beforeError = Buffer.from('before error\n')
      spawnedProcesses[0]?.stdout.emit('data', beforeError)
      expect(firstStream?.write).toHaveBeenCalledWith(beforeError)

      // The write stream dies (e.g. EIO write error after sleep).
      firstStream?.emit(
        'error',
        Object.assign(new Error('write EIO'), { code: 'EIO', syscall: 'write' })
      )

      // After the reopen interval, the next chunk reopens backend.log
      // and is captured by the fresh stream.
      vi.advanceTimersByTime(BACKEND_LOG_REOPEN_MIN_INTERVAL_MS)
      const afterError = Buffer.from('after error\n')
      spawnedProcesses[0]?.stdout.emit('data', afterError)

      expect(mockCreateWriteStream).toHaveBeenCalledTimes(2)
      expect(createdLogStreams[1]?.write).toHaveBeenCalledWith(afterError)

      manager.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('throttles log stream reopen attempts', async () => {
    vi.useFakeTimers()
    try {
      const { BACKEND_LOG_REOPEN_MIN_INTERVAL_MS, BackendProcessManager } =
        await import('../src/backend-process-manager.js')
      const manager = new BackendProcessManager({
        authToken: 'secret-token',
        port: 17_321,
      })
      manager.start()

      createdLogStreams[0]?.emit(
        'error',
        Object.assign(new Error('write ENOSPC'), {
          code: 'ENOSPC',
          syscall: 'write',
        })
      )

      // Chunks arriving within the throttle window must not reopen.
      spawnedProcesses[0]?.stdout.emit('data', Buffer.from('one\n'))
      vi.advanceTimersByTime(BACKEND_LOG_REOPEN_MIN_INTERVAL_MS - 1)
      spawnedProcesses[0]?.stdout.emit('data', Buffer.from('two\n'))
      expect(mockCreateWriteStream).toHaveBeenCalledTimes(1)

      // Once the window has elapsed, the next chunk reopens.
      vi.advanceTimersByTime(1)
      spawnedProcesses[0]?.stdout.emit('data', Buffer.from('three\n'))
      expect(mockCreateWriteStream).toHaveBeenCalledTimes(2)

      manager.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives stdout/stderr pipe errors without crashing', async () => {
    const { BackendProcessManager } = await import(
      '../src/backend-process-manager.js'
    )
    const manager = new BackendProcessManager({
      authToken: 'secret-token',
      port: 17_321,
    })
    manager.start()

    const pipeError = Object.assign(new Error('read EIO'), {
      code: 'EIO',
      syscall: 'read',
    })
    expect(() =>
      spawnedProcesses[0]?.stdout.emit('error', pipeError)
    ).not.toThrow()
    expect(() =>
      spawnedProcesses[0]?.stderr.emit('error', pipeError)
    ).not.toThrow()

    // Log capture still works afterwards.
    const chunk = Buffer.from('still alive\n')
    spawnedProcesses[0]?.stdout.emit('data', chunk)
    expect(createdLogStreams[0]?.write).toHaveBeenCalledWith(chunk)

    manager.stop()
  })

  it('closes the log stream on stop', async () => {
    const { BackendProcessManager } = await import(
      '../src/backend-process-manager.js'
    )
    const manager = new BackendProcessManager({
      authToken: 'secret-token',
      port: 17_321,
    })
    manager.start()
    manager.stop()

    expect(createdLogStreams[0]?.end).toHaveBeenCalled()
  })
})
