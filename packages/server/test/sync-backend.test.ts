import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import initSqlJs from 'sql.js'
import { afterAll } from 'vitest'
import {
  backfillSyncStorageFromServerEventlog,
  validatePushBatch,
} from '../src/services/sync-backend.js'

const tempDirs: string[] = []

const makeEvent = (seqNum: number, parentSeqNum: number) => ({
  args: {
    id: `project-${String(seqNum)}`,
    name: `Project ${String(seqNum)}`,
    repoPath: `/repo/${String(seqNum)}`,
  },
  clientId: 'client-1',
  name: 'v1.ProjectCreated',
  parentSeqNum,
  seqNum,
  sessionId: 'session-1',
})

afterAll(() => {
  for (const tempDir of tempDirs) {
    rmSync(tempDir, { force: true, recursive: true })
  }
})

describe('sync-backend startup backfill', () => {
  it('backfills missing history from the server eventlog', async () => {
    const SQL = await initSqlJs()
    const dataDir = mkdtempSync(join(tmpdir(), 'laborer-sync-backfill-'))
    tempDirs.push(dataDir)

    const storeId = 'laborer'
    const tableName = 'eventlog_1_laborer'
    const backendId = 'backend-1'
    const serverStoreDir = join(dataDir, storeId)

    mkdirSync(serverStoreDir, { recursive: true })

    const serverEventlogDb = new SQL.Database()
    serverEventlogDb.run(`
      CREATE TABLE eventlog (
        seqNumGlobal INTEGER NOT NULL,
        seqNumClient INTEGER NOT NULL,
        seqNumRebaseGeneration INTEGER NOT NULL,
        parentSeqNumGlobal INTEGER NOT NULL,
        parentSeqNumClient INTEGER NOT NULL,
        parentSeqNumRebaseGeneration INTEGER NOT NULL,
        name TEXT NOT NULL,
        argsJson TEXT NOT NULL,
        clientId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        schemaHash INTEGER NOT NULL,
        syncMetadataJson TEXT NOT NULL,
        PRIMARY KEY (seqNumGlobal, seqNumClient, seqNumRebaseGeneration)
      )
    `)

    const createdAt =
      '{"_tag":"Some","value":{"_tag":"SyncMessage.SyncMetadata","createdAt":"2026-04-23T00:00:00.000Z"}}'

    serverEventlogDb.run(
      'INSERT INTO eventlog (seqNumGlobal, seqNumClient, seqNumRebaseGeneration, parentSeqNumGlobal, parentSeqNumClient, parentSeqNumRebaseGeneration, name, argsJson, clientId, sessionId, schemaHash, syncMetadataJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        1,
        1,
        0,
        0,
        0,
        0,
        'v1.ProjectCreated',
        JSON.stringify({
          id: 'project-1',
          name: 'laborer',
          repoPath: '/repo/laborer',
        }),
        'server',
        'static',
        1,
        createdAt,
      ]
    )

    serverEventlogDb.run(
      'INSERT INTO eventlog (seqNumGlobal, seqNumClient, seqNumRebaseGeneration, parentSeqNumGlobal, parentSeqNumClient, parentSeqNumRebaseGeneration, name, argsJson, clientId, sessionId, schemaHash, syncMetadataJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        2,
        2,
        0,
        1,
        1,
        0,
        'v1.WorkspaceCreated',
        JSON.stringify({
          id: 'workspace-1',
          projectId: 'project-1',
          branchName: 'main',
        }),
        'server',
        'static',
        1,
        createdAt,
      ]
    )

    writeFileSync(
      join(serverStoreDir, 'eventlog@6.db'),
      Buffer.from(serverEventlogDb.export())
    )
    serverEventlogDb.close()

    const syncDb = new SQL.Database()
    syncDb.run(`
      CREATE TABLE "${tableName}" (
        seqNum INTEGER PRIMARY KEY,
        parentSeqNum INTEGER NOT NULL,
        name TEXT NOT NULL,
        args TEXT,
        createdAt TEXT NOT NULL,
        clientId TEXT NOT NULL,
        sessionId TEXT NOT NULL
      )
    `)
    syncDb.run(`
      CREATE TABLE context_1 (
        storeId TEXT PRIMARY KEY,
        currentHead INTEGER NOT NULL,
        backendId TEXT NOT NULL
      )
    `)
    syncDb.run(
      'INSERT INTO context_1 (storeId, currentHead, backendId) VALUES (?, ?, ?)',
      [storeId, 2, backendId]
    )
    syncDb.run(
      `INSERT INTO "${tableName}" (seqNum, parentSeqNum, name, args, createdAt, clientId, sessionId) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        2,
        1,
        'v1.WorkspaceCreated',
        JSON.stringify({ id: 'workspace-1', projectId: 'project-1' }),
        '2026-04-23T00:00:00.000Z',
        'server',
        'static',
      ]
    )

    const result = backfillSyncStorageFromServerEventlog({
      SQL,
      backendId,
      dataDir,
      db: syncDb,
      storeId,
      tableName,
    })

    assert.deepStrictEqual(result, { importedCount: 1, nextHead: 2 })

    const rows = syncDb.exec(
      `SELECT seqNum, name FROM "${tableName}" ORDER BY seqNum ASC`
    )[0]
    assert.deepStrictEqual(rows?.values, [
      [1, 'v1.ProjectCreated'],
      [2, 'v1.WorkspaceCreated'],
    ])

    const context = syncDb.exec(
      `SELECT currentHead, backendId FROM context_1 WHERE storeId = 'laborer'`
    )[0]
    assert.deepStrictEqual(context?.values, [[2, backendId]])

    syncDb.close()
  })
})

describe('sync-backend push validation', () => {
  it('accepts a contiguous batch after the current head', () => {
    const batch = [makeEvent(11, 10), makeEvent(12, 11)]

    assert.deepStrictEqual(validatePushBatch(batch, 10), {
      _tag: 'append',
      batch,
    })
  })

  it('acknowledges fully stale duplicate batches', () => {
    assert.deepStrictEqual(validatePushBatch([makeEvent(10, 9)], 10), {
      _tag: 'duplicate',
    })
  })

  it('rejects mixed stale and new batches instead of appending a partial tail', () => {
    assert.deepStrictEqual(
      validatePushBatch([makeEvent(11, 10), makeEvent(12, 11)], 11),
      {
        _tag: 'server-ahead',
        minimumExpectedNum: 11,
        providedNum: 10,
      }
    )
  })

  it('rejects gaps inside a pushed batch', () => {
    assert.deepStrictEqual(
      validatePushBatch([makeEvent(11, 10), makeEvent(13, 12)], 10),
      {
        _tag: 'server-ahead',
        minimumExpectedNum: 11,
        providedNum: 12,
      }
    )
  })
})
