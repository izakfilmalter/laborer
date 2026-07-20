import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
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

          // ProjectRegistry now canonicalizes paths through
          // RepositoryIdentity, so the stored repoPath is the
          // realpath-resolved checkout root.
          const canonicalRepoPath = realpathSync(repoPath)
          const canonicalGitCommonDir = realpathSync(join(repoPath, '.git'))
          assert.strictEqual(project.repoPath, canonicalRepoPath)
          assert.strictEqual(project.name, basename(canonicalRepoPath))
          assert.strictEqual(project.brrrConfig, undefined)
          const storedProject = store.query(
            tables.projects.where('id', project.id)
          )

          assert.isString(storedProject[0]?.repoId)
          assert.strictEqual(
            storedProject[0]?.canonicalGitCommonDir,
            canonicalGitCommonDir
          )
          assert.deepStrictEqual(storedProject, [
            {
              id: project.id,
              repoPath: canonicalRepoPath,
              repoId: storedProject[0]?.repoId ?? null,
              canonicalGitCommonDir,
              name: basename(canonicalRepoPath),
              brrrConfig: null,
            },
          ])

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
          assert.include(result.left.message, 'not a git repository')
          assert.deepStrictEqual(
            store.query(tables.projects.where('repoPath', repoPath)),
            []
          )
        })
      )
  )

  it.scoped(
    'project.add returns a clear duplicate message for nested repo paths',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo('rpc-project-nested-duplicate', tempRoots)
          const nestedPath = join(repoPath, 'src', 'nested')
          const canonicalRepoPath = realpathSync(repoPath)
          mkdirSync(nestedPath, { recursive: true })

          const project = yield* client.project.add({ repoPath })
          const result = yield* client.project
            .add({ repoPath: nestedPath })
            .pipe(Effect.either)

          assert.isTrue(Either.isLeft(result))
          if (Either.isRight(result)) {
            assert.fail('Expected nested duplicate project.add to fail')
          }

          assert.strictEqual(result.left.code, 'ALREADY_REGISTERED')
          assert.include(result.left.message, nestedPath)
          assert.include(result.left.message, canonicalRepoPath)
          assert.include(result.left.message, project.name)
          assert.include(result.left.message, 'already registered repository')

          assert.strictEqual(store.query(tables.projects).length, 1)
        })
      )
  )

  it.scoped(
    'project.add returns a clear duplicate message for symlinked repo paths',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo('rpc-project-symlink-duplicate', tempRoots)
          const symlinkRoot = createTempDir(
            'rpc-project-symlink-root',
            tempRoots
          )
          const symlinkPath = join(symlinkRoot, 'linked-repo')
          const canonicalRepoPath = realpathSync(repoPath)
          symlinkSync(repoPath, symlinkPath)

          const project = yield* client.project.add({ repoPath })
          const result = yield* client.project
            .add({ repoPath: symlinkPath })
            .pipe(Effect.either)

          assert.isTrue(Either.isLeft(result))
          if (Either.isRight(result)) {
            assert.fail('Expected symlink duplicate project.add to fail')
          }

          assert.strictEqual(result.left.code, 'ALREADY_REGISTERED')
          assert.include(result.left.message, symlinkPath)
          assert.include(result.left.message, canonicalRepoPath)
          assert.include(result.left.message, project.name)
          assert.include(result.left.message, 'already registered repository')

          assert.strictEqual(store.query(tables.projects).length, 1)
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
