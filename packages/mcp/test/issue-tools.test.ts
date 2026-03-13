import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { LaborerRpcClient } from '../src/services/laborer-rpc-client.js'
import { ProjectDiscovery } from '../src/services/project-discovery.js'
import { IssueTools, makeIssueToolHandlers } from '../src/tools/issue-tools.js'

const project = {
  id: 'project-1',
  name: 'laborer',
  repoPath: '/repo/laborer',
  brrrConfig: undefined,
} as const

const task = {
  id: 'task-1',
  projectId: project.id,
  source: 'prd',
  prdId: 'prd-1',
  externalId: 'prd-1-issue-1',
  title: 'Implement issue tools',
  status: 'pending',
} as const

const issuesMarkdown =
  '## Issue 1: Implement issue tools\n\n### What to build\n\nAdd MCP issue tools.'

const makeProjectDiscoveryLayer = () =>
  Layer.succeed(
    ProjectDiscovery,
    ProjectDiscovery.of({
      discoverProject: () => Effect.succeed(project),
    })
  )

const makeLaborerRpcClientLayer = (
  overrides: Partial<LaborerRpcClient['Type']> = {}
) =>
  Layer.succeed(
    LaborerRpcClient,
    LaborerRpcClient.of({
      createIssue: () => Effect.succeed(task),
      createPrd: () => Effect.die('Not implemented in this test'),
      listProjects: () => Effect.succeed([project]),
      listRemainingIssues: () => Effect.succeed([task]),
      listPrds: () => Effect.die('Not implemented in this test'),
      readPrd: () => Effect.die('Not implemented in this test'),
      readIssues: () => Effect.succeed(issuesMarkdown),
      updateIssue: () => Effect.succeed({ ...task, status: 'completed' }),
      updatePrd: () => Effect.die('Not implemented in this test'),
      ...overrides,
    })
  )

const makeToolkit = (rpcOverrides: Partial<LaborerRpcClient['Type']> = {}) =>
  IssueTools.pipe(
    Effect.provide(
      IssueTools.toLayer(makeIssueToolHandlers).pipe(
        Layer.provide(makeProjectDiscoveryLayer()),
        Layer.provide(makeLaborerRpcClientLayer(rpcOverrides))
      )
    )
  )

describe('IssueTools', () => {
  it.effect('registers the expected MCP issue tools', () =>
    Effect.sync(() => {
      assert.deepStrictEqual(Object.keys(IssueTools.tools), [
        'create_issue',
        'read_issues',
        'update_issue',
        'list_remaining_issues',
      ])

      assert.include(
        IssueTools.tools.create_issue.description,
        'issues markdown file'
      )
      assert.include(
        IssueTools.tools.list_remaining_issues.description,
        'pending or in-progress'
      )
    })
  )

  it.effect('create_issue returns the created task', () =>
    Effect.gen(function* () {
      const toolkit = yield* makeToolkit()

      const result = yield* toolkit.handle('create_issue', {
        prdId: task.prdId,
        title: task.title,
        body: '### What to build\n\nAdd MCP issue tools.',
      })

      assert.strictEqual(result.result.id, task.id)
      assert.strictEqual(result.result.title, task.title)
      assert.strictEqual(result.result.status, 'pending')
      assert.strictEqual(result.result.source, 'prd')
    })
  )

  it.effect('read_issues returns the issues markdown', () =>
    Effect.gen(function* () {
      const toolkit = yield* makeToolkit()

      const result = yield* toolkit.handle('read_issues', {
        prdId: task.prdId,
      })

      assert.strictEqual(result.result, issuesMarkdown)
    })
  )

  it.effect('update_issue returns the updated task with new status', () =>
    Effect.gen(function* () {
      const toolkit = yield* makeToolkit()

      const result = yield* toolkit.handle('update_issue', {
        taskId: task.id,
        body: '### What to build\n\nShip the issue tools.',
        status: 'completed',
      })

      assert.strictEqual(result.result.id, task.id)
      assert.strictEqual(result.result.status, 'completed')
    })
  )

  it.effect('list_remaining_issues returns pending and in-progress tasks', () =>
    Effect.gen(function* () {
      const toolkit = yield* makeToolkit()

      const result = yield* toolkit.handle('list_remaining_issues', {
        prdId: task.prdId,
      })

      assert.strictEqual(result.result.length, 1)
      assert.strictEqual(result.result[0]?.id, task.id)
      assert.strictEqual(result.result[0]?.status, 'pending')
    })
  )
})
