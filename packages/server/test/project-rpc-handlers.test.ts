import { assert, describe, it } from '@effect/vitest'
import { RpcError } from '@laborer/shared/rpc'
import { Effect, Layer, Logger } from 'effect'
import { ensureTaskProjects, handleProjectList } from '../src/rpc/handlers.js'
import { ProjectRegistry } from '../src/services/project-registry.js'

const projects = [
  {
    canonicalGitCommonDir: null,
    id: 'project-1',
    name: 'laborer',
    repoId: null,
    repoPath: '/repo/laborer',
  },
  {
    canonicalGitCommonDir: null,
    id: 'project-2',
    name: 'website',
    repoId: null,
    repoPath: '/repo/website',
  },
] as const

const ProjectRegistryTestLayer = Layer.succeed(
  ProjectRegistry,
  ProjectRegistry.of({
    addProject: () => Effect.die('not used in this test'),
    removeProject: () => Effect.die('not used in this test'),
    listProjects: () => Effect.succeed(projects),
    getProject: () => Effect.die('not used in this test'),
  })
)

describe('project.list RPC handler', () => {
  it.effect('returns registered projects from the project registry', () =>
    Effect.gen(function* () {
      const listedProjects = yield* handleProjectList()

      assert.deepStrictEqual(listedProjects, [
        {
          id: 'project-1',
          name: 'laborer',
          repoPath: '/repo/laborer',
        },
        {
          id: 'project-2',
          name: 'website',
          repoPath: '/repo/website',
        },
      ])
    }).pipe(Effect.provide(ProjectRegistryTestLayer))
  )
})

describe('task board project auto-registration', () => {
  it.effect('skips stale task roots without warning', () => {
    const attemptedPaths: string[] = []
    const logs: string[] = []
    const registryLayer = Layer.succeed(
      ProjectRegistry,
      ProjectRegistry.of({
        addProject: (repoPath) => {
          attemptedPaths.push(repoPath)
          return Effect.fail(
            new RpcError({
              code: 'INVALID_PATH',
              message: repoPath.endsWith('missing')
                ? `Path does not exist: ${repoPath}`
                : `Path is not a directory: ${repoPath}`,
            })
          )
        },
        removeProject: () => Effect.die('not used in this test'),
        listProjects: () => Effect.succeed([]),
        getProject: () => Effect.die('not used in this test'),
      })
    )
    const logger = Logger.make(({ message }) => {
      logs.push(String(message))
    })

    return Effect.gen(function* () {
      yield* ensureTaskProjects([
        { rootPath: '/tmp/laborer-e2e-repo-missing' },
        { rootPath: '/tmp/laborer-e2e-repo-file' },
      ])

      assert.deepStrictEqual(attemptedPaths, [
        '/tmp/laborer-e2e-repo-missing',
        '/tmp/laborer-e2e-repo-file',
      ])
      assert.deepStrictEqual(logs, [])
    }).pipe(Effect.provide(Layer.merge(registryLayer, Logger.layer([logger]))))
  })

  it.effect('warns when task root registration genuinely fails', () => {
    const logs: string[] = []
    const registryLayer = Layer.succeed(
      ProjectRegistry,
      ProjectRegistry.of({
        addProject: () =>
          Effect.fail(
            new RpcError({
              code: 'PROJECT_DATABASE_ERROR',
              message: 'database is unavailable',
            })
          ),
        removeProject: () => Effect.die('not used in this test'),
        listProjects: () => Effect.succeed([]),
        getProject: () => Effect.die('not used in this test'),
      })
    )
    const logger = Logger.make(({ message }) => {
      logs.push(String(message))
    })

    return Effect.gen(function* () {
      yield* ensureTaskProjects([{ rootPath: '/repo' }])

      assert.isTrue(
        logs.some((message) =>
          message.includes(
            '[task-board] Could not auto-register /repo: database is unavailable'
          )
        )
      )
    }).pipe(Effect.provide(Layer.merge(registryLayer, Logger.layer([logger]))))
  })
})
