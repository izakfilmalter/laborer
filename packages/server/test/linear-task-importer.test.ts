// @effect-diagnostics effect/preferSchemaOverJson:off

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Cause, Effect, Exit, Layer } from 'effect'
import { afterEach, vi } from 'vitest'
import { ConfigService } from '../src/services/config-service.js'
import { LaborerStore } from '../src/services/laborer-store.js'
import { LinearTaskImporter } from '../src/services/linear-task-importer.js'
import { TaskManager } from '../src/services/task-manager.js'
import { createTempDir } from './helpers/git-helpers.js'
import { TestLaborerStore } from './helpers/test-store.js'

const LINEAR_API_ERROR_REGEX = /Linear API request failed \(403\):/

const TestLayer = LinearTaskImporter.layer.pipe(
  Layer.provide(ConfigService.layer),
  Layer.provide(TaskManager.layer),
  Layer.provideMerge(TestLaborerStore)
)

const createProjectWithConfig = (
  configContent: string,
  tempRoots: string[]
): string => {
  const repoPath = createTempDir('laborer-linear-import')
  tempRoots.push(repoPath)
  mkdirSync(join(repoPath, '.rlph'), { recursive: true })
  writeFileSync(join(repoPath, '.rlph', 'config.toml'), configContent)
  return repoPath
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('LinearTaskImporter.importProjectIssues', () => {
  const originalLinearApiKey = process.env.LINEAR_API_KEY

  afterEach(() => {
    process.env.LINEAR_API_KEY = originalLinearApiKey
  })

  it.scoped('imports Linear issues and skips duplicates', () =>
    Effect.gen(function* () {
      const tempRoots: string[] = []
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const root of tempRoots) {
            rmSync(root, { force: true, recursive: true })
          }
        })
      )

      process.env.LINEAR_API_KEY = 'linear-token'
      const repoPath = createProjectWithConfig(
        [
          'label = "ops"',
          '',
          '[linear]',
          'team = "ENG"',
          'project = "Core"',
        ].join('\n'),
        tempRoots
      )

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                { identifier: 'ENG-101', title: 'Already imported' },
                { identifier: 'ENG-102', title: 'Import Linear tasks' },
              ],
            },
          },
        }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const { store } = yield* LaborerStore
      store.commit(
        events.projectCreated({
          id: 'project-1',
          repoPath,
          name: 'laborer',
          rlphConfig: null,
        })
      )
      store.commit(
        events.taskCreated({
          id: 'existing-task',
          projectId: 'project-1',
          source: 'linear',
          prdId: null,
          externalId: 'ENG-101',
          title: 'Already imported',
          status: 'pending',
        })
      )

      const importer = yield* LinearTaskImporter
      const result = yield* importer.importProjectIssues('project-1')

      assert.strictEqual(result.importedCount, 1)
      assert.strictEqual(result.totalCount, 2)

      const importedTasks = store.query(
        tables.tasks.where('projectId', 'project-1')
      )
      assert.strictEqual(importedTasks.length, 2)

      const newTask = importedTasks.find((t) => t.externalId === 'ENG-102')
      assert.isDefined(newTask)
      if (newTask === undefined) {
        assert.fail('Expected newly imported task to exist')
      }
      assert.strictEqual(newTask.source, 'linear')
      assert.strictEqual(newTask.title, 'Import Linear tasks')
      assert.strictEqual(newTask.status, 'pending')

      assert.strictEqual(fetchMock.mock.calls.length, 1)
      const [calledUrl, calledOpts] = fetchMock.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ]
      assert.strictEqual(calledUrl, 'https://api.linear.app/graphql')
      const headers = calledOpts.headers as Record<string, string>
      assert.strictEqual(headers.Authorization, 'linear-token')
      assert.strictEqual(headers['Content-Type'], 'application/json')
      assert.strictEqual(calledOpts.method, 'POST')

      const request = fetchMock.mock.calls[0]?.[1] as
        | { body?: string }
        | undefined
      const body =
        typeof request?.body === 'string'
          ? (JSON.parse(request.body) as {
              variables: { filter: Record<string, unknown> }
            })
          : null
      assert.deepStrictEqual(body?.variables.filter, {
        labels: { name: { eq: 'ops' } },
        project: { name: { eq: 'Core' } },
        state: {
          name: { nin: ['In Progress', 'In Review', 'Done'] },
          type: { nin: ['completed', 'canceled'] },
        },
        team: { key: { eq: 'ENG' } },
      })
    }).pipe(Effect.provide(TestLayer))
  )

  it.scoped('returns a typed error when the Linear API request fails', () =>
    Effect.gen(function* () {
      const tempRoots: string[] = []
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const root of tempRoots) {
            rmSync(root, { force: true, recursive: true })
          }
        })
      )

      process.env.LINEAR_API_KEY = 'linear-token'
      const repoPath = createProjectWithConfig(
        ['label = "ops"', '', '[linear]', 'team = "ENG"'].join('\n'),
        tempRoots
      )

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: async () => ({ errors: [{ message: 'rate limited' }] }),
        })
      )

      const { store } = yield* LaborerStore
      store.commit(
        events.projectCreated({
          id: 'project-1',
          repoPath,
          name: 'laborer',
          rlphConfig: null,
        })
      )

      const importer = yield* LinearTaskImporter
      const exit = yield* Effect.exit(importer.importProjectIssues('project-1'))
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        assert.isTrue(
          LINEAR_API_ERROR_REGEX.test(
            String(error instanceof Error ? error.message : error)
          )
        )
      }
    }).pipe(Effect.provide(TestLayer))
  )
})
