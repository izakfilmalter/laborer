import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, type Scope } from 'effect'
import { vi } from 'vitest'
import { git, initRepo } from '../helpers/git-helpers.js'
import { makeScopedTestRpcContext } from './test-layer.js'

type RpcTestContext = Effect.Effect.Success<typeof makeScopedTestRpcContext>

const LINEAR_QUERY_REGEX = /query Issues\(\$filter: IssueFilter!\)/u
const LINEAR_LABEL_FILTER_REGEX = /"labels":\{"name":\{"eq":"ops"\}\}/u
const LINEAR_PROJECT_FILTER_REGEX = /"project":\{"name":\{"eq":"Core"\}\}/u
const LINEAR_TEAM_FILTER_REGEX = /"team":\{"key":\{"eq":"ENG"\}\}/u
const LINEAR_STATE_NAME_FILTER_REGEX =
  /"name":\{"nin":\["In Progress","In Review","Done"\]\}/u
const LINEAR_STATE_TYPE_FILTER_REGEX =
  /"type":\{"nin":\["completed","canceled"\]\}/u

const cleanupTempRoots = (tempRoots: readonly string[]) => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

const runWithRpcTestContext = <A, E>(
  run: (context: RpcTestContext) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* makeScopedTestRpcContext
    return yield* run(context)
  }) as Effect.Effect<A, E, Scope.Scope>

describe('LaborerRpcs task import', () => {
  it.scoped(
    'task.importGithub imports GitHub issues while skipping pull requests and duplicates',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              vi.restoreAllMocks()
              vi.unstubAllGlobals()
              cleanupTempRoots(tempRoots)
            })
          )

          const repoPath = initRepo('rpc-task-import-github', tempRoots)
          git('remote add origin git@github.com:acme/laborer.git', repoPath)

          const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [
              {
                html_url: 'https://github.com/acme/laborer/issues/101',
                number: 101,
                title: 'Already imported',
              },
              {
                html_url: 'https://github.com/acme/laborer/issues/102',
                number: 102,
                title: 'Skip pull requests',
                pull_request: {},
              },
              {
                html_url: 'https://github.com/acme/laborer/issues/103',
                number: 103,
                title: 'Import task source picker issues',
              },
            ],
          })
          vi.stubGlobal('fetch', fetchMock)

          const project = yield* client.project.add({ repoPath })
          store.commit(
            events.taskCreated({
              id: crypto.randomUUID(),
              projectId: project.id,
              source: 'github',
              prdId: null,
              externalId: 'https://github.com/acme/laborer/issues/101',
              title: 'Already imported',
              status: 'pending',
            })
          )

          const result = yield* client.task.importGithub({
            projectId: project.id,
          })

          assert.deepStrictEqual(result, { importedCount: 1, totalCount: 2 })

          const importedTasks = store.query(
            tables.tasks.where('projectId', project.id)
          )
          const githubTasks = importedTasks.filter(
            (task) => task.source === 'github'
          )

          assert.strictEqual(githubTasks.length, 2)
          assert.isDefined(
            githubTasks.find(
              (task) =>
                task.externalId ===
                  'https://github.com/acme/laborer/issues/103' &&
                task.title === 'Import task source picker issues'
            )
          )

          assert.strictEqual(fetchMock.mock.calls.length, 1)
          assert.deepStrictEqual(fetchMock.mock.calls[0], [
            'https://api.github.com/repos/acme/laborer/issues?state=open&per_page=100',
            {
              headers: {
                accept: 'application/vnd.github+json',
                'user-agent': 'laborer',
              },
            },
          ])
        })
      )
  )

  it.scoped(
    'task.importLinear imports Linear issues, deduplicates existing tasks, and builds the expected filter',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          const originalLinearApiKey = process.env.LINEAR_API_KEY
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.LINEAR_API_KEY = originalLinearApiKey
              vi.restoreAllMocks()
              vi.unstubAllGlobals()
              cleanupTempRoots(tempRoots)
            })
          )

          process.env.LINEAR_API_KEY = 'linear-token'
          const repoPath = initRepo('rpc-task-import-linear', tempRoots)
          mkdirSync(join(repoPath, '.brrr'), { recursive: true })
          writeFileSync(
            join(repoPath, '.brrr', 'config.toml'),
            [
              'label = "ops"',
              '',
              '[linear]',
              'team = "ENG"',
              'project = "Core"',
            ].join('\n')
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

          const project = yield* client.project.add({ repoPath })
          store.commit(
            events.taskCreated({
              id: crypto.randomUUID(),
              projectId: project.id,
              source: 'linear',
              prdId: null,
              externalId: 'ENG-101',
              title: 'Already imported',
              status: 'pending',
            })
          )

          const result = yield* client.task.importLinear({
            projectId: project.id,
          })

          assert.deepStrictEqual(result, { importedCount: 1, totalCount: 2 })

          const linearTasks = store
            .query(tables.tasks.where('projectId', project.id))
            .filter((task) => task.source === 'linear')

          assert.strictEqual(linearTasks.length, 2)
          assert.isDefined(
            linearTasks.find(
              (task) =>
                task.externalId === 'ENG-102' &&
                task.title === 'Import Linear tasks'
            )
          )

          assert.strictEqual(fetchMock.mock.calls.length, 1)
          const request = fetchMock.mock.calls[0]?.[1]
          assert.isDefined(request)
          if (request === undefined || typeof request.body !== 'string') {
            assert.fail(
              'Expected task.importLinear to post a JSON GraphQL body'
            )
          }

          assert.strictEqual(
            fetchMock.mock.calls[0]?.[0],
            'https://api.linear.app/graphql'
          )
          assert.deepStrictEqual(request, {
            body: request.body,
            headers: {
              Authorization: 'linear-token',
              'Content-Type': 'application/json',
            },
            method: 'POST',
          })
          assert.match(request.body, LINEAR_QUERY_REGEX)
          assert.match(request.body, LINEAR_LABEL_FILTER_REGEX)
          assert.match(request.body, LINEAR_PROJECT_FILTER_REGEX)
          assert.match(request.body, LINEAR_TEAM_FILTER_REGEX)
          assert.match(request.body, LINEAR_STATE_NAME_FILTER_REGEX)
          assert.match(request.body, LINEAR_STATE_TYPE_FILTER_REGEX)
        })
      )
  )
})
