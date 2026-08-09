import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Either, Ref, type Scope } from 'effect'
import { vi } from 'vitest'
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

const configureRepo = (repoPath: string): void => {
  git('config user.email test@example.com', repoPath)
  git('config user.name Test User', repoPath)
}

const commitFile = (
  repoPath: string,
  fileName: string,
  content: string
): void => {
  writeFileSync(join(repoPath, fileName), content)
  git(`add ${fileName}`, repoPath)
  git(`commit -m "${fileName}"`, repoPath)
}

const createRemoteClone = (
  remotePath: string,
  prefix: string,
  tempRoots: string[]
): string => {
  const parentDir = createTempDir(prefix, tempRoots)
  const repoPath = join(parentDir, 'repo')
  git(`clone "${remotePath}" repo`, parentDir)
  configureRepo(repoPath)
  return repoPath
}

const initRemoteRepo = (prefix: string, tempRoots: string[]) => {
  const remotePath = createTempDir(`${prefix}-remote`, tempRoots)
  git('init --bare', remotePath)

  const seedPath = initRepo(`${prefix}-seed`, tempRoots)
  git('branch -M main', seedPath)
  git(`remote add origin "${remotePath}"`, seedPath)
  git('push -u origin main', seedPath)

  const localPath = createRemoteClone(remotePath, `${prefix}-local`, tempRoots)
  git('checkout main', localPath)

  return { localPath, remotePath }
}

