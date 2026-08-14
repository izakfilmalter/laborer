import { createRequire } from 'node:module'
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)

export type DatabaseSync = NodeDatabaseSync
type DatabaseSyncConstructor = new (
  path: string,
  options?: { readonly timeout?: number }
) => DatabaseSync

const BunDatabaseSync = function (
  this: unknown,
  path: string,
  options?: { readonly timeout?: number }
): DatabaseSync {
  const { Database } = require('bun:sqlite') as {
    readonly Database: new (
      databasePath: string,
      databaseOptions: { readonly create: boolean; readonly strict: boolean }
    ) => DatabaseSync
  }
  const database = new Database(path, { create: true, strict: true })
  if (options?.timeout !== undefined) {
    database.exec(`PRAGMA busy_timeout = ${String(options.timeout)}`)
  }
  return database
} as unknown as DatabaseSyncConstructor

const LazyNodeDatabaseSync = function (
  this: unknown,
  path: string,
  options?: { readonly timeout?: number }
): DatabaseSync {
  const { DatabaseSync: NativeDatabaseSync } = require('node:sqlite') as {
    readonly DatabaseSync: DatabaseSyncConstructor
  }
  return options === undefined
    ? new NativeDatabaseSync(path)
    : new NativeDatabaseSync(path, options)
} as unknown as DatabaseSyncConstructor

export const DatabaseSync: DatabaseSyncConstructor =
  'bun' in process.versions ? BunDatabaseSync : LazyNodeDatabaseSync
