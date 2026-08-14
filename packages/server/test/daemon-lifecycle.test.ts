import { type ChildProcess, spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface Registration {
  readonly id?: string
  readonly pid: number
  readonly url?: string
}

const roots: string[] = []
const children = new Set<ChildProcess>()

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = <T>(
  directory: string,
  read: () => T | undefined,
  timeoutMs = 10_000,
  label = 'lifecycle sentinel'
): Promise<T> =>
  new Promise((resolveValue, reject) => {
    const initial = read()
    if (initial !== undefined) {
      resolveValue(initial)
      return
    }
    const watcher = watch(directory, () => {
      const value = read()
      if (value !== undefined) {
        clearTimeout(timeout)
        watcher.close()
        resolveValue(value)
      }
    })
    const timeout = setTimeout(() => {
      watcher.close()
      reject(new Error(`${label} timed out`))
    }, timeoutMs)
  })

const readRegistration = (path: string): Registration | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Registration
  } catch {
    return undefined
  }
}

const startDaemon = (stateHome: string, port = '0'): ChildProcess => {
  const daemonEntry = resolve(import.meta.dirname, '../dist/daemon-main.mjs')
  const fakeHostEntry = resolve(
    import.meta.dirname,
    'fixtures/fake-pty-host.mjs'
  )
  const child = spawn(process.execPath, [daemonEntry], {
    env: {
      ...process.env,
      DATA_DIR: join(stateHome, 'data'),
      HOME: stateHome,
      LABORER_DAEMON_PORT: port,
      LABORER_DAEMON_SELF_EVICTION_INTERVAL_MS: '10',
      LABORER_FILE_WATCHER_BACKEND: 'fs',
      LABORER_PTY_HOST_ENTRY: fakeHostEntry,
      NODE_ENV: 'test',
      XDG_CONFIG_HOME: join(stateHome, 'config'),
      XDG_STATE_HOME: stateHome,
    },
    stdio: 'ignore',
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

const waitForExit = (child: ChildProcess): Promise<number | null> =>
  child.exitCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((resolveExit) =>
        child.once('exit', (code) => resolveExit(code))
      )

afterEach(() => {
  for (const child of children) {
    child.kill('SIGKILL')
  }
  children.clear()
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

describe('daemon lifecycle', () => {
  it('keeps the host on a restart-safe signal and stops it only via shutdown', async () => {
    const stateHome = mkdtempSync('/tmp/laborer-daemon-lifecycle-')
    roots.push(stateHome)
    const stateDir = join(stateHome, 'laborer')
    mkdirSync(stateDir, { recursive: true })
    mkdirSync(join(stateDir, 'pty-host'), { recursive: true })
    const daemonPath = join(stateDir, 'daemon.json')
    const hostPath = join(stateDir, 'pty-host', 'pty-host.json')

    const first = startDaemon(stateHome)
    const firstRegistration = await waitFor(
      stateDir,
      () => readRegistration(daemonPath),
      10_000,
      'first daemon registration'
    )
    const host = await waitFor(
      join(stateDir, 'pty-host'),
      () => readRegistration(hostPath),
      10_000,
      'host registration'
    )
    const incumbentPort = new URL(String(firstRegistration.url)).port
    const contender = startDaemon(stateHome, incumbentPort)
    expect(await waitForExit(contender)).toBe(0)
    expect(readRegistration(daemonPath)?.id).toBe(firstRegistration.id)
    first.kill('SIGTERM')
    await waitForExit(first)
    expect(processExists(host.pid)).toBe(true)

    const second = startDaemon(stateHome)
    const secondRegistration = await waitFor(
      stateDir,
      () => {
        const value = readRegistration(daemonPath)
        return value?.pid === second.pid ? value : undefined
      },
      10_000,
      'second daemon registration'
    )
    expect(readRegistration(hostPath)?.pid).toBe(host.pid)
    second.kill('SIGKILL')
    await waitForExit(second)
    expect(readRegistration(daemonPath)?.id).toBe(secondRegistration.id)
    expect(readRegistration(hostPath)?.pid).toBe(host.pid)

    const third = startDaemon(stateHome)
    const registration = await waitFor(
      stateDir,
      () => {
        const value = readRegistration(daemonPath)
        return value?.pid === third.pid ? value : undefined
      },
      10_000,
      'third daemon registration'
    )
    expect(readRegistration(hostPath)?.pid).toBe(host.pid)
    expect(registration.url).toBeTypeOf('string')
    const response = await fetch(`${String(registration.url)}/daemon/stop`, {
      body: JSON.stringify({ mode: 'shutdown' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(202)
    await waitForExit(third)
    await waitFor(
      join(stateDir, 'pty-host'),
      () => (readRegistration(hostPath) === undefined ? true : undefined),
      10_000,
      'host shutdown registration removal'
    )
  })

  it('self-evicts when its registration is superseded', async () => {
    const stateHome = mkdtempSync('/tmp/laborer-daemon-eviction-')
    roots.push(stateHome)
    const stateDir = join(stateHome, 'laborer')
    mkdirSync(stateDir, { recursive: true })
    const registrationPath = join(stateDir, 'daemon.json')
    const child = startDaemon(stateHome)
    const registration = await waitFor(stateDir, () =>
      readRegistration(registrationPath)
    )
    writeFileSync(
      registrationPath,
      JSON.stringify({ ...registration, id: 'winner' })
    )
    expect(await waitForExit(child)).not.toBeNull()
    expect(readRegistration(registrationPath)?.id).toBe('winner')
  })
})
