import { assert, describe, it } from '@effect/vitest'
import { Effect, Either, Layer } from 'effect'
import { LaborerRpcClient } from '../src/services/laborer-rpc-client.js'
import { ProjectDiscovery } from '../src/services/project-discovery.js'
import { makePrdToolHandlers, PrdTools } from '../src/tools/prd-tools.js'

const project = {
  id: 'project-1',
  name: 'laborer',
  repoPath: '/repo/laborer',
  rlphConfig: undefined,
} as const

const prd = {
  id: 'prd-1',
  projectId: project.id,
  title: 'Roadmap',
  slug: 'roadmap',
  filePath: '/tmp/PRD-roadmap.md',
  status: 'draft',
  createdAt: '2026-03-06T00:00:00.000Z',
} as const

const readPrdResponse = {
  ...prd,
  content: '# Roadmap',
} as const

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
      createIssue: () => Effect.die('Not implemented in this test'),
      listProjects: () => Effect.succeed([project]),
      createPrd: () => Effect.succeed(prd),
      listRemainingIssues: () => Effect.die('Not implemented in this test'),
      listPrds: () => Effect.succeed([prd]),
      readPrd: () => Effect.succeed(readPrdResponse),
      readIssues: () => Effect.die('Not implemented in this test'),
      updateIssue: () => Effect.die('Not implemented in this test'),
      updatePrd: () => Effect.succeed(prd),
      ...overrides,
    })
  )

const makeToolkit = (rpcOverrides: Partial<LaborerRpcClient['Type']> = {}) =>
  PrdTools.pipe(
    Effect.provide(
      PrdTools.toLayer(makePrdToolHandlers).pipe(
        Layer.provide(makeProjectDiscoveryLayer()),
        Layer.provide(makeLaborerRpcClientLayer(rpcOverrides))
      )
    )
  )

describe('PrdTools', () => {
  it.effect('registers the expected MCP PRD tools', () =>
    Effect.sync(() => {
      assert.deepStrictEqual(Object.keys(PrdTools.tools), [
        'create_prd',
        'read_prd',
        'update_prd',
        'list_prds',
      ])

      assert.include(
        PrdTools.tools.create_prd.description,
        'current Laborer project'
      )
      assert.include(PrdTools.tools.read_prd.description, 'id or exact title')
    })
  )

  it.effect('create_prd returns the created PRD', () =>
    Effect.gen(function* () {
      const toolkit = yield* makeToolkit()

      const result = yield* toolkit.handle('create_prd', {
        title: 'Roadmap',
        content: '# Roadmap',
      })

      assert.strictEqual(result.result.id, prd.id)
      assert.strictEqual(result.result.title, prd.title)
      assert.strictEqual(result.result.status, 'draft')
    })
  )

  it.effect('create_prd passes the discovered project context to the RPC', () =>
    Effect.gen(function* () {
      const receivedInputs: { projectId: string }[] = []
      const toolkit = yield* makeToolkit({
        createPrd: (input) => {
          receivedInputs.push({ projectId: input.projectId })
          return Effect.succeed(prd)
        },
      })

      yield* toolkit.handle('create_prd', {
        title: 'Roadmap',
        content: '# Roadmap',
      })

      assert.strictEqual(receivedInputs.length, 1)
      assert.strictEqual(receivedInputs[0]?.projectId, project.id)
    })
  )

  it.effect('list_prds returns PRDs for the discovered project', () =>
    Effect.gen(function* () {
      const toolkit = yield* makeToolkit()

      const result = yield* toolkit.handle('list_prds', {})

      assert.strictEqual(result.result.length, 1)
      assert.strictEqual(result.result[0]?.id, prd.id)
      assert.strictEqual(result.result[0]?.title, prd.title)
    })
  )

  it.effect('read_prd returns PRD content when given a prdId', () =>
    Effect.gen(function* () {
      const toolkit = yield* makeToolkit()

      const result = yield* toolkit.handle('read_prd', {
        prdId: prd.id,
      })

      assert.strictEqual(result.result.id, prd.id)
      assert.strictEqual(result.result.content, '# Roadmap')
    })
  )

  it.effect('read_prd resolves a title to the matching PRD', () =>
    Effect.gen(function* () {
      const toolkit = yield* makeToolkit()

      const result = yield* toolkit.handle('read_prd', {
        title: prd.title,
      })

      assert.strictEqual(result.result.id, prd.id)
      assert.strictEqual(result.result.content, '# Roadmap')
    })
  )

  it.effect(
    'read_prd fails with NOT_FOUND when title does not match any PRD',
    () =>
      Effect.gen(function* () {
        const toolkit = yield* makeToolkit()

        const result = yield* toolkit
          .handle('read_prd', { title: 'Nonexistent' })
          .pipe(Effect.either)

        assert.isTrue(Either.isLeft(result))
        if (Either.isLeft(result)) {
          assert.strictEqual(result.left.code, 'NOT_FOUND')
        }
      })
  )

  it.effect(
    'read_prd fails with INVALID_INPUT when neither prdId nor title is provided',
    () =>
      Effect.gen(function* () {
        const toolkit = yield* makeToolkit()

        const result = yield* toolkit.handle('read_prd', {}).pipe(Effect.either)

        assert.isTrue(Either.isLeft(result))
        if (Either.isLeft(result)) {
          assert.strictEqual(result.left.code, 'INVALID_INPUT')
        }
      })
  )

  it.effect('update_prd returns the updated PRD', () =>
    Effect.gen(function* () {
      const toolkit = yield* makeToolkit()

      const result = yield* toolkit.handle('update_prd', {
        prdId: prd.id,
        content: '# Updated roadmap',
      })

      assert.strictEqual(result.result.id, prd.id)
      assert.strictEqual(result.result.title, prd.title)
    })
  )
})
