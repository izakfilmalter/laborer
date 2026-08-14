import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export type EnsurePolicy = 'adopt' | 'exclusive-fail' | 'exclusive-replace'

export interface ProcessRegistration {
  readonly pid: number
  readonly startedAt: string
  readonly version: string
}

export interface DaemonRegistration extends ProcessRegistration {
  readonly id: string
  readonly url: string
}

export interface PtyHostRegistration extends ProcessRegistration {
  readonly epoch: string
  readonly socketPath: string
}

export interface EnsureOptions<T extends ProcessRegistration> {
  readonly health: (registration: T) => Promise<boolean>
  readonly policy: EnsurePolicy
  readonly readRegistration: () => T | null
  readonly spawn: () => Promise<number | undefined> | number | undefined
  readonly stop?: (registration: T) => Promise<void>
  readonly timeoutMs?: number
}

export class EnsureConflictError extends Error {
  readonly registration: ProcessRegistration

  constructor(registration: ProcessRegistration) {
    const address =
      'url' in registration && typeof registration.url === 'string'
        ? ` at ${registration.url}`
        : ''
    super(
      `A healthy process is already running (pid ${String(registration.pid)}${address}); stop that session first`
    )
    this.name = 'EnsureConflictError'
    this.registration = registration
  }
}

const sleep = (duration: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, duration))

export const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'EPERM'
    )
  }
}

export const findHealthyRegistration = async <T extends ProcessRegistration>(
  readRegistration: () => T | null,
  health: (registration: T) => Promise<boolean>
): Promise<T | null> => {
  const registration = readRegistration()
  return registration !== null &&
    processExists(registration.pid) &&
    (await health(registration))
    ? registration
    : null
}

export const ensure = async <T extends ProcessRegistration>(
  options: EnsureOptions<T>
): Promise<T> => {
  const incumbent = await findHealthyRegistration(
    options.readRegistration,
    options.health
  )
  if (incumbent !== null) {
    if (options.policy === 'adopt') {
      return incumbent
    }
    if (options.policy === 'exclusive-fail') {
      throw new EnsureConflictError(incumbent)
    }
    if (options.stop === undefined) {
      throw new Error('exclusive-replace requires a stop implementation')
    }
    await options.stop(incumbent)
  }

  const spawnedPid = await options.spawn()
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  while (Date.now() < deadline) {
    const candidate = await findHealthyRegistration(
      options.readRegistration,
      options.health
    )
    if (candidate !== null) {
      if (
        options.policy === 'exclusive-fail' &&
        spawnedPid !== undefined &&
        candidate.pid !== spawnedPid
      ) {
        throw new EnsureConflictError(candidate)
      }
      return candidate
    }
    await sleep(25)
  }
  throw new Error('Timed out waiting for ensured process health')
}

const isBaseRegistration = (
  value: unknown
): value is Record<string, unknown> & ProcessRegistration =>
  typeof value === 'object' &&
  value !== null &&
  Number.isInteger(Reflect.get(value, 'pid')) &&
  Number(Reflect.get(value, 'pid')) > 0 &&
  typeof Reflect.get(value, 'startedAt') === 'string' &&
  !Number.isNaN(Date.parse(String(Reflect.get(value, 'startedAt')))) &&
  typeof Reflect.get(value, 'version') === 'string' &&
  String(Reflect.get(value, 'version')).length > 0

const isLoopbackHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false
  }
  try {
    const url = new URL(value)
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
      url.username === '' &&
      url.password === '' &&
      url.port !== '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

const hasOnlyKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  )
}

export const isDaemonRegistration = (
  value: unknown
): value is DaemonRegistration =>
  isBaseRegistration(value) &&
  hasOnlyKeys(value, ['id', 'pid', 'startedAt', 'url', 'version']) &&
  typeof Reflect.get(value, 'id') === 'string' &&
  String(Reflect.get(value, 'id')).length > 0 &&
  isLoopbackHttpUrl(Reflect.get(value, 'url'))

