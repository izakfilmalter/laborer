/**
 * Review comments ride the shared state ledger, so a human watching the diff
 * pane sees an agent's MCP reply arrive without asking for it again.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SharedStateUpdate } from '@laborer/shared/rpc'
import { Deferred, Effect, Fiber, Layer, Stream } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentTaskService } from '../src/services/agent-task-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { HUMAN_AUTHOR } from '../src/services/review-comments.js'
import { subscribeToSharedState } from '../src/services/shared-state-reader.js'

const directories: string[] = []

const draft = {
  body: 'Rename this to something honest',
  endLine: 12,
  filePath: 'src/app.ts',
  side: 'additions',
  startLine: 10,
  workspaceId: 'workspace-1',
} as const

/** A project with one ready worktree and one open review conversation. */
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'laborer-liveness-')))
  directories.push(root)
  const worktreePath = join(root, 'worktrees', 'feature')
  mkdirSync(worktreePath, { recursive: true })
  const path = join(root, 'laborer.sqlite')
  const database = NativeLaborerDatabase.open(path)
  database.insertProject({
    canonicalGitCommonDir: root,
    id: 'project-1',
    name: 'Project',
    repoId: 'repo-1',
    rootPath: root,
  })
  database.insertTask({
    branchName: 'feature',
    id: 'workspace-1',
    rootPath: root,
    source: 'manual',
    status: 'in_progress',
    title: 'Feature',
    worktreePath,
    worktreeStatus: 'ready',
  })
  const { row: thread } = database.createReviewCommentThread(
    draft,
    HUMAN_AUTHOR,
    'operation-open'
  )
  database.close()
  const layer = AgentTaskService.layer(path).pipe(
    Layer.provideMerge(LaborerDatabase.layer(path).pipe(Layer.orDie))
  )
  return { layer, path, thread, worktreePath }
}

/** The first update is the snapshot; the rest are ledger deltas. */
const collectAfterSnapshot = (
  path: string,
  count: number,
  write: Effect.Effect<void>
): Promise<readonly SharedStateUpdate[]> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const fiber = yield* subscribeToSharedState(path, 10_000).pipe(
          Stream.tap(() => Deferred.succeed(started, undefined)),
          Stream.take(count),
          Stream.runCollect,
          Effect.forkScoped
        )
        yield* Deferred.await(started)
        yield* write
        return Array.from(yield* Fiber.join(fiber))
      })
    )
  )

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('review comment liveness', () => {
  it('publishes every open conversation in the state snapshot', async () => {
    const { path, thread } = fixture()
    const [snapshot] = await collectAfterSnapshot(path, 1, Effect.void)
    expect(snapshot?.reviewComments?.type).toBe('snapshot')
    expect(snapshot?.reviewComments?.rows.map(({ id }) => id)).toEqual([
      thread.id,
    ])
  })

  it("publishes the agent's MCP reply as a delta carrying the thread", async () => {
    const { layer, path, thread, worktreePath } = fixture()
    const events = await collectAfterSnapshot(
      path,
      2,
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        const listed = yield* service.listReviewComments({
          path: worktreePath,
        })
        yield* service.replyToReviewComment({
          body: 'Renamed it to `pendingReplies`',
          threadId: listed[0]?.id ?? '',
        })
      }).pipe(Effect.provide(layer), Effect.orDie)
    )

    const delta = events[1]?.reviewComments
    expect(delta?.type).toBe('delta')
    expect(delta?.rows[0]?.id).toBe(thread.id)
    expect(delta?.rows[0]?.replies.map(({ author }) => author)).toEqual([
      'human',
      'agent',
    ])
    // Every agent write carries an operation id, like the rest of this ledger.
    expect(
      delta?.type === 'delta' ? delta.operationIds?.length : 0
    ).toBeGreaterThan(0)
  })

  it("publishes the agent's resolve and retires a deleted thread", async () => {
    const { layer, path, thread } = fixture()
    const events = await collectAfterSnapshot(
      path,
      3,
      Effect.gen(function* () {
        const service = yield* AgentTaskService
        yield* service.resolveReviewComment(thread.id, thread.revision)
        const database = yield* LaborerDatabase
        yield* database.read('delete thread', (native) =>
          native.deleteReviewCommentThread(
            thread.id,
            thread.revision + 1,
            'operation-delete'
          )
        )
      }).pipe(Effect.provide(layer), Effect.orDie)
    )

    expect(events[1]?.reviewComments?.rows[0]?.status).toBe('resolved')
    const deleted = events[2]?.reviewComments
    expect(deleted?.type === 'delta' ? deleted.deletedRowIds : []).toEqual([
      thread.id,
    ])
    expect(deleted?.type === 'delta' ? deleted.operationIds : []).toEqual([
      'operation-delete',
    ])
  })
})
