import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Either, Ref, type Scope } from 'effect'
import { createTempDir, git, initRepo } from '../helpers/git-helpers.js'
import { makeScopedTestRpcContext } from './test-layer.js'

type RpcTestContext = Effect.Effect.Success<typeof makeScopedTestRpcContext>

const SETUP_ENV_FILE = '.laborer-setup-env'
const CREATE_BRANCH_PATTERN = /feature\/rpc-create/

/**
 * Poll until the workspace row is removed from LiveStore.
 * destroyWorktree forks cleanup into a background daemon fiber, so the
 * workspace row deletion (the last step) signals that all cleanup is done.
 */
const waitForWorkspaceRemoval = (
  store: RpcTestContext['store'],
  workspaceId: string
) =>
  Effect.gen(function* () {
    const maxAttempts = 100
    for (let i = 0; i < maxAttempts; i++) {
      yield* Effect.sleep('100 millis')
      const rows = store.query(tables.workspaces.where('id', workspaceId))
      if (rows.length === 0) {
        return
      }
    }
    assert.fail('Timed out waiting for workspace row to be removed')
  })

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

const writeLaborerConfig = (
  dirPath: string,
  config: Record<string, unknown>
): void => {
  writeFileSync(
    join(dirPath, 'laborer.json'),
    `${JSON.stringify(config, null, 2)}\n`
  )
}

