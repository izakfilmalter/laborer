import { existsSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { tables } from '@laborer/shared/schema'
import { Effect, Either, type Scope } from 'effect'
import { createTempDir, git, initRepo } from '../helpers/git-helpers.js'
import { makeScopedTestRpcContext } from './test-layer.js'

type RpcTestContext = Effect.Effect.Success<typeof makeScopedTestRpcContext>

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

describe('LaborerRpcs project management', () => {
  it.scoped(
    'project.add registers a real git repo and materializes detected worktrees',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo('rpc-project-add', tempRoots)
          const linkedWorktreePath = join(repoPath, '.worktrees', 'feature-rpc')
          git(`worktree add -b feature/rpc ${linkedWorktreePath}`, repoPath)

          const project = yield* client.project.add({ repoPath })

          assert.strictEqual(project.repoPath, repoPath)
          assert.strictEqual(project.name, basename(repoPath))
          assert.strictEqual(project.rlphConfig, undefined)

          assert.deepStrictEqual(
            store.query(tables.projects.where('id', project.id)),
            [
              {
                id: project.id,
                repoPath,
                name: basename(repoPath),
                rlphConfig: null,
              },
            ]
          )

          const workspaces = store.query(
            tables.workspaces.where('projectId', project.id)
          )

          assert.strictEqual(workspaces.length, 2)
          assert.isTrue(
            workspaces.every((workspace) => workspace.origin === 'external')
          )
          assert.isTrue(
            workspaces.every((workspace) => workspace.status === 'stopped')
          )
        })
      )
  )

  it.scoped(
    'project.add returns NOT_GIT_REPO for a directory without git metadata',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = createTempDir('rpc-project-invalid', tempRoots)
          const result = yield* client.project
            .add({ repoPath })
            .pipe(Effect.either)

          assert.isTrue(Either.isLeft(result))
          if (Either.isRight(result)) {
            assert.fail('Expected project.add to fail for a non-git directory')
          }

          assert.strictEqual(result.left.code, 'NOT_GIT_REPO')
          assert.strictEqual(
            result.left.message,
            `Path is not a git repository: ${repoPath}`
          )
          assert.deepStrictEqual(
            store.query(tables.projects.where('repoPath', repoPath)),
            []
          )
        })
      )
  )

  it.scoped('project.remove deletes a previously registered project', () =>
    runWithRpcTestContext(({ client, store }) =>
      Effect.gen(function* () {
        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => cleanupTempRoots(tempRoots))
        )

        const repoPath = initRepo('rpc-project-remove', tempRoots)
        const project = yield* client.project.add({ repoPath })
        yield* client.project.remove({ projectId: project.id })

        assert.deepStrictEqual(
          store.query(tables.projects.where('id', project.id)),
          []
        )
      })
    )
  )

  it.scoped('project.remove returns NOT_FOUND for an unknown project', () =>
    runWithRpcTestContext(({ client }) =>
      Effect.gen(function* () {
        const result = yield* client.project
          .remove({ projectId: 'missing-project' })
          .pipe(Effect.either)

        assert.isTrue(Either.isLeft(result))
        if (Either.isRight(result)) {
          assert.fail('Expected project.remove to fail for a missing project')
        }

        assert.strictEqual(result.left.code, 'NOT_FOUND')
        assert.strictEqual(
          result.left.message,
          'Project not found: missing-project'
        )
      })
    )
  )
})
