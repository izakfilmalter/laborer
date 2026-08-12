import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
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
  it.effect(
    'project.add registers a real git repo with canonical identity',
    () =>
      runWithRpcTestContext(({ client, database }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo('rpc-project-add', tempRoots)
          const linkedWorktreePath = join(repoPath, '.worktrees', 'feature-rpc')
          git(`worktree add -b feature/rpc ${linkedWorktreePath}`, repoPath)

          const project = yield* client['project.add']({ repoPath })

          // ProjectRegistry now canonicalizes paths through
          // RepositoryIdentity, so the stored repoPath is the
          // realpath-resolved checkout root.
          const canonicalRepoPath = realpathSync(repoPath)
          const canonicalGitCommonDir = realpathSync(join(repoPath, '.git'))
          assert.strictEqual(project.repoPath, canonicalRepoPath)
          assert.strictEqual(project.name, basename(canonicalRepoPath))
          const storedProject = database.findProject(project.id)

          assert.isString(storedProject?.repoId)
          assert.strictEqual(
            storedProject?.canonicalGitCommonDir,
            canonicalGitCommonDir
          )
          assert.strictEqual(storedProject?.rootPath, canonicalRepoPath)
          assert.strictEqual(storedProject?.name, basename(canonicalRepoPath))
          assert.strictEqual(database.stateChangesAfter(0).length, 1)

          assert.isTrue(existsSync(linkedWorktreePath))
        })
      )
  )

  it.effect(
    'project.add returns NOT_GIT_REPO for a directory without git metadata',
    () =>
      runWithRpcTestContext(({ client, database }) =>
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
          assert.deepStrictEqual(database.listProjects(), [])
        })
      )
  )

  it.effect(
    'project.add returns a clear duplicate message for nested repo paths',
    () =>
      runWithRpcTestContext(({ client, database }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo('rpc-project-nested-duplicate', tempRoots)
          const nestedPath = join(repoPath, 'src', 'nested')
          const canonicalRepoPath = realpathSync(repoPath)
          mkdirSync(nestedPath, { recursive: true })

          const project = yield* client['project.add']({ repoPath })
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

          assert.strictEqual(database.listProjects().length, 1)
        })
      )
  )

  it.effect(
    'project.add returns a clear duplicate message for symlinked repo paths',
    () =>
      runWithRpcTestContext(({ client, database }) =>
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

          const project = yield* client['project.add']({ repoPath })
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

          assert.strictEqual(database.listProjects().length, 1)
        })
      )
  )

  it.effect('project.remove deletes a previously registered project', () =>
    runWithRpcTestContext(({ client, database }) =>
      Effect.gen(function* () {
        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => cleanupTempRoots(tempRoots))
        )

        const repoPath = initRepo('rpc-project-remove', tempRoots)
        const project = yield* client['project.add']({ repoPath })
        yield* client['project.remove']({ projectId: project.id })

        assert.isNull(database.findProject(project.id))
        assert.strictEqual(database.stateChangesAfter(0).length, 2)
      })
    )
  )

  it.effect('project.remove returns NOT_FOUND for an unknown project', () =>
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

  it.effect('a second clone re-points the existing repository project', () =>
    runWithRpcTestContext(({ client, database }) =>
      Effect.gen(function* () {
        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => cleanupTempRoots(tempRoots))
        )
        const source = initRepo('rpc-project-source', tempRoots)
        const cloneRoot = createTempDir('rpc-project-clones', tempRoots)
        const bare = join(cloneRoot, 'origin.git')
        const firstClone = join(cloneRoot, 'first')
        const secondClone = join(cloneRoot, 'second')
        git(`clone --bare ${source} ${bare}`, cloneRoot)
        git(`clone ${bare} ${firstClone}`, cloneRoot)
        git(`clone ${bare} ${secondClone}`, cloneRoot)

        const first = yield* client['project.add']({ repoPath: firstClone })
        const second = yield* client['project.add']({ repoPath: secondClone })

        assert.strictEqual(second.id, first.id)
        assert.strictEqual(database.listProjects().length, 1)
        assert.strictEqual(
          database.findProject(first.id)?.rootPath,
          realpathSync(secondClone)
        )
        assert.strictEqual(database.findProject(first.id)?.revision, 2)
        assert.strictEqual(database.stateChangesAfter(0).length, 2)
      })
    )
  )

  it.effect(
    'removal keeps tasks and re-registration makes their root visible again',
    () =>
      runWithRpcTestContext(({ client, database }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )
          const repoPath = initRepo('rpc-project-task-preservation', tempRoots)
          const first = yield* client['project.add']({ repoPath })
          database.insertTask({
            id: 'task-that-survives-project-removal',
            rootPath: realpathSync(repoPath),
            source: 'manual',
            status: 'todo',
            title: 'Survives',
          })

          yield* client['project.remove']({ projectId: first.id })
          assert.isNotNull(
            database.findTask('task-that-survives-project-removal')
          )
          assert.deepStrictEqual(database.listProjects(), [])

          const registeredAgain = yield* client['project.add']({ repoPath })
          assert.notStrictEqual(registeredAgain.id, first.id)
          assert.strictEqual(
            database.findTask('task-that-survives-project-removal')?.rootPath,
            registeredAgain.repoPath
          )
          assert.strictEqual(database.stateChangesAfter(0).length, 3)
        })
      )
  )
})
