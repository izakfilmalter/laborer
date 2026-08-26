/**
 * Authorship is a property of the boundary that wrote a reply, never of its
 * payload: no RPC payload, MCP tool parameter, or service input carries an
 * author. These cases pin that down from both sides.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { RpcError } from '@laborer/shared/rpc'
import { Effect, Layer } from 'effect'
import {
  handleReviewCommentCreate,
  handleReviewCommentDelete,
  handleReviewCommentList,
  handleReviewCommentReply,
  handleReviewCommentSetStatus,
  handleReviewCommentUpdate,
} from '../src/rpc/handlers.js'
import { AgentTaskService } from '../src/services/agent-task-service.js'
import { LaborerDatabase } from '../src/services/laborer-database.js'
import { NativeLaborerDatabase } from '../src/services/native-laborer-database.js'
import { AGENT_AUTHOR } from '../src/services/review-comments.js'

const TestDatabase = LaborerDatabase.temporaryLayer()

const draft = {
  body: 'Rename this to something honest',
  endLine: 12,
  filePath: 'src/app.ts',
  side: 'additions',
  startLine: 10,
  workspaceId: 'workspace-1',
} as const

/** A project with one ready worktree, so a path resolves to a workspace. */
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'laborer-review-')))
  const worktreePath = join(root, 'worktrees', 'feature')
  mkdirSync(worktreePath, { recursive: true })
  writeFileSync(join(root, 'laborer.json'), '{"shortName":"RVW"}\n')
  const databasePath = join(root, 'laborer.sqlite')
  const database = NativeLaborerDatabase.open(databasePath)
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
  database.close()
  const layer = AgentTaskService.layer(databasePath).pipe(
    Layer.provideMerge(LaborerDatabase.layer(databasePath).pipe(Layer.orDie))
  )
  return { layer, worktreePath }
}

describe('review comment boundaries', () => {
  it.effect('records every web-authored reply as human', () =>
    Effect.gen(function* () {
      const { row: opened } = yield* handleReviewCommentCreate({
        ...draft,
        operationId: 'operation-1',
      })
      const { row: answered } = yield* handleReviewCommentReply({
        body: 'And here too',
        operationId: 'operation-2',
        threadId: opened.id,
      })
      assert.deepStrictEqual(
        answered.replies.map(({ author }) => author),
        ['human', 'human']
      )
    }).pipe(Effect.provide(TestDatabase))
  )

  it.effect("refuses to let the web rewrite the agent's words", () =>
    Effect.gen(function* () {
      const { row: opened } = yield* handleReviewCommentCreate({
        ...draft,
        operationId: 'operation-1',
      })
      const database = yield* LaborerDatabase
      const { row: answered } = yield* database.read(
        'agent replies',
        (native) =>
          native.appendReviewCommentReply(
            { body: 'Renamed it', threadId: opened.id },
            AGENT_AUTHOR
          )
      )
      const agentReply = answered.replies.find(
        ({ author }) => author === 'agent'
      )
      const failure = yield* handleReviewCommentUpdate({
        body: 'No you did not',
        operationId: 'operation-3',
        replyId: agentReply?.id ?? '',
      }).pipe(Effect.flip)
      assert.instanceOf(failure, RpcError)
      assert.strictEqual(failure.code, 'AUTHOR_MISMATCH')
    }).pipe(Effect.provide(TestDatabase))
  )

  it.effect('hides resolved threads, and reports a stale revision', () =>
    Effect.gen(function* () {
      const { row: opened } = yield* handleReviewCommentCreate({
        ...draft,
        operationId: 'operation-1',
      })
      const stale = yield* handleReviewCommentSetStatus({
        expectedRevision: opened.revision + 5,
        operationId: 'operation-2',
        status: 'resolved',
        threadId: opened.id,
      }).pipe(Effect.flip)
      assert.strictEqual(stale.code, 'CAS_CONFLICT')

      yield* handleReviewCommentSetStatus({
        expectedRevision: opened.revision,
        operationId: 'operation-3',
        status: 'resolved',
        threadId: opened.id,
      })
      const open = yield* handleReviewCommentList({
        workspaceId: 'workspace-1',
      })
      assert.deepStrictEqual(open.rows, [])
      const all = yield* handleReviewCommentList({
        includeResolved: true,
        workspaceId: 'workspace-1',
      })
      assert.strictEqual(all.rows.length, 1)

      yield* handleReviewCommentDelete({
        expectedRevision: all.rows[0]?.revision ?? 0,
        operationId: 'operation-4',
        threadId: opened.id,
      })
      const gone = yield* handleReviewCommentList({
        includeResolved: true,
        workspaceId: 'workspace-1',
      })
      assert.deepStrictEqual(gone.rows, [])
    }).pipe(Effect.provide(TestDatabase))
  )

  it('records every MCP-authored reply as agent, scoped by worktree path', async () => {
    const { layer, worktreePath } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleReviewCommentCreate({
          ...draft,
          operationId: 'operation-1',
        })
        const service = yield* AgentTaskService

        const listed = yield* service.listReviewComments({
          path: worktreePath,
        })
        assert.strictEqual(listed.length, 1)
        const thread = listed[0]
        assert.deepStrictEqual(
          thread?.replies.map(({ author }) => author),
          ['human']
        )

        const answered = yield* service.replyToReviewComment({
          body: 'Renamed it to `pendingReplies`',
          threadId: thread?.id ?? '',
        })
        assert.deepStrictEqual(
          answered.replies.map(({ author }) => author),
          ['human', 'agent']
        )

        const resolved = yield* service.resolveReviewComment(
          answered.id,
          answered.revision
        )
        assert.strictEqual(resolved.status, 'resolved')

        const stale = yield* service
          .resolveReviewComment(answered.id, answered.revision)
          .pipe(Effect.flip)
        assert.strictEqual(stale.code, 'CAS_CONFLICT')
        assert.deepStrictEqual(
          yield* service.listReviewComments({ path: worktreePath }),
          []
        )
      }).pipe(Effect.provide(layer))
    )
  })
})
