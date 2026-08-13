import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LaborerDatabase,
  LaborerDatabaseError,
  makeLaborerDatabaseLayer,
} from '../src/services/laborer-database.js'
import { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'

const directories: string[] = []
const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'laborer-effect-db-'))
  directories.push(directory)
  return join(directory, 'laborer.sqlite')
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('LaborerDatabase Effect adapter', () => {
  it('provides a fully migrated real in-memory database and maps failures', async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* LaborerDatabase
        expect(service.database.migrationNames()).toHaveLength(8)
        return yield* Effect.flip(
          service.run('insert task', () => {
            throw new Error('native failure')
          })
        )
      }).pipe(Effect.provide(LaborerDatabase.testLayer()))
    )
    expect(failure).toBeInstanceOf(LaborerDatabaseError)
    expect(failure).toMatchObject({ operation: 'insert task' })
  })

  it('closes the native handle when its scope ends', async () => {
    const database = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* LaborerDatabase
        return service.database
      }).pipe(Effect.provide(LaborerDatabase.testLayer()))
    )
    expect(() => database.listTasks()).toThrow()
  })

  it('registers close before migration and propagates migration failures', async () => {
    const path = databasePath()
    const seeded = NativeLaborerDatabase.open(path)
    seeded.close()
    const raw = new DatabaseSync(path)
    raw
      .prepare(`INSERT INTO __drizzle_migrations
        (hash, created_at, name) VALUES (?, ?, ?)`)
      .run('future', 1, '9999_future')
    raw.close()
    const close = vi.spyOn(NativeLaborerDatabase.prototype, 'close')

    const exit = await Effect.runPromiseExit(
      Layer.build(makeLaborerDatabaseLayer(path)).pipe(Effect.scoped)
    )
    expect(exit._tag).toBe('Failure')
    expect(close).toHaveBeenCalledOnce()
  })

  it('provides a scoped temporary-file variant', async () => {
    const path = databasePath()
    const layer = makeLaborerDatabaseLayer(path)
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* LaborerDatabase
        yield* service.run('insert project', (database) =>
          database.insertProject({
            id: 'project',
            name: 'Project',
            rootPath: '/repo',
            repoId: 'repo',
            canonicalGitCommonDir: '/repo/.git',
          })
        )
      }).pipe(Effect.provide(layer))
    )
    const reopened = NativeLaborerDatabase.open(path)
    expect(reopened.listProjects()).toHaveLength(1)
    reopened.close()

    await Effect.runPromise(
      Layer.build(LaborerDatabase.temporaryLayer()).pipe(Effect.scoped)
    )
  })
})
