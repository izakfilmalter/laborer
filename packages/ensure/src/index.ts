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
  readonly epoch?: string
  readonly id?: string
  readonly pid: number
  readonly socketPath?: string
  readonly startedAt: string
  readonly url?: string
  readonly version: string
}

export interface EnsureOptions<T extends ProcessRegistration> {
  readonly health: (registration: T) => Promise<boolean>
  readonly policy: EnsurePolicy
  readonly readRegistration: () => T | null
  readonly spawn: () => Promise<void> | void
  readonly stop?: (registration: T) => Promise<void>
  readonly timeoutMs?: number
}

export class EnsureConflictError extends Error {
  readonly registration: ProcessRegistration

  constructor(registration: ProcessRegistration) {
    super(`A healthy process is already running (pid ${registration.pid})`)
    this.name = 'EnsureConflictError'
    this.registration = registration
  }
}

const sleep = (duration: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, duration))

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const ensure = async <T extends ProcessRegistration>(
  options: EnsureOptions<T>
): Promise<T> => {
  const incumbent = options.readRegistration()
  if (
    incumbent !== null &&
    processExists(incumbent.pid) &&
    (await options.health(incumbent))
  ) {
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

  await options.spawn()
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  while (Date.now() < deadline) {
    const candidate = options.readRegistration()
    if (
      candidate !== null &&
      processExists(candidate.pid) &&
      (await options.health(candidate))
    ) {
      return candidate
    }
    await sleep(25)
  }
  throw new Error('Timed out waiting for ensured process health')
}

export const readJsonRegistration = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Atomic, owner-only registration write shared by daemon and pty-host edges. */
export const writeJsonRegistration = (
  path: string,
  registration: ProcessRegistration
): void => {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(registration)}\n`)
  } finally {
    // writeFileSync does not own descriptors supplied as numbers.
    closeSync(descriptor)
  }
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

export const removeRegistration = (path: string): void => {
  rmSync(path, { force: true })
}