export const isPtyHostRegistration = (
  value: unknown
): value is PtyHostRegistration =>
  isBaseRegistration(value) &&
  hasOnlyKeys(value, ['epoch', 'pid', 'socketPath', 'startedAt', 'version']) &&
  typeof Reflect.get(value, 'epoch') === 'string' &&
  String(Reflect.get(value, 'epoch')).length > 0 &&
  typeof Reflect.get(value, 'socketPath') === 'string' &&
  String(Reflect.get(value, 'socketPath')).startsWith('/')

export const readJsonRegistration = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export const readDaemonRegistration = (
  path: string
): DaemonRegistration | null => {
  const value = readJsonRegistration<unknown>(path)
  return isDaemonRegistration(value) ? value : null
}

export const readPtyHostRegistration = (
  path: string
): PtyHostRegistration | null => {
  const value = readJsonRegistration<unknown>(path)
  return isPtyHostRegistration(value) ? value : null
}

/** Atomic, owner-only registration write shared by daemon and pty-host edges. */
export const writeJsonRegistration = <T extends ProcessRegistration>(
  path: string,
  registration: T
): void => {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(registration)}\n`)
  } finally {
    closeSync(descriptor)
  }
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

export const removeRegistration = (path: string): void => {
  rmSync(path, { force: true })
}

export interface RegistrationOwnershipWatch {
  readonly check: () => boolean
  readonly dispose: () => void
}

/** Re-read registration so a superseded process evicts itself. */
export const watchRegistrationOwnership = <
  T extends ProcessRegistration,
>(options: {
  readonly intervalMs?: number
  readonly isOwner: (registration: T) => boolean
  readonly onEvicted: () => void
  readonly readRegistration: () => T | null
}): RegistrationOwnershipWatch => {
  let disposed = false
  const check = (): boolean => {
    if (disposed) {
      return true
    }
    const registration = options.readRegistration()
    const owned = registration !== null && options.isOwner(registration)
    if (!owned) {
      disposed = true
      clearInterval(interval)
      options.onEvicted()
    }
    return owned
  }
  const interval = setInterval(check, options.intervalMs ?? 5000)
  interval.unref()
  return {
    check,
    dispose: () => {
      disposed = true
      clearInterval(interval)
    },
  }
}

const waitUntilGone = async (
  pid: number,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (processExists(pid) && Date.now() < deadline) {
    await sleep(25)
  }
  return !processExists(pid)
}

/** Explicit stop RPC followed by bounded TERM/KILL escalation. */
export const stopWithEscalation = async <T extends ProcessRegistration>(
  registration: T,
  options: {
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void
    readonly requestStop: (registration: T) => Promise<void>
    readonly requestTimeoutMs?: number
    readonly rpcGraceMs?: number
    readonly signalGraceMs?: number
    readonly waitUntilGone?: (
      pid: number,
      timeoutMs: number
    ) => Promise<boolean>
  }
): Promise<void> => {
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  const wait = options.waitUntilGone ?? waitUntilGone
  await new Promise<void>((resolveRequest) => {
    const timeout = setTimeout(resolveRequest, options.requestTimeoutMs ?? 5000)
    Promise.resolve()
      .then(() => options.requestStop(registration))
      .then(
        () => {
          clearTimeout(timeout)
          resolveRequest()
        },
        () => {
          clearTimeout(timeout)
          resolveRequest()
        }
      )
  })
  if (await wait(registration.pid, options.rpcGraceMs ?? 5000)) {
    return
  }
  try {
    kill(registration.pid, 'SIGTERM')
  } catch {
    return
  }
  if (await wait(registration.pid, options.signalGraceMs ?? 5000)) {
    return
  }
  try {
    kill(registration.pid, 'SIGKILL')
  } catch {
    // It exited between the final observation and signal.
  }
}
