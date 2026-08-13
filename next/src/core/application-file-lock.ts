import { randomInt, randomUUID } from 'node:crypto'
import { chmod, link, lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  assertSafeFilePath,
  type RetainedDirectory,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from './path-safety.ts'

const LOCK_DATABASE_SUFFIX = '.lock.sqlite'
const LOCK_WAIT_MILLIS = 5000
const LOCK_RETRY_MILLIS = 5
const LOCK_MAX_RETRY_MILLIS = 100

interface LockIdentity {
  readonly device: bigint | number
  readonly inode: bigint | number
}

interface HeldLock {
  readonly assertOwned: () => Promise<void>
  readonly database: DatabaseSync
  readonly directory: RetainedDirectory
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined

const assertNotCancelled = (signal: AbortSignal): void => {
  signal.throwIfAborted()
}

const cancellableDelay = (
  milliseconds: number,
  signal: AbortSignal
): Promise<void> =>
  new Promise((resolveDelay, rejectDelay) => {
    if (signal.aborted) {
      rejectDelay(signal.reason)
      return
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveDelay()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timeout)
      rejectDelay(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

const isSqliteContention = (error: unknown): boolean => {
  const code = errorCode(error)
  const resultCode =
    typeof error === 'object' &&
    error !== null &&
    'errcode' in error &&
    typeof error.errcode === 'number'
      ? error.errcode
      : null
  return (
    code?.startsWith('SQLITE_BUSY') === true ||
    code?.startsWith('SQLITE_LOCKED') === true ||
    resultCode === 5 ||
    resultCode === 6 ||
    (error instanceof Error &&
      (error.message.includes('database is locked') ||
        error.message.includes('database table is locked')))
  )
}

const assertOwnerOnlyRegularFile = async (
  path: string,
  expected?: LockIdentity
): Promise<LockIdentity> => {
  const metadata = await lstat(path)
  const currentUserId = process.getuid?.()
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (currentUserId !== undefined && metadata.uid !== currentUserId) ||
    (expected !== undefined &&
      (metadata.dev !== expected.device || metadata.ino !== expected.inode))
  ) {
    throw new Error('application state lock identity is unsafe')
  }
  await chmod(path, 0o600)
  return { device: metadata.dev, inode: metadata.ino }
}

const ensureLockDatabase = async (
  targetPath: string,
  trustedRoot: string | undefined,
  directory: RetainedDirectory
): Promise<{ readonly identity: LockIdentity; readonly path: string }> => {
  await verifyRetainedDirectory(directory, 'prepare-application-state-lock')
  const canonicalTarget = resolve(directory.path, basename(targetPath))
  const path = `${canonicalTarget}${LOCK_DATABASE_SUFFIX}`
  await assertSafeFilePath({
    ...(trustedRoot === undefined ? {} : { anchor: trustedRoot }),
    operation: 'prepare-application-state-lock',
    path,
  })
  let identity: LockIdentity | undefined
  try {
    identity = await assertOwnerOnlyRegularFile(path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error
    }
  }
  if (identity !== undefined) {
    await verifyRetainedDirectory(directory, 'prepare-application-state-lock')
    return { identity, path }
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  let temporaryDatabase: DatabaseSync | undefined
  try {
    temporaryDatabase = new DatabaseSync(temporaryPath, {
      defensive: true,
      timeout: 0,
    })
    temporaryDatabase.exec(
      'CREATE TABLE lock_guard (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))'
    )
    temporaryDatabase.close()
    temporaryDatabase = undefined
    await chmod(temporaryPath, 0o600)
    try {
      await link(temporaryPath, path)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error
      }
    }
  } finally {
    temporaryDatabase?.close()
    await rm(temporaryPath, { force: true })
  }
  await verifyRetainedDirectory(directory, 'prepare-application-state-lock')
  return { identity: await assertOwnerOnlyRegularFile(path), path }
}

const acquireLock = async (options: {
  readonly beforeLock?: () => Promise<void>
  readonly beforeLockDatabase?: () => Promise<void>
  readonly signal: AbortSignal
  readonly targetPath: string
  readonly trustedRoot?: string
}): Promise<HeldLock> => {
  assertNotCancelled(options.signal)
  await options.beforeLock?.()
  assertNotCancelled(options.signal)
  const directory = await retainTrustedDirectory(
    await realpath(dirname(options.targetPath)),
    'prepare-application-state-lock'
  )
  let database: DatabaseSync | undefined
  try {
    await options.beforeLockDatabase?.()
    assertNotCancelled(options.signal)
    const lock = await ensureLockDatabase(
      options.targetPath,
      options.trustedRoot,
      directory
    )
    await verifyRetainedDirectory(directory, 'open-application-state-lock')
    const openedDatabase = new DatabaseSync(lock.path, {
      defensive: true,
      timeout: 0,
    })
    database = openedDatabase
    await verifyRetainedDirectory(directory, 'open-application-state-lock')
    await assertOwnerOnlyRegularFile(lock.path, lock.identity)
    openedDatabase.exec('PRAGMA busy_timeout = 0')
    const deadline = Date.now() + LOCK_WAIT_MILLIS
    let retryMillis = LOCK_RETRY_MILLIS
    while (Date.now() < deadline) {
      assertNotCancelled(options.signal)
      try {
        openedDatabase.exec('BEGIN IMMEDIATE')
        const assertOwned = async (): Promise<void> => {
          assertNotCancelled(options.signal)
          await verifyRetainedDirectory(
            directory,
            'assert-application-state-lock'
          )
          if (!openedDatabase.isTransaction) {
            throw new Error('application state lock was lost')
          }
          await assertOwnerOnlyRegularFile(lock.path, lock.identity)
        }
        await assertOwned()
        return { assertOwned, database: openedDatabase, directory }
      } catch (error) {
        if (!isSqliteContention(error)) {
          throw error
        }
      }
      const remainingMillis = deadline - Date.now()
      if (remainingMillis <= 0) {
        break
      }
      const jitter = randomInt(0, Math.max(2, Math.ceil(retryMillis / 4)))
      await cancellableDelay(
        Math.min(remainingMillis, retryMillis + jitter),
        options.signal
      )
      retryMillis = Math.min(
        LOCK_MAX_RETRY_MILLIS,
        Math.ceil(retryMillis * 1.5)
      )
    }
    throw new Error('application state lock timed out')
  } catch (error) {
    database?.close()
    await directory.handle.close()
    throw error
  }
}

export const withApplicationFileLock = async <A>(
  options: {
    readonly beforeLock?: () => Promise<void>
    readonly beforeLockDatabase?: () => Promise<void>
    readonly signal: AbortSignal
    readonly targetPath: string
    readonly trustedRoot?: string
  },
  operation: (assertOwned: () => Promise<void>) => Promise<A>
): Promise<A> => {
  const held = await acquireLock(options)
  try {
    await held.assertOwned()
    const result = await operation(held.assertOwned)
    await held.assertOwned()
    held.database.exec('ROLLBACK')
    return result
  } catch (error) {
    if (held.database.isTransaction) {
      try {
        held.database.exec('ROLLBACK')
      } catch {
        // Preserve the operation failure.
      }
    }
    throw error
  } finally {
    held.database.close()
    await held.directory.handle.close()
  }
}