describe('LaborerRpcs workspace management', () => {
  it.scopedLive(
    'workspace.create creates a worktree, allocates a port, and runs setup scripts',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo('rpc-workspace-create', tempRoots)
          const worktreeRoot = createTempDir('rpc-worktree-root', tempRoots)
          const branchName = 'feature/rpc-create'

          writeLaborerConfig(repoPath, {
            devServer: { image: null },
            setupScripts: [
              `printf '%s' "$PORT,$LABORER_WORKSPACE_ID,$LABORER_BRANCH,$LABORER_WORKSPACE_PATH" > ${SETUP_ENV_FILE}`,
            ],
            worktreeDir: worktreeRoot,
          })
          git('add laborer.json', repoPath)
          git('commit -m "add laborer config"', repoPath)

          const project = yield* client.project.add({ repoPath })
          const workspace = yield* client.workspace.create({
            branchName,
            projectId: project.id,
          })

          assert.strictEqual(workspace.projectId, project.id)
          assert.strictEqual(workspace.branchName, branchName)
          assert.strictEqual(workspace.port, 4100)
          // workspace.create returns immediately with 'creating' status;
          // the background fiber transitions to 'running' asynchronously.
          assert.strictEqual(workspace.status, 'creating')
          assert.strictEqual(
            workspace.worktreePath,
            join(worktreeRoot, 'feature-rpc-create')
          )

          // Wait for the background setup fiber to finish and transition
          // the workspace to 'running' before asserting on side effects.
          // The fiber is forked into the layer scope so we poll the store,
          // yielding via Effect.sleep to let the background fiber progress.
          yield* Effect.gen(function* () {
            const maxAttempts = 200
            for (let i = 0; i < maxAttempts; i++) {
              yield* Effect.sleep('100 millis')
              const rows = store.query(
                tables.workspaces.where('id', workspace.id)
              )
              const row = rows[0]
              if (row === undefined) {
                return assert.fail(
                  'Workspace row deleted — setup likely errored and rolled back'
                )
              }
              if (row.status === 'errored') {
                return assert.fail(
                  `Workspace errored (worktreeSetupStep=${row.worktreeSetupStep})`
                )
              }
              if (row.status === 'running') {
                return
              }
            }
            assert.fail(
              'Timed out waiting for workspace to transition to running'
            )
          })

          assert.isTrue(existsSync(workspace.worktreePath))
          assert.match(
            git(`branch --list ${branchName}`, repoPath),
            CREATE_BRANCH_PATTERN
          )

          const setupEnvContents = readFileSync(
            join(workspace.worktreePath, SETUP_ENV_FILE),
            'utf-8'
          )

          assert.strictEqual(
            setupEnvContents,
            `${workspace.port},${workspace.id},${branchName},${workspace.worktreePath}`
          )

          const workspaceRows = store.query(
            tables.workspaces.where('id', workspace.id)
          )

          assert.strictEqual(workspaceRows.length, 1)
          const workspaceRow = workspaceRows[0]
          assert.isDefined(workspaceRow)
          if (workspaceRow === undefined) {
            assert.fail(
              'Expected workspace.create to materialize a workspace row'
            )
          }

          assert.strictEqual(workspaceRow.branchName, branchName)
          assert.strictEqual(workspaceRow.id, workspace.id)
          assert.strictEqual(workspaceRow.origin, 'laborer')
          assert.strictEqual(workspaceRow.port, 4100)
          assert.strictEqual(workspaceRow.projectId, project.id)
          assert.strictEqual(workspaceRow.status, 'running')
          assert.isNull(workspaceRow.taskSource)
          assert.strictEqual(workspaceRow.worktreePath, workspace.worktreePath)
          assert.isNull(workspaceRow.containerId)
          assert.isNull(workspaceRow.containerUrl)
          assert.isNull(workspaceRow.containerImage)
          assert.isNull(workspaceRow.containerStatus)
          // containerSetupStep is set by a background fiber and may be
          // non-null if the async container setup has started by query time
          assert.isString(
            typeof workspaceRow.containerSetupStep === 'string'
              ? workspaceRow.containerSetupStep
              : 'null-is-ok'
          )
        })
      )
  )

  it.scoped('workspace.create returns NOT_FOUND for an unknown project', () =>
    runWithRpcTestContext(({ client, store }) =>
      Effect.gen(function* () {
        const result = yield* client.workspace
          .create({
            branchName: 'feature/missing-project',
            projectId: 'missing-project',
          })
          .pipe(Effect.either)

        assert.isTrue(Either.isLeft(result))
        if (Either.isRight(result)) {
          assert.fail('Expected workspace.create to fail for a missing project')
        }

        assert.strictEqual(result.left.code, 'NOT_FOUND')
        assert.strictEqual(
          result.left.message,
          'Project not found: missing-project'
        )
        assert.deepStrictEqual(store.query(tables.workspaces), [])
      })
    )
  )

  it.scopedLive(
    'workspace.destroy removes laborer-managed worktrees and records terminal cleanup',
    () =>
      runWithRpcTestContext(({ client, store, terminalClientRecorder }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo('rpc-workspace-destroy-laborer', tempRoots)
          const worktreeRoot = createTempDir(
            'rpc-workspace-destroy-laborer-root',
            tempRoots
          )
          const branchName = 'feature/rpc-destroy-laborer'

          writeLaborerConfig(repoPath, {
            worktreeDir: worktreeRoot,
            devServer: { image: null },
          })
          git('add laborer.json', repoPath)
          git('commit -m "add laborer config"', repoPath)

          const project = yield* client.project.add({ repoPath })
          const workspace = yield* client.workspace.create({
            branchName,
            projectId: project.id,
          })

          yield* client.workspace.destroy({ workspaceId: workspace.id })

          // destroyWorktree forks cleanup into a background daemon fiber.
          // Poll until the workspace row is removed (last step in the fiber).
          yield* waitForWorkspaceRemoval(store, workspace.id)

          assert.isFalse(existsSync(workspace.worktreePath))
          assert.strictEqual(git(`branch --list ${branchName}`, repoPath), '')
          assert.deepStrictEqual(
            yield* Ref.get(terminalClientRecorder.killAllForWorkspaceCalls),
            [workspace.id]
          )
        })
      )
  )

  it.scopedLive(
    'workspace.destroy removes external worktrees from disk and store state',
    () =>
      runWithRpcTestContext(({ client, store, terminalClientRecorder }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo('rpc-workspace-destroy-external', tempRoots)
          const branchName = 'feature/rpc-external'
          const externalWorktreePath = join(
            repoPath,
            '.worktrees',
            'feature-rpc-external'
          )
          git(`worktree add -b ${branchName} ${externalWorktreePath}`, repoPath)

          const project = yield* client.project.add({ repoPath })
          const externalWorkspaceId = crypto.randomUUID()
          store.commit(
            events.workspaceCreated({
              baseSha: null,
              branchName,
              createdAt: new Date().toISOString(),
              id: externalWorkspaceId,
              origin: 'external',
              port: 0,
              projectId: project.id,
              status: 'stopped',
              taskSource: null,
              worktreePath: externalWorktreePath,
            })
          )

          const externalWorkspace = store.query(
            tables.workspaces.where('id', externalWorkspaceId)
          )[0]

          assert.isDefined(externalWorkspace)
          if (externalWorkspace === undefined) {
            assert.fail('Expected the external workspace fixture to exist')
          }

          yield* client.workspace.destroy({
            workspaceId: externalWorkspace.id,
          })

          // destroyWorktree forks cleanup into a background daemon fiber.
          // Poll until the workspace row is removed (last step in the fiber).
          yield* waitForWorkspaceRemoval(store, externalWorkspace.id)

          assert.isFalse(existsSync(externalWorktreePath))
          assert.strictEqual(git(`branch --list ${branchName}`, repoPath), '')
          assert.deepStrictEqual(
            yield* Ref.get(terminalClientRecorder.killAllForWorkspaceCalls),
            [externalWorkspace.id]
          )
        })
      )
  )

  it.scopedLive(
    'workspace.create succeeds for a branch whose previous workspace was just destroyed',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo('rpc-recreate-after-destroy', tempRoots)
          const worktreeRoot = createTempDir(
            'rpc-recreate-after-destroy-root',
            tempRoots
          )
          const branchName = 'feature/rpc-recreate'

          writeLaborerConfig(repoPath, {
            worktreeDir: worktreeRoot,
            devServer: { image: null },
          })
          git('add laborer.json', repoPath)
          git('commit -m "add laborer config"', repoPath)

          const project = yield* client.project.add({ repoPath })

          // 1. Create the first workspace and wait for it to be running
          const first = yield* client.workspace.create({
            branchName,
            projectId: project.id,
          })

          yield* Effect.gen(function* () {
            const maxAttempts = 200
            for (let i = 0; i < maxAttempts; i++) {
              yield* Effect.sleep('100 millis')
              const rows = store.query(tables.workspaces.where('id', first.id))
              const row = rows[0]
              if (row === undefined) {
                return assert.fail(
                  'First workspace row deleted — setup errored and rolled back'
                )
              }
              if (row.status === 'errored') {
                return assert.fail(
                  `First workspace errored (worktreeSetupStep=${row.worktreeSetupStep})`
                )
              }
              if (row.status === 'running') {
                return
              }
            }
            assert.fail(
              'Timed out waiting for first workspace to reach running'
            )
          })

          // 2. Destroy the first workspace — do NOT wait for background
          //    cleanup to finish. This is the real-world scenario: the
          //    user destroys a workspace and immediately creates a new one
          //    for the same branch.
          yield* client.workspace.destroy({
            workspaceId: first.id,
            force: true,
          })

          // 3. Immediately create a second workspace for the same branch.
          //    The old destroy's background fiber is still running
          //    (git worktree remove, git branch -D, etc.) — the create
          //    must not race with it.
          const second = yield* client.workspace.create({
            branchName,
            projectId: project.id,
          })

          assert.notStrictEqual(second.id, first.id)
          assert.strictEqual(second.branchName, branchName)
          assert.strictEqual(second.status, 'creating')

          // 4. Wait for the second workspace to reach 'running'
          yield* Effect.gen(function* () {
            const maxAttempts = 200
            for (let i = 0; i < maxAttempts; i++) {
              yield* Effect.sleep('100 millis')
              const rows = store.query(tables.workspaces.where('id', second.id))
              const row = rows[0]
              if (row === undefined) {
                return assert.fail(
                  'Second workspace row deleted — setup likely raced with destroy cleanup'
                )
              }
              if (row.status === 'errored') {
                return assert.fail(
                  `Second workspace errored (worktreeSetupStep=${row.worktreeSetupStep})`
                )
              }
              if (row.status === 'running') {
                return
              }
            }
            assert.fail(
              'Timed out waiting for second workspace to reach running'
            )
          })

          // 5. Verify the second workspace is healthy
          assert.isTrue(existsSync(second.worktreePath))

          const finalRows = store.query(
            tables.workspaces.where('id', second.id)
          )
          assert.strictEqual(finalRows.length, 1)
          assert.strictEqual(finalRows[0]?.status, 'running')
        })
      )
  )
})
