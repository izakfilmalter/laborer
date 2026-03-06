import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { assert, describe, it } from '@effect/vitest'
import { events, tables } from '@laborer/shared/schema'
import { Effect, Either, Ref, type Scope } from 'effect'
import { createTempDir, git, initRepo } from '../helpers/git-helpers.js'
import { makeScopedTestRpcContext } from './test-layer.js'

type RpcTestContext = Effect.Effect.Success<typeof makeScopedTestRpcContext>

const SETUP_ENV_FILE = '.laborer-setup-env'
const CREATE_BRANCH_PATTERN = /feature\/rpc-create/
const EXTERNAL_BRANCH_PATTERN = /feature\/rpc-external/

const cleanupTempRoots = (tempRoots: readonly string[]) => {
  for (const root of tempRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

const ensureBunSpawnForNodeTests = (): void => {
  const runtimeGlobal = globalThis as unknown as { Bun?: unknown }

  if (runtimeGlobal.Bun !== undefined) {
    return
  }

  runtimeGlobal.Bun = {
    spawn: (
      cmd: string[],
      options?: {
        readonly cwd?: string
        readonly env?: Record<string, string | undefined>
      }
    ) => {
      const child = spawn(cmd[0] ?? '', cmd.slice(1), {
        cwd: options?.cwd,
        env: options?.env,
      })

      return {
        stdout:
          child.stdout === null
            ? new ReadableStream<Uint8Array>()
            : Readable.toWeb(child.stdout),
        stderr:
          child.stderr === null
            ? new ReadableStream<Uint8Array>()
            : Readable.toWeb(child.stderr),
        exited: new Promise<number>((resolve) => {
          child.on('close', (code) => resolve(code ?? 1))
        }),
      }
    },
  }
}

const runWithRpcTestContext = <A, E>(
  run: (context: RpcTestContext) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E, Scope.Scope> =>
  Effect.gen(function* () {
    ensureBunSpawnForNodeTests()
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
  it.scoped(
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
          assert.strictEqual(workspace.status, 'running')
          assert.strictEqual(
            workspace.worktreePath,
            join(worktreeRoot, 'feature-rpc-create')
          )
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

          assert.deepStrictEqual(workspaceRow, {
            baseSha: workspaceRow.baseSha,
            branchName,
            createdAt: workspaceRow.createdAt,
            id: workspace.id,
            origin: 'laborer',
            port: 4100,
            projectId: project.id,
            status: 'running',
            taskSource: null,
            worktreePath: workspace.worktreePath,
            containerId: null,
            containerUrl: null,
            containerImage: null,
          })
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

  it.scoped(
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

          writeLaborerConfig(repoPath, { worktreeDir: worktreeRoot })
          git('add laborer.json', repoPath)
          git('commit -m "add laborer config"', repoPath)

          const project = yield* client.project.add({ repoPath })
          const workspace = yield* client.workspace.create({
            branchName,
            projectId: project.id,
          })

          yield* client.workspace.destroy({ workspaceId: workspace.id })

          assert.isFalse(existsSync(workspace.worktreePath))
          assert.strictEqual(git(`branch --list ${branchName}`, repoPath), '')
          assert.deepStrictEqual(
            store.query(tables.workspaces.where('id', workspace.id)),
            []
          )
          assert.deepStrictEqual(
            yield* Ref.get(terminalClientRecorder.killAllForWorkspaceCalls),
            [workspace.id]
          )
        })
      )
  )

  it.scoped(
    'workspace.destroy keeps external worktrees on disk while removing store state',
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

          assert.isTrue(existsSync(externalWorktreePath))
          assert.match(
            git(`branch --list ${branchName}`, repoPath),
            EXTERNAL_BRANCH_PATTERN
          )
          assert.deepStrictEqual(
            store.query(tables.workspaces.where('id', externalWorkspace.id)),
            []
          )
          assert.deepStrictEqual(
            yield* Ref.get(terminalClientRecorder.killAllForWorkspaceCalls),
            [externalWorkspace.id]
          )
        })
      )
  )
})
