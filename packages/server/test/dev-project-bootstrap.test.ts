import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { registerInitialDevProject } from '../src/services/dev-project-bootstrap.js'
import {
  type ProjectRecord,
  ProjectRegistry,
} from '../src/services/project-registry.js'

describe('dev project bootstrap', () => {
  it.effect(
    'registers the configured repository without re-pointing it',
    () => {
      const calls: Array<{
        readonly rePointExisting: boolean | undefined
        readonly repoPath: string
      }> = []
      const project: ProjectRecord = {
        canonicalGitCommonDir: '/repo/.git',
        color: null,
        id: 'project-1',
        name: 'laborer',
        repoId: 'repo-1',
        repoPath: '/repo',
      }
      const registry = ProjectRegistry.of({
        addProject: (repoPath, rePointExisting) =>
          Effect.sync(() => {
            calls.push({ repoPath, rePointExisting })
            return project
          }),
        getProject: () => Effect.succeed(project),
        listProjects: () => Effect.succeed([project]),
        removeProject: () => Effect.void,
      })

      return Effect.gen(function* () {
        const result = yield* registerInitialDevProject('/repo')

        expect(result).toEqual(project)
        expect(calls).toEqual([{ repoPath: '/repo', rePointExisting: false }])
      }).pipe(Effect.provide(Layer.succeed(ProjectRegistry, registry)))
    }
  )
})