describe('LaborerRpcs workspace management', () => {
  it.scopedLive(
    'workspace.create creates a worktree and runs setup scripts',
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
              `printf '%s' "$LABORER_WORKSPACE_ID,$LABORER_BRANCH,$LABORER_WORKSPACE_PATH" > ${SETUP_ENV_FILE}`,
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
          // workspace.create returns immediately with 'creating' status;
          // the background fiber transitions to 'running' asynchronously.
          assert.strictEqual(workspace.status, 'creating')
          assert.strictEqual(
            workspace.worktreePath,
            join(worktreeRoot, 'feature-rpc-create')
          )

          // Wait for the worktree-ready checkpoint. Setup scripts may still
          // be running after the workspace transitions to 'running'.
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

          // Wait for setup scripts to complete before asserting on their
          // side effects.
          yield* Effect.gen(function* () {
            const maxAttempts = 200
            for (let i = 0; i < maxAttempts; i++) {
              yield* Effect.sleep('100 millis')
              const rows = store.query(
                tables.workspaces.where('id', workspace.id)
              )
              const row = rows[0]
              if (row?.status === 'errored') {
                return assert.fail(
                  `Workspace errored during setup scripts: ${row.errorMessage ?? ''}`
                )
              }
              if (row?.worktreeSetupStep === null) {
                return
              }
            }
            assert.fail('Timed out waiting for setup scripts to complete')
          })

          const setupEnvContents = readFileSync(
            join(workspace.worktreePath, SETUP_ENV_FILE),
            'utf-8'
          )

          assert.strictEqual(
            setupEnvContents,
            `${workspace.id},${branchName},${workspace.worktreePath}`
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
          assert.strictEqual(workspaceRow.projectId, project.id)
          assert.strictEqual(workspaceRow.status, 'running')
          assert.isNull(workspaceRow.taskSource)
          assert.strictEqual(workspaceRow.worktreePath, workspace.worktreePath)
        })
      )
  )

  it.scopedLive(
    'workspace.create checks out a remote-only branch when it exists on origin',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const { localPath, remotePath } = initRemoteRepo(
            'rpc-workspace-remote-branch',
            tempRoots
          )
          const colleaguePath = createRemoteClone(
            remotePath,
            'rpc-workspace-colleague',
            tempRoots
          )
          const worktreeRoot = createTempDir(
            'rpc-worktree-root-remote-branch',
            tempRoots
          )
          const branchName = 'feature/colleague-pr'

          writeLaborerConfig(localPath, {
            devServer: { image: null },
            setupScripts: [],
            worktreeDir: worktreeRoot,
          })
          git('add laborer.json', localPath)
          git('commit -m "add laborer config"', localPath)

          git(`checkout -b ${branchName}`, colleaguePath)
          commitFile(colleaguePath, 'colleague.txt', 'from remote branch')
          git(`push -u origin ${branchName}`, colleaguePath)

          const project = yield* client.project.add({ repoPath: localPath })
          const workspace = yield* client.workspace.create({
            branchName,
            projectId: project.id,
          })

          yield* Effect.gen(function* () {
            const maxAttempts = 200
            for (let i = 0; i < maxAttempts; i++) {
              yield* Effect.sleep('100 millis')
              const row = store.query(
                tables.workspaces.where('id', workspace.id)
              )[0]
              if (row === undefined) {
                return assert.fail('Workspace row deleted during setup')
              }
              if (row.status === 'errored') {
                return assert.fail(row.errorMessage ?? 'Workspace errored')
              }
              if (row.status === 'running') {
                return
              }
            }
            assert.fail('Timed out waiting for workspace to run')
          })

          assert.strictEqual(
            readFileSync(
              join(workspace.worktreePath, 'colleague.txt'),
              'utf-8'
            ),
            'from remote branch'
          )
          assert.strictEqual(
            git(`rev-parse ${branchName}`, localPath),
            git(`rev-parse origin/${branchName}`, localPath)
          )
        })
      )
  )

  it.scopedLive(
    'workspace.create ignores legacy dev-server config and creates a local worktree',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo(
            'rpc-workspace-create-local-only',
            tempRoots
          )
          const worktreeRoot = createTempDir(
            'rpc-worktree-root-local-only',
            tempRoots
          )
          const branchName = 'feature/rpc-local-only'

          writeLaborerConfig(repoPath, {
            devServer: {
              image: 'node:lts',
              provider: 'none',
              setupScripts: ['touch should-not-run-devserver-setup'],
              startCommand: 'touch should-not-start-devserver',
            },
            setupScripts: [`printf 'ran' > ${SETUP_ENV_FILE}`],
            worktreeDir: worktreeRoot,
          })
          git('add laborer.json', repoPath)
          git('commit -m "add local config"', repoPath)

          const project = yield* client.project.add({ repoPath })
          const workspace = yield* client.workspace.create({
            branchName,
            projectId: project.id,
          })

          yield* Effect.gen(function* () {
            const maxAttempts = 200
            for (let i = 0; i < maxAttempts; i++) {
              yield* Effect.sleep('100 millis')
              const row = store.query(
                tables.workspaces.where('id', workspace.id)
              )[0]
              if (row?.status === 'errored') {
                return assert.fail(
                  `Workspace errored during local setup: ${row.errorMessage ?? ''}`
                )
              }
              if (row?.status === 'running' && row.worktreeSetupStep === null) {
                return
              }
            }
            assert.fail('Timed out waiting for local workspace setup')
          })

          assert.isTrue(existsSync(workspace.worktreePath))
          assert.strictEqual(
            readFileSync(join(workspace.worktreePath, SETUP_ENV_FILE), 'utf-8'),
            'ran'
          )
          assert.isFalse(
            existsSync(
              join(workspace.worktreePath, 'should-not-run-devserver-setup')
            )
          )
          assert.isFalse(
            existsSync(
              join(workspace.worktreePath, 'should-not-start-devserver')
            )
          )

          const workspaceRow = store.query(
            tables.workspaces.where('id', workspace.id)
          )[0]
          assert.isDefined(workspaceRow)
          if (workspaceRow === undefined) {
            assert.fail('Expected local workspace row to exist')
          }
        })
      )
  )

  it.scopedLive(
    'workspace.create with baseWorkspaceId branches from the parent worktree HEAD, pushes the parent branch, and records baseBranch',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const { localPath, remotePath } = initRemoteRepo(
            'rpc-sub-workspace',
            tempRoots
          )
          const worktreeRoot = createTempDir(
            'rpc-sub-workspace-root',
            tempRoots
          )

          writeLaborerConfig(localPath, {
            devServer: { image: null },
            setupScripts: [],
            worktreeDir: worktreeRoot,
          })
          git('add laborer.json', localPath)
          git('commit -m "add laborer config"', localPath)

          const waitForRunning = (workspaceId: string) =>
            Effect.gen(function* () {
              const maxAttempts = 200
              for (let i = 0; i < maxAttempts; i++) {
                yield* Effect.sleep('100 millis')
                const row = store.query(
                  tables.workspaces.where('id', workspaceId)
                )[0]
                if (row?.status === 'errored') {
                  return assert.fail(
                    `Workspace errored: ${row.errorMessage ?? ''}`
                  )
                }
                if (
                  row?.status === 'running' &&
                  row.worktreeSetupStep === null
                ) {
                  return
                }
              }
              assert.fail('Timed out waiting for workspace to run')
            })

          const project = yield* client.project.add({ repoPath: localPath })
          const parent = yield* client.workspace.create({
            branchName: 'feat/big-thing',
            projectId: project.id,
          })
          yield* waitForRunning(parent.id)

          // Advance the parent branch past the main checkout's HEAD so we can
          // prove the sub-workspace branches from the parent, not the repo.
          writeFileSync(join(parent.worktreePath, 'parent-work.txt'), 'work')
          git('add parent-work.txt', parent.worktreePath)
          git('commit -m "parent work"', parent.worktreePath)
          const parentHeadSha = git('rev-parse HEAD', parent.worktreePath)

          const child = yield* client.workspace.create({
            branchName: 'fix/auth',
            projectId: project.id,
            baseWorkspaceId: parent.id,
          })
          yield* waitForRunning(child.id)

          // Sub-workspace starts at the parent's HEAD, not the repo's HEAD.
          assert.strictEqual(
            git('rev-parse HEAD', child.worktreePath),
            parentHeadSha
          )
          assert.notStrictEqual(git('rev-parse HEAD', localPath), parentHeadSha)

          const childRow = store.query(
            tables.workspaces.where('id', child.id)
          )[0]
          assert.isDefined(childRow)
          assert.strictEqual(childRow?.baseBranch, 'feat/big-thing')
          // Diff base is the parent HEAD at creation time.
          assert.strictEqual(childRow?.baseSha, parentHeadSha)

          // The parent branch was auto-pushed so the child's PR base exists
          // on the remote.
          assert.strictEqual(
            git('rev-parse feat/big-thing', remotePath),
            parentHeadSha
          )

          // Ordinary workspaces record no baseBranch.
          const parentRow = store.query(
            tables.workspaces.where('id', parent.id)
          )[0]
          assert.isNull(parentRow?.baseBranch)
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
    'workspace.destroy does not emit duplicate destroy events after the workspace is already gone',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo(
            'rpc-workspace-destroy-idempotent',
            tempRoots
          )
          const worktreeRoot = createTempDir(
            'rpc-workspace-destroy-idempotent-root',
            tempRoots
          )
          const branchName = 'feature/rpc-destroy-idempotent'

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

          const commitSpy = vi.spyOn(store, 'commit')

          yield* client.workspace.destroy({ workspaceId: workspace.id })
          yield* waitForWorkspaceRemoval(store, workspace.id)

          yield* client.workspace.destroy({ workspaceId: workspace.id })

          const workspaceDestroyedCommits = commitSpy.mock.calls.filter(
            ([event]) =>
              typeof event === 'object' &&
              event !== null &&
              'name' in event &&
              event.name === 'v1.WorkspaceDestroyed'
          )

          assert.strictEqual(workspaceDestroyedCommits.length, 1)

          commitSpy.mockRestore()
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

  it.scopedLive(
    'workspace.create transitions to errored with setup steps cleared when setup script fails',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const repoPath = initRepo('rpc-workspace-setup-fail', tempRoots)
          const worktreeRoot = createTempDir(
            'rpc-workspace-setup-fail-root',
            tempRoots
          )
          const branchName = 'feature/rpc-setup-fail'

          writeLaborerConfig(repoPath, {
            devServer: { image: null },
            setupScripts: ['exit 42'],
            worktreeDir: worktreeRoot,
          })
          git('add laborer.json', repoPath)
          git('commit -m "add laborer config with failing script"', repoPath)

          const project = yield* client.project.add({ repoPath })
          const workspace = yield* client.workspace.create({
            branchName,
            projectId: project.id,
          })

          assert.strictEqual(workspace.status, 'creating')

          // Wait for the setup script phase to fail. The workspace may hit
          // 'running' first because the worktree itself is already ready.
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
                  'Workspace row deleted — expected it to transition to errored'
                )
              }
              if (row.status === 'errored') {
                // The key assertion: setup steps must be cleared
                assert.isNull(
                  row.worktreeSetupStep,
                  'worktreeSetupStep should be cleared on error'
                )
                // Error message should mention the failed script
                assert.isString(row.errorMessage)
                assert.include(row.errorMessage ?? '', 'exit 42')
                return
              }
            }
            assert.fail(
              'Timed out waiting for workspace to transition to errored'
            )
          })
        })
      )
  )

  it.scopedLive('workspace.refreshSyncStatus returns ahead/behind counts', () =>
    runWithRpcTestContext(({ client, store }) =>
      Effect.gen(function* () {
        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => cleanupTempRoots(tempRoots))
        )

        const { localPath, remotePath } = initRemoteRepo(
          'rpc-sync-status',
          tempRoots
        )
        const remoteClonePath = createRemoteClone(
          remotePath,
          'rpc-sync-status-remote',
          tempRoots
        )

        commitFile(localPath, 'local.txt', 'local change\n')
        commitFile(remoteClonePath, 'remote.txt', 'remote change\n')
        git('push origin main', remoteClonePath)
        git('fetch origin', localPath)

        const project = yield* client.project.add({ repoPath: localPath })
        const workspaceId = crypto.randomUUID()
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId: project.id,
            taskSource: null,
            branchName: 'main',
            worktreePath: localPath,
            status: 'stopped',
            origin: 'external',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const result = yield* client.workspace.refreshSyncStatus({
          workspaceId,
        })

        assert.deepStrictEqual(result, {
          aheadCount: 1,
          behindCount: 1,
        })
      })
    )
  )

  it.scopedLive('workspace.push pushes commits and refreshes sync status', () =>
    runWithRpcTestContext(({ client, store }) =>
      Effect.gen(function* () {
        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => cleanupTempRoots(tempRoots))
        )

        const { localPath, remotePath } = initRemoteRepo(
          'rpc-sync-push',
          tempRoots
        )

        commitFile(localPath, 'push.txt', 'push me\n')

        const project = yield* client.project.add({ repoPath: localPath })
        const workspaceId = crypto.randomUUID()
        store.commit(
          events.workspaceCreated({
            id: workspaceId,
            projectId: project.id,
            taskSource: null,
            branchName: 'main',
            worktreePath: localPath,
            status: 'stopped',
            origin: 'external',
            createdAt: new Date().toISOString(),
            baseSha: null,
          })
        )

        const result = yield* client.workspace.push({ workspaceId })

        assert.deepStrictEqual(result, {
          aheadCount: 0,
          behindCount: 0,
        })
        assert.strictEqual(git('rev-list --count main', remotePath), '2')
      })
    )
  )

  it.scopedLive(
    'workspace.pull pulls remote commits and refreshes sync status',
    () =>
      runWithRpcTestContext(({ client, store }) =>
        Effect.gen(function* () {
          const tempRoots: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => cleanupTempRoots(tempRoots))
          )

          const { localPath, remotePath } = initRemoteRepo(
            'rpc-sync-pull',
            tempRoots
          )
          const remoteClonePath = createRemoteClone(
            remotePath,
            'rpc-sync-pull-remote',
            tempRoots
          )

          commitFile(remoteClonePath, 'pulled.txt', 'from remote\n')
          git('push origin main', remoteClonePath)
          git('fetch origin', localPath)

          const project = yield* client.project.add({ repoPath: localPath })
          const workspaceId = crypto.randomUUID()
          store.commit(
            events.workspaceCreated({
              id: workspaceId,
              projectId: project.id,
              taskSource: null,
              branchName: 'main',
              worktreePath: localPath,
              status: 'stopped',
              origin: 'external',
              createdAt: new Date().toISOString(),
              baseSha: null,
            })
          )

          const result = yield* client.workspace.pull({ workspaceId })

          assert.deepStrictEqual(result, {
            aheadCount: 0,
            behindCount: 0,
          })
          assert.strictEqual(
            git('show HEAD:pulled.txt', localPath),
            'from remote'
          )
        })
      )
  )
})
