import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Ref, Result, type Scope } from 'effect'
import { createTempDir, git, initRepo } from '../helpers/git-helpers.js'
import { makeScopedTestRpcContext } from './test-layer.js'

type RpcTestContext = Effect.Success<typeof makeScopedTestRpcContext>

const SETUP_ENV_FILE = '.laborer-setup-env'
const CREATE_BRANCH_PATTERN = /feature\/rpc-create/

/**
 * Poll until the task releases its worktree.
 * destroyWorktree forks cleanup into a background daemon fiber, so the
 * cleared worktree path (the last step) signals that all cleanup is done.
 */
const waitForWorkspaceRemoval = (
  database: RpcTestContext['database'],
  workspaceId: string
) =>
  Effect.gen(function* () {
    const maxAttempts = 100
    for (let i = 0; i < maxAttempts; i++) {
      yield* Effect.sleep('100 millis')
      if (database.findTask(workspaceId)?.worktreePath === null) {
        return
      }
    }
    assert.fail('Timed out waiting for workspace task to release its worktree')
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
  it.live('workspace.create creates a worktree and runs setup scripts', () =>
    runWithRpcTestContext(({ client, database }) =>
      Effect.gen(function* () {
        const tempRoots: string[] = []
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => cleanupTempRoots(tempRoots))
        )

        const repoPath = initRepo('rpc-workspace-create', tempRoots)
        const worktreeRoot = createTempDir('rpc-worktree-root', tempRoots)
        const branchName = 'feature/rpc-create'

        writeLaborerConfig(repoPath, {
          setupScripts: [
            `printf '%s' "$LABORER_WORKSPACE_ID,$LABORER_BRANCH,$LABORER_WORKSPACE_PATH" > ${SETUP_ENV_FILE}`,
          ],
          worktreeDir: worktreeRoot,
        })
        git('add laborer.json', repoPath)
        git('commit -m "add laborer config"', repoPath)

        const project = yield* client['project.add']({ repoPath })
        const workspace = yield* client['workspace.create']({
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
        // The fiber is forked into the layer scope so we poll the database,
        // yielding via Effect.sleep to let the background fiber progress.
        yield* Effect.gen(function* () {
          const maxAttempts = 200
          for (let i = 0; i < maxAttempts; i++) {
            yield* Effect.sleep('100 millis')
            const row = database.findTask(workspace.id)
            if (row === null) {
              return assert.fail(
                'Workspace row deleted — setup likely errored and rolled back'
              )
            }
            if (row?.worktreeStatus === 'errored') {
              return assert.fail(
                `Workspace errored: ${row.worktreeError ?? ''}`
              )
            }
            if (row?.worktreeStatus === 'ready') {
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
            const row = database.findTask(workspace.id)
            if (row?.worktreeStatus === 'errored') {
              return assert.fail(
                `Workspace errored during setup scripts: ${row.worktreeError ?? ''}`
              )
            }
            if (row?.setupCompletedAt !== null) {
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

        const workspaceRow = database.findTask(workspace.id)
        assert.isDefined(workspaceRow)
        if (workspaceRow === null) {
          assert.fail(
            'Expected workspace.create to materialize a workspace task'
          )
        }

        assert.strictEqual(workspaceRow?.branchName, branchName)
        assert.strictEqual(workspaceRow?.id, workspace.id)
        assert.strictEqual(workspaceRow?.rootPath, project.repoPath)
        assert.strictEqual(workspaceRow?.worktreeStatus, 'ready')
        assert.isNumber(workspaceRow?.setupCompletedAt)
        assert.strictEqual(workspaceRow?.worktreePath, workspace.worktreePath)
      })
    )
  )

  it.live(
    'workspace.create checks out a remote-only branch when it exists on origin',
    () =>
      runWithRpcTestContext(({ client, database }) =>
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
            setupScripts: [],
            worktreeDir: worktreeRoot,
          })
          git('add laborer.json', localPath)
          git('commit -m "add laborer config"', localPath)

          git(`checkout -b ${branchName}`, colleaguePath)
          commitFile(colleaguePath, 'colleague.txt', 'from remote branch')
          git(`push -u origin ${branchName}`, colleaguePath)

          const project = yield* client['project.add']({ repoPath: localPath })
          const workspace = yield* client['workspace.create']({
            branchName,
            projectId: project.id,
          })

          yield* Effect.gen(function* () {
            const maxAttempts = 200
            for (let i = 0; i < maxAttempts; i++) {
              yield* Effect.sleep('100 millis')
              const row = database.findTask(workspace.id)
              if (row === null) {
                return assert.fail('Workspace row deleted during setup')
              }
              if (row.worktreeStatus === 'errored') {
                return assert.fail(row.worktreeError ?? 'Workspace errored')
              }
              if (row.worktreeStatus === 'ready') {
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

  it.live(
    'workspace.create ignores legacy dev-server config and creates a local worktree',
    () =>
      runWithRpcTestContext(({ client, database }) =>
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

          const project = yield* client['project.add']({ repoPath })
          const workspace = yield* client['workspace.create']({
            branchName,
            projectId: project.id,
          })

          yield* Effect.gen(function* () {
            const maxAttempts = 200
            for (let i = 0; i < maxAttempts; i++) {
              yield* Effect.sleep('100 millis')
              const row = database.findTask(workspace.id)
              if (row?.worktreeStatus === 'errored') {
                return assert.fail(
                  `Workspace errored during local setup: ${row.worktreeError ?? ''}`
                )
              }
              if (
                row?.worktreeStatus === 'ready' &&
                row.setupCompletedAt !== null
              ) {
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

          const workspaceRow = database.findTask(workspace.id)
          assert.isDefined(workspaceRow)
          if (workspaceRow === null) {
            assert.fail('Expected local workspace row to exist')
          }
        })
      )
  )

  it.live(
    'workspace.create with baseWorkspaceId branches from the parent worktree HEAD, pushes the parent branch, and records baseBranch',
    () =>
      runWithRpcTestContext(({ client, database }) =>
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
                const row = database.findTask(workspaceId)
                if (row?.worktreeStatus === 'errored') {
                  return assert.fail(
                    `Workspace errored: ${row.worktreeError ?? ''}`
                  )
                }
                if (
                  row?.worktreeStatus === 'ready' &&
                  row.setupCompletedAt !== null
                ) {
                  return
                }
              }
              assert.fail('Timed out waiting for workspace to run')
            })

          const project = yield* client['project.add']({ repoPath: localPath })
          const parent = yield* client['workspace.create']({
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

          const child = yield* client['workspace.create']({
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

          const childRow = database.findTask(child.id)
          assert.isDefined(childRow)
          assert.strictEqual(childRow?.baseBranch, 'feat/big-thing')
          // Diff base is the parent HEAD at creation time.
          assert.strictEqual(childRow?.baseSha, parentHeadSha)

          const parentTask = database.findTask(parent.id)
          const childTask = database.findTask(child.id)
          assert.isDefined(parentTask)
          assert.isDefined(childTask)
          assert.strictEqual(parentTask?.worktreeStatus, 'ready')
          assert.isNumber(parentTask?.setupCompletedAt)
          assert.strictEqual(childTask?.parentTaskId, parent.id)
          assert.strictEqual(childTask?.baseBranch, 'feat/big-thing')
          assert.strictEqual(childTask?.baseSha, parentHeadSha)
          assert.strictEqual(childTask?.worktreeStatus, 'ready')
          assert.isNumber(childTask?.setupCompletedAt)

          // The parent branch was auto-pushed so the child's PR base exists
          // on the remote.
          assert.strictEqual(
            git('rev-parse feat/big-thing', remotePath),
            parentHeadSha
          )

          // Ordinary workspaces record no baseBranch.
          const parentRow = database.findTask(parent.id)
          assert.isNull(parentRow?.baseBranch)
        })
      )
  )

  it.effect('workspace.create returns NOT_FOUND for an unknown project', () =>
    runWithRpcTestContext(({ client, database }) =>
      Effect.gen(function* () {
        const result = yield* client['workspace.create']({
          branchName: 'feature/missing-project',
          projectId: 'missing-project',
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isSuccess(result)) {
          assert.fail('Expected workspace.create to fail for a missing project')
        }

        assert.strictEqual(result.failure.code, 'NOT_FOUND')
        assert.strictEqual(
          result.failure.message,
          'Project not found: missing-project'
        )
        assert.deepStrictEqual(database.listTasks(), [])
      })
    )
  )

  it.live(
    'workspace.destroy removes laborer-managed worktrees and records terminal cleanup',
    () =>
      runWithRpcTestContext(({ client, database, terminalClientRecorder }) =>
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
          })
          git('add laborer.json', repoPath)
          git('commit -m "add laborer config"', repoPath)

          const project = yield* client['project.add']({ repoPath })
          const workspace = yield* client['workspace.create']({
            branchName,
            projectId: project.id,
          })

          yield* client['workspace.destroy']({ workspaceId: workspace.id })

          // destroyWorktree forks cleanup into a background daemon fiber.
          // Poll until the task releases its worktree (last cleanup step).
          yield* waitForWorkspaceRemoval(database, workspace.id)

          assert.isFalse(existsSync(workspace.worktreePath))
          assert.strictEqual(git(`branch --list ${branchName}`, repoPath), '')
          assert.deepStrictEqual(
            yield* Ref.get(terminalClientRecorder.killAllForWorkspaceCalls),
            [workspace.id]
          )
          assert.deepInclude(database.findTask(workspace.id), {
            id: workspace.id,
            worktreePath: null,
            worktreeStatus: null,
          })
        })
      )
  )

  it.live(
    'workspace.destroy removes external worktrees from disk and database state',
    () =>
      runWithRpcTestContext(({ client, database, terminalClientRecorder }) =>
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

          yield* client['project.add']({ repoPath })
          const externalWorkspace = database.findTaskByWorktreePath(
            realpathSync(externalWorktreePath)
          )

          assert.isDefined(externalWorkspace)
          if (externalWorkspace === null) {
            assert.fail('Expected the external workspace fixture to exist')
          }

          yield* client['workspace.destroy']({
            workspaceId: externalWorkspace.id,
          })

          // destroyWorktree forks cleanup into a background daemon fiber.
          // Poll until the task releases its worktree (last cleanup step).
          yield* waitForWorkspaceRemoval(database, externalWorkspace.id)

          assert.isFalse(existsSync(externalWorktreePath))
          assert.strictEqual(git(`branch --list ${branchName}`, repoPath), '')
          assert.deepStrictEqual(
            yield* Ref.get(terminalClientRecorder.killAllForWorkspaceCalls),
            [externalWorkspace.id]
          )
        })
      )
  )

  it.live(
    'workspace.destroy does not emit duplicate destroy events after the workspace is already gone',
    () =>
      runWithRpcTestContext(({ client, database }) =>
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
          })
          git('add laborer.json', repoPath)
          git('commit -m "add laborer config"', repoPath)

          const project = yield* client['project.add']({ repoPath })
          const workspace = yield* client['workspace.create']({
            branchName,
            projectId: project.id,
          })

          yield* client['workspace.destroy']({ workspaceId: workspace.id })
          yield* waitForWorkspaceRemoval(database, workspace.id)
          const changesAfterFirstDestroy = database.taskChangesAfter(0).length

          yield* client['workspace.destroy']({ workspaceId: workspace.id })

          assert.strictEqual(
            database.taskChangesAfter(0).length,
            changesAfterFirstDestroy
          )
        })
      )
  )

  it.live(
    'workspace.create succeeds for a branch whose previous workspace was just destroyed',
    () =>
      runWithRpcTestContext(({ client, database }) =>
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
          })
          git('add laborer.json', repoPath)
          git('commit -m "add laborer config"', repoPath)

          const project = yield* client['project.add']({ repoPath })

          // 1. Create the first workspace and wait for it to be running
          const first = yield* client['workspace.create']({
            branchName,
            projectId: project.id,
          })

          yield* Effect.gen(function* () {
            const maxAttempts = 200
            for (let i = 0; i < maxAttempts; i++) {
              yield* Effect.sleep('100 millis')
              const row = database.findTask(first.id)
              if (row === null) {
                return assert.fail(
                  'First workspace row deleted — setup errored and rolled back'
                )
              }
              if (row.worktreeStatus === 'errored') {
                return assert.fail(
                  `First workspace errored: ${row.worktreeError ?? ''}`
                )
              }
              if (row.worktreeStatus === 'ready') {
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
          yield* client['workspace.destroy']({
            workspaceId: first.id,
            force: true,
          })

          // 3. Immediately create a second workspace for the same branch.
          //    The old destroy's background fiber is still running
          //    (git worktree remove, git branch -D, etc.) — the create
          //    must not race with it.
          const second = yield* client['workspace.create']({
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
              const row = database.findTask(second.id)
              if (row === null) {
                return assert.fail(
                  'Second workspace row deleted — setup likely raced with destroy cleanup'
                )
              }
              if (row.worktreeStatus === 'errored') {
                return assert.fail(
                  `Second workspace errored: ${row.worktreeError ?? ''}`
                )
              }
              if (row.worktreeStatus === 'ready') {
                return
              }
            }
            assert.fail(
              'Timed out waiting for second workspace to reach running'
            )
          })

          // 5. Verify the second workspace is healthy
          assert.isTrue(existsSync(second.worktreePath))

          const finalTask = database.findTask(second.id)
          assert.isNotNull(finalTask)
          assert.strictEqual(finalTask?.worktreeStatus, 'ready')
        })
      )
  )

  it.live(
    'workspace.create transitions to errored with setup steps cleared when setup script fails',
    () =>
      runWithRpcTestContext(({ client, database }) =>
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
            setupScripts: ['exit 42'],
            worktreeDir: worktreeRoot,
          })
          git('add laborer.json', repoPath)
          git('commit -m "add laborer config with failing script"', repoPath)

          const project = yield* client['project.add']({ repoPath })
          const workspace = yield* client['workspace.create']({
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
              const row = database.findTask(workspace.id)
              if (row === null) {
                return assert.fail(
                  'Workspace row deleted — expected it to transition to errored'
                )
              }
              if (row.worktreeStatus === 'errored') {
                // Error message should mention the failed script
                assert.isString(row.worktreeError)
                assert.include(row.worktreeError ?? '', 'exit 42')
                return
              }
            }
            assert.fail(
              'Timed out waiting for workspace to transition to errored'
            )
          })

          assert.deepInclude(database.findTask(workspace.id), {
            setupCompletedAt: null,
            worktreeStatus: 'errored',
          })
          assert.include(
            database.findTask(workspace.id)?.worktreeError ?? '',
            'exit 42'
          )
        })
      )
  )

  it.live('workspace.refreshSyncStatus returns ahead/behind counts', () =>
    runWithRpcTestContext(({ client, database }) =>
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

        const project = yield* client['project.add']({ repoPath: localPath })
        const workspaceId = crypto.randomUUID()
        database.insertTask({
          branchName: 'main',
          id: workspaceId,
          rootPath: project.repoPath,
          source: 'worktree',
          status: 'in_progress',
          title: 'main',
          worktreePath: localPath,
          worktreeStatus: 'ready',
        })

        const result = yield* client['workspace.refreshSyncStatus']({
          workspaceId,
        })

        assert.deepStrictEqual(result, {
          aheadCount: 1,
          behindCount: 1,
        })
      })
    )
  )

  it.live('workspace.push pushes commits and refreshes sync status', () =>
    runWithRpcTestContext(({ client, database }) =>
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

        const project = yield* client['project.add']({ repoPath: localPath })
        const workspaceId = crypto.randomUUID()
        database.insertTask({
          branchName: 'main',
          id: workspaceId,
          rootPath: project.repoPath,
          source: 'worktree',
          status: 'in_progress',
          title: 'main',
          worktreePath: localPath,
          worktreeStatus: 'ready',
        })

        const result = yield* client['workspace.push']({ workspaceId })

        assert.deepStrictEqual(result, {
          aheadCount: 0,
          behindCount: 0,
        })
        assert.strictEqual(git('rev-list --count main', remotePath), '2')
      })
    )
  )

  it.live('workspace.pull pulls remote commits and refreshes sync status', () =>
    runWithRpcTestContext(({ client, database }) =>
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

        const project = yield* client['project.add']({ repoPath: localPath })
        const workspaceId = crypto.randomUUID()
        database.insertTask({
          branchName: 'main',
          id: workspaceId,
          rootPath: project.repoPath,
          source: 'worktree',
          status: 'in_progress',
          title: 'main',
          worktreePath: localPath,
          worktreeStatus: 'ready',
        })

        const result = yield* client['workspace.pull']({ workspaceId })

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
