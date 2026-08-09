import { assert, describe, it } from '@effect/vitest'
import { makeAdapter } from '@livestore/adapter-node'
import { createStore, provideOtel } from '@livestore/livestore'
import { Effect } from 'effect'
import { events, schema, tables } from '../src/schema.js'

const makeTestStore = Effect.gen(function* () {
  const adapter = makeAdapter({ storage: { type: 'in-memory' } })

  return yield* createStore({
    schema,
    storeId: `test-${crypto.randomUUID()}`,
    adapter,
    batchUpdates: (run) => run(),
    disableDevtools: true,
  })
}).pipe(provideOtel({}))

describe('LiveStore schema', () => {
  it.scoped(
    'materializes project lifecycle events into the projects table',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        store.commit(
          events.projectCreated({
            id: 'project-1',
            repoPath: '/tmp/project-1',
            name: 'Project One',
          })
        )

        const createdProject = store.query(
          tables.projects.where('id', 'project-1')
        )

        assert.strictEqual(createdProject.length, 1)
        assert.deepStrictEqual(createdProject[0], {
          id: 'project-1',
          repoPath: '/tmp/project-1',
          repoId: null,
          canonicalGitCommonDir: null,
          name: 'Project One',
        })

        store.commit(events.projectRemoved({ id: 'project-1' }))

        assert.deepStrictEqual(
          store.query(tables.projects.where('id', 'project-1')),
          []
        )
      })
  )

  it.scoped('decodes historical project events with removed fields', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore
      const historicalPayload = {
        id: 'historical-project',
        repoPath: '/tmp/historical-project',
        name: 'Historical Project',
        removedConfigField: '.removed/config.toml',
      }

      store.commit(events.projectCreated(historicalPayload))

      assert.deepStrictEqual(
        store.query(tables.projects.where('id', 'historical-project')),
        [
          {
            id: 'historical-project',
            repoPath: '/tmp/historical-project',
            repoId: null,
            canonicalGitCommonDir: null,
            name: 'Historical Project',
          },
        ]
      )
    })
  )

  it.scoped(
    'backfills persisted repository identity onto existing projects',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        store.commit(
          events.projectCreated({
            id: 'project-1',
            repoPath: '/tmp/project-1',
            name: 'Project One',
          })
        )
        store.commit(
          events.projectRepositoryIdentityBackfilled({
            id: 'project-1',
            repoPath: '/private/tmp/project-1',
            repoId: 'repo-1',
            canonicalGitCommonDir: '/private/tmp/project-1/.git',
          })
        )

        assert.deepStrictEqual(
          store.query(tables.projects.where('id', 'project-1')),
          [
            {
              id: 'project-1',
              repoPath: '/private/tmp/project-1',
              repoId: 'repo-1',
              canonicalGitCommonDir: '/private/tmp/project-1/.git',
              name: 'Project One',
            },
          ]
        )
      })
  )

  it.scoped(
    'materializes workspace lifecycle events into the workspaces table',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        store.commit(
          events.workspaceCreated({
            id: 'workspace-1',
            projectId: 'project-1',
            taskSource: 'manual',
            branchName: 'feature/test-coverage',
            worktreePath: '/tmp/project-1/.laborer/workspace-1',
            status: 'creating',
            origin: 'laborer',
            createdAt: '2026-03-06T00:00:00.000Z',
            baseSha: 'abc123',
          })
        )

        const createdWorkspace = store.query(
          tables.workspaces.where('id', 'workspace-1')
        )

        assert.strictEqual(createdWorkspace.length, 1)
        assert.deepStrictEqual(createdWorkspace[0], {
          id: 'workspace-1',
          projectId: 'project-1',
          taskSource: 'manual',
          branchName: 'feature/test-coverage',
          worktreePath: '/tmp/project-1/.laborer/workspace-1',
          status: 'creating',
          origin: 'laborer',
          createdAt: '2026-03-06T00:00:00.000Z',
          baseSha: 'abc123',
          baseBranch: null,
          sandboxId: null,
          sandboxUrl: null,
          sandboxPort: null,
          sandboxImage: null,
          sandboxStatus: null,
          sandboxSetupStep: null,
          sandboxProvider: null,
          prNumber: null,
          prUrl: null,
          prTitle: null,
          prState: null,
          aheadCount: null,
          behindCount: null,
          worktreeSetupStep: null,
          errorMessage: null,
        })

        store.commit(
          events.workspaceStatusChanged({
            id: 'workspace-1',
            status: 'running',
          })
        )

        const updatedWorkspace = store.query(
          tables.workspaces.where('id', 'workspace-1')
        )

        assert.strictEqual(updatedWorkspace.length, 1)
        assert.strictEqual(updatedWorkspace[0]?.status, 'running')

        store.commit(events.workspaceDestroyed({ id: 'workspace-1' }))

        assert.deepStrictEqual(
          store.query(tables.workspaces.where('id', 'workspace-1')),
          []
        )
      })
  )

  it.scoped(
    'materializes baseBranch for sub-workspaces and defaults to null when absent',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        store.commit(
          events.workspaceCreated({
            id: 'workspace-sub',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'fix/auth',
            worktreePath: '/tmp/project-1.worktrees/fix-auth',
            status: 'creating',
            origin: 'laborer',
            createdAt: '2026-06-10T00:00:00.000Z',
            baseSha: 'abc123',
            baseBranch: 'feat/big-thing',
          })
        )

        const subWorkspace = store.query(
          tables.workspaces.where('id', 'workspace-sub')
        )
        assert.strictEqual(subWorkspace[0]?.baseBranch, 'feat/big-thing')

        // Events persisted before this field existed must still decode.
        store.commit(
          events.workspaceCreated({
            id: 'workspace-plain',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'feat/standalone',
            worktreePath: '/tmp/project-1.worktrees/feat-standalone',
            status: 'creating',
            origin: 'laborer',
            createdAt: '2026-06-10T00:00:00.000Z',
            baseSha: 'abc123',
          })
        )

        const plainWorkspace = store.query(
          tables.workspaces.where('id', 'workspace-plain')
        )
        assert.strictEqual(plainWorkspace[0]?.baseBranch, null)
      })
  )

  it.scoped(
    'materializes container lifecycle events on the workspaces table',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        // Create a workspace first
        store.commit(
          events.workspaceCreated({
            id: 'workspace-container',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'feature/container-test',
            worktreePath: '/tmp/project-1/.laborer/workspace-container',
            status: 'running',
            origin: 'laborer',
            createdAt: '2026-03-06T00:00:00.000Z',
            baseSha: 'def456',
          })
        )

        // Verify sandbox fields start as null
        const beforeContainer = store.query(
          tables.workspaces.where('id', 'workspace-container')
        )
        assert.strictEqual(beforeContainer.length, 1)
        assert.strictEqual(beforeContainer[0]?.sandboxId, null)
        assert.strictEqual(beforeContainer[0]?.sandboxUrl, null)
        assert.strictEqual(beforeContainer[0]?.sandboxImage, null)
        assert.strictEqual(beforeContainer[0]?.sandboxStatus, null)

        // Start a container
        store.commit(
          events.containerStarted({
            workspaceId: 'workspace-container',
            containerId: 'docker-abc123',
            containerUrl: 'feature-container-test--project-1.orb.local',
            containerImage: 'node:22',
          })
        )

        const afterStart = store.query(
          tables.workspaces.where('id', 'workspace-container')
        )
        assert.strictEqual(afterStart.length, 1)
        assert.strictEqual(afterStart[0]?.sandboxId, 'docker-abc123')
        assert.strictEqual(
          afterStart[0]?.sandboxUrl,
          'feature-container-test--project-1.orb.local'
        )
        assert.strictEqual(afterStart[0]?.sandboxImage, 'node:22')
        assert.strictEqual(afterStart[0]?.sandboxStatus, 'running')

        // Pause the container
        store.commit(
          events.containerPaused({
            workspaceId: 'workspace-container',
          })
        )

        const afterPause = store.query(
          tables.workspaces.where('id', 'workspace-container')
        )
        assert.strictEqual(afterPause.length, 1)
        assert.strictEqual(afterPause[0]?.sandboxStatus, 'paused')
        // Other sandbox fields should be preserved
        assert.strictEqual(afterPause[0]?.sandboxId, 'docker-abc123')
        assert.strictEqual(afterPause[0]?.sandboxImage, 'node:22')

        // Unpause the container
        store.commit(
          events.containerUnpaused({
            workspaceId: 'workspace-container',
          })
        )

        const afterUnpause = store.query(
          tables.workspaces.where('id', 'workspace-container')
        )
        assert.strictEqual(afterUnpause.length, 1)
        assert.strictEqual(afterUnpause[0]?.sandboxStatus, 'running')
        assert.strictEqual(afterUnpause[0]?.sandboxId, 'docker-abc123')

        // Stop the container
        store.commit(
          events.containerStopped({
            workspaceId: 'workspace-container',
          })
        )

        const afterStop = store.query(
          tables.workspaces.where('id', 'workspace-container')
        )
        assert.strictEqual(afterStop.length, 1)
        assert.strictEqual(afterStop[0]?.sandboxId, null)
        assert.strictEqual(
          afterStop[0]?.sandboxUrl,
          'feature-container-test--project-1.orb.local'
        )
        assert.strictEqual(afterStop[0]?.sandboxImage, 'node:22')
        assert.strictEqual(afterStop[0]?.sandboxStatus, null)

        // Verify other workspace fields are preserved after container events
        assert.strictEqual(afterStop[0]?.branchName, 'feature/container-test')
        assert.strictEqual(afterStop[0]?.status, 'running')
      })
  )

  // ---------------------------------------------------------------------------
  // v2.Sandbox* events — provider-agnostic sandbox lifecycle
  // ---------------------------------------------------------------------------

  it.scoped('v2.SandboxStarted sets sandbox fields and sandboxProvider', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.workspaceCreated({
          id: 'workspace-sandbox',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'feature/sandbox-test',
          worktreePath: '/tmp/project-1/.laborer/workspace-sandbox',
          status: 'running',
          origin: 'laborer',
          createdAt: '2026-04-07T00:00:00.000Z',
          baseSha: 'abc123',
        })
      )

      store.commit(
        events.sandboxStarted({
          workspaceId: 'workspace-sandbox',
          sandboxId: 'daytona-xyz789',
          sandboxUrl: 'https://3000-xyz789.preview.daytona.io',
          sandboxImage: 'node:22',
          sandboxPort: 3000,
          sandboxProvider: 'daytona',
        })
      )

      const row = store.query(
        tables.workspaces.where('id', 'workspace-sandbox')
      )
      assert.strictEqual(row.length, 1)
      assert.strictEqual(row[0]?.sandboxId, 'daytona-xyz789')
      assert.strictEqual(
        row[0]?.sandboxUrl,
        'https://3000-xyz789.preview.daytona.io'
      )
      assert.strictEqual(row[0]?.sandboxImage, 'node:22')
      assert.strictEqual(row[0]?.sandboxPort, 3000)
      assert.strictEqual(row[0]?.sandboxStatus, 'running')
      assert.strictEqual(row[0]?.sandboxSetupStep, null)
      assert.strictEqual(row[0]?.sandboxProvider, 'daytona')
    })
  )

  it.scoped('v2.SandboxStarted works without optional sandboxPort', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.workspaceCreated({
          id: 'workspace-sandbox-noport',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'feature/sandbox-noport',
          worktreePath: '/tmp/project-1/.laborer/workspace-sandbox-noport',
          status: 'running',
          origin: 'laborer',
          createdAt: '2026-04-07T00:00:00.000Z',
          baseSha: 'abc123',
        })
      )

      store.commit(
        events.sandboxStarted({
          workspaceId: 'workspace-sandbox-noport',
          sandboxId: 'docker-abc456',
          sandboxUrl: 'feature-sandbox-noport--project-1.orb.local',
          sandboxImage: 'node:22',
          sandboxProvider: 'docker',
        })
      )

      const row = store.query(
        tables.workspaces.where('id', 'workspace-sandbox-noport')
      )
      assert.strictEqual(row.length, 1)
      assert.strictEqual(row[0]?.sandboxId, 'docker-abc456')
      assert.strictEqual(row[0]?.sandboxPort, null)
      assert.strictEqual(row[0]?.sandboxProvider, 'docker')
    })
  )

  it.scoped('v2.SandboxStopped clears sandbox state', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.workspaceCreated({
          id: 'workspace-stop',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'feature/sandbox-stop',
          worktreePath: '/tmp/project-1/.laborer/workspace-stop',
          status: 'running',
          origin: 'laborer',
          createdAt: '2026-04-07T00:00:00.000Z',
          baseSha: 'abc123',
        })
      )

      store.commit(
        events.sandboxStarted({
          workspaceId: 'workspace-stop',
          sandboxId: 'daytona-stop-test',
          sandboxUrl: 'https://3000-stop.preview.daytona.io',
          sandboxImage: 'node:22',
          sandboxProvider: 'daytona',
        })
      )

      store.commit(events.sandboxStopped({ workspaceId: 'workspace-stop' }))

      const row = store.query(tables.workspaces.where('id', 'workspace-stop'))
      assert.strictEqual(row.length, 1)
      assert.strictEqual(row[0]?.sandboxId, null)
      assert.strictEqual(row[0]?.sandboxStatus, null)
      assert.strictEqual(row[0]?.sandboxSetupStep, null)
      // URL and image preserved (same as v1.ContainerStopped behavior)
      assert.strictEqual(
        row[0]?.sandboxUrl,
        'https://3000-stop.preview.daytona.io'
      )
      assert.strictEqual(row[0]?.sandboxImage, 'node:22')
    })
  )

  it.scoped('v2.SandboxPaused sets sandboxStatus to paused', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.workspaceCreated({
          id: 'workspace-pause',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'feature/sandbox-pause',
          worktreePath: '/tmp/project-1/.laborer/workspace-pause',
          status: 'running',
          origin: 'laborer',
          createdAt: '2026-04-07T00:00:00.000Z',
          baseSha: 'abc123',
        })
      )

      store.commit(
        events.sandboxStarted({
          workspaceId: 'workspace-pause',
          sandboxId: 'daytona-pause-test',
          sandboxUrl: 'https://3000-pause.preview.daytona.io',
          sandboxImage: 'node:22',
          sandboxProvider: 'daytona',
        })
      )

      store.commit(events.sandboxPaused({ workspaceId: 'workspace-pause' }))

      const row = store.query(tables.workspaces.where('id', 'workspace-pause'))
      assert.strictEqual(row.length, 1)
      assert.strictEqual(row[0]?.sandboxStatus, 'paused')
      // Other sandbox fields preserved
      assert.strictEqual(row[0]?.sandboxId, 'daytona-pause-test')
      assert.strictEqual(row[0]?.sandboxImage, 'node:22')
    })
  )

  it.scoped('v2.SandboxResumed sets sandboxStatus to running', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.workspaceCreated({
          id: 'workspace-resume',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'feature/sandbox-resume',
          worktreePath: '/tmp/project-1/.laborer/workspace-resume',
          status: 'running',
          origin: 'laborer',
          createdAt: '2026-04-07T00:00:00.000Z',
          baseSha: 'abc123',
        })
      )

      store.commit(
        events.sandboxStarted({
          workspaceId: 'workspace-resume',
          sandboxId: 'daytona-resume-test',
          sandboxUrl: 'https://3000-resume.preview.daytona.io',
          sandboxImage: 'node:22',
          sandboxProvider: 'daytona',
        })
      )

      store.commit(events.sandboxPaused({ workspaceId: 'workspace-resume' }))

      store.commit(events.sandboxResumed({ workspaceId: 'workspace-resume' }))

      const row = store.query(tables.workspaces.where('id', 'workspace-resume'))
      assert.strictEqual(row.length, 1)
      assert.strictEqual(row[0]?.sandboxStatus, 'running')
      assert.strictEqual(row[0]?.sandboxId, 'daytona-resume-test')
    })
  )

  it.scoped('v2.SandboxSetupStepChanged updates sandboxSetupStep', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.workspaceCreated({
          id: 'workspace-setup',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'feature/sandbox-setup',
          worktreePath: '/tmp/project-1/.laborer/workspace-setup',
          status: 'creating',
          origin: 'laborer',
          createdAt: '2026-04-07T00:00:00.000Z',
          baseSha: 'abc123',
        })
      )

      store.commit(
        events.sandboxSetupStepChanged({
          workspaceId: 'workspace-setup',
          step: 'creating-sandbox',
        })
      )

      const row1 = store.query(tables.workspaces.where('id', 'workspace-setup'))
      assert.strictEqual(row1[0]?.sandboxSetupStep, 'creating-sandbox')

      store.commit(
        events.sandboxSetupStepChanged({
          workspaceId: 'workspace-setup',
          step: 'pushing-code',
        })
      )

      const row2 = store.query(tables.workspaces.where('id', 'workspace-setup'))
      assert.strictEqual(row2[0]?.sandboxSetupStep, 'pushing-code')

      // Clear step (setup complete)
      store.commit(
        events.sandboxSetupStepChanged({
          workspaceId: 'workspace-setup',
          step: null,
        })
      )

      const row3 = store.query(tables.workspaces.where('id', 'workspace-setup'))
      assert.strictEqual(row3[0]?.sandboxSetupStep, null)
    })
  )

  it.scoped('v2.SandboxPortChanged updates sandboxPort', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.workspaceCreated({
          id: 'workspace-port',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'feature/sandbox-port',
          worktreePath: '/tmp/project-1/.laborer/workspace-port',
          status: 'running',
          origin: 'laborer',
          createdAt: '2026-04-07T00:00:00.000Z',
          baseSha: 'abc123',
        })
      )

      store.commit(
        events.sandboxStarted({
          workspaceId: 'workspace-port',
          sandboxId: 'daytona-port-test',
          sandboxUrl: 'https://3000-port.preview.daytona.io',
          sandboxImage: 'node:22',
          sandboxProvider: 'daytona',
        })
      )

      store.commit(
        events.sandboxPortChanged({
          workspaceId: 'workspace-port',
          sandboxPort: 8080,
        })
      )

      const row = store.query(tables.workspaces.where('id', 'workspace-port'))
      assert.strictEqual(row[0]?.sandboxPort, 8080)

      // Clear port
      store.commit(
        events.sandboxPortChanged({
          workspaceId: 'workspace-port',
          sandboxPort: null,
        })
      )

      const row2 = store.query(tables.workspaces.where('id', 'workspace-port'))
      assert.strictEqual(row2[0]?.sandboxPort, null)
    })
  )

  it.scoped('v2.SandboxUrlChanged updates sandboxUrl', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.workspaceCreated({
          id: 'workspace-url-change',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'feature/sandbox-url-change',
          worktreePath: '/tmp/project-1/.laborer/workspace-url-change',
          status: 'running',
          origin: 'laborer',
          createdAt: '2026-04-07T00:00:00.000Z',
          baseSha: 'abc123',
        })
      )

      store.commit(
        events.sandboxStarted({
          workspaceId: 'workspace-url-change',
          sandboxId: 'daytona-url-test',
          sandboxUrl: 'daytona-url-test',
          sandboxImage: 'daytona-default',
          sandboxProvider: 'daytona',
        })
      )

      // Initially sandboxUrl is the sandbox ID
      const row = store.query(
        tables.workspaces.where('id', 'workspace-url-change')
      )
      assert.strictEqual(row[0]?.sandboxUrl, 'daytona-url-test')

      // Update with full Daytona preview URL
      store.commit(
        events.sandboxUrlChanged({
          workspaceId: 'workspace-url-change',
          sandboxUrl: 'https://3000-daytona-url-test.preview.daytona.io',
        })
      )

      const row2 = store.query(
        tables.workspaces.where('id', 'workspace-url-change')
      )
      assert.strictEqual(
        row2[0]?.sandboxUrl,
        'https://3000-daytona-url-test.preview.daytona.io'
      )
    })
  )

  it.scoped(
    'v2.Sandbox* and v1.Container* events coexist and both materialize correctly',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        // Create two workspaces — one uses v1 events, one uses v2 events
        store.commit(
          events.workspaceCreated({
            id: 'workspace-v1',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'feature/v1-events',
            worktreePath: '/tmp/project-1/.laborer/workspace-v1',
            status: 'running',
            origin: 'laborer',
            createdAt: '2026-04-07T00:00:00.000Z',
            baseSha: 'abc123',
          })
        )
        store.commit(
          events.workspaceCreated({
            id: 'workspace-v2',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'feature/v2-events',
            worktreePath: '/tmp/project-1/.laborer/workspace-v2',
            status: 'running',
            origin: 'laborer',
            createdAt: '2026-04-07T00:00:00.000Z',
            baseSha: 'abc123',
          })
        )

        // v1 container event on workspace-v1
        store.commit(
          events.containerStarted({
            workspaceId: 'workspace-v1',
            containerId: 'docker-v1-123',
            containerUrl: 'v1-test.orb.local',
            containerImage: 'node:20',
          })
        )

        // v2 sandbox event on workspace-v2
        store.commit(
          events.sandboxStarted({
            workspaceId: 'workspace-v2',
            sandboxId: 'daytona-v2-456',
            sandboxUrl: 'https://3000-v2.preview.daytona.io',
            sandboxImage: 'node:22',
            sandboxProvider: 'daytona',
          })
        )

        const v1Row = store.query(tables.workspaces.where('id', 'workspace-v1'))
        const v2Row = store.query(tables.workspaces.where('id', 'workspace-v2'))

        // v1 event still writes to sandbox* columns
        assert.strictEqual(v1Row[0]?.sandboxId, 'docker-v1-123')
        assert.strictEqual(v1Row[0]?.sandboxUrl, 'v1-test.orb.local')
        assert.strictEqual(v1Row[0]?.sandboxStatus, 'running')
        // v1 events don't set sandboxProvider
        assert.strictEqual(v1Row[0]?.sandboxProvider, null)

        // v2 event writes to sandbox* columns with provider
        assert.strictEqual(v2Row[0]?.sandboxId, 'daytona-v2-456')
        assert.strictEqual(
          v2Row[0]?.sandboxUrl,
          'https://3000-v2.preview.daytona.io'
        )
        assert.strictEqual(v2Row[0]?.sandboxStatus, 'running')
        assert.strictEqual(v2Row[0]?.sandboxProvider, 'daytona')
      })
  )

  it.scoped('diff events are no-ops after Lazy File Service migration', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      // Diff events are deprecated — materializers return [] (no-op).
      // The events still decode successfully for backward compat,
      // but no rows are written to any table.
      store.commit(
        events.diffUpdated({
          workspaceId: 'workspace-1',
          diffContent: 'diff --git a/file.ts b/file.ts',
          lastUpdated: '2026-03-06T00:00:00.000Z',
        })
      )

      store.commit(events.diffCleared({ workspaceId: 'workspace-1' }))

      // No crash — events decode and commit without error
    })
  )

  it.scoped('materializes task lifecycle events into the tasks table', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.taskCreated({
          id: 'task-1',
          projectId: 'project-1',
          source: 'manual',
          prdId: 'prd-1',
          externalId: null,
          title: 'Cover schema materializers',
          status: 'pending',
        })
      )

      assert.deepStrictEqual(store.query(tables.tasks.where('id', 'task-1')), [
        {
          id: 'task-1',
          projectId: 'project-1',
          source: 'manual',
          prdId: 'prd-1',
          externalId: null,
          title: 'Cover schema materializers',
          status: 'pending',
        },
      ])

      store.commit(
        events.taskStatusChanged({ id: 'task-1', status: 'completed' })
      )

      assert.strictEqual(
        store.query(tables.tasks.where('id', 'task-1'))[0]?.status,
        'completed'
      )

      store.commit(events.taskRemoved({ id: 'task-1' }))

      assert.deepStrictEqual(
        store.query(tables.tasks.where('id', 'task-1')),
        []
      )
    })
  )

  it.scoped('materializes prd lifecycle events into the prds table', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.prdCreated({
          id: 'prd-1',
          projectId: 'project-1',
          title: 'MCP planning',
          slug: 'mcp-planning',
          filePath: '/tmp/PRD-mcp-planning.md',
          status: 'draft',
          createdAt: '2026-03-06T00:00:00.000Z',
        })
      )

      assert.deepStrictEqual(store.query(tables.prds.where('id', 'prd-1')), [
        {
          id: 'prd-1',
          projectId: 'project-1',
          title: 'MCP planning',
          slug: 'mcp-planning',
          filePath: '/tmp/PRD-mcp-planning.md',
          status: 'draft',
          createdAt: '2026-03-06T00:00:00.000Z',
        },
      ])

      store.commit(events.prdStatusChanged({ id: 'prd-1', status: 'active' }))

      assert.strictEqual(
        store.query(tables.prds.where('id', 'prd-1'))[0]?.status,
        'active'
      )

      store.commit(events.prdRemoved({ id: 'prd-1' }))

      assert.deepStrictEqual(store.query(tables.prds.where('id', 'prd-1')), [])
    })
  )

  // ---------------------------------------------------------------------------
  // Deprecated terminal events
  // ---------------------------------------------------------------------------

  it.scoped('keeps deprecated terminal events as no-op materializers', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.projectCreated({
          id: 'project-1',
          repoPath: '/tmp/project-1',
          name: 'Project One',
        })
      )
      store.commit(
        events.workspaceCreated({
          id: 'workspace-1',
          projectId: 'project-1',
          taskSource: null,
          branchName: 'feature/no-op-events',
          worktreePath: '/tmp/project-1/.laborer/workspace-1',
          port: 4321,
          status: 'running',
          origin: 'laborer',
          createdAt: '2026-03-06T00:00:00.000Z',
          baseSha: 'abc123',
        })
      )
      store.commit(
        events.taskCreated({
          id: 'task-1',
          projectId: 'project-1',
          source: 'manual',
          prdId: null,
          externalId: null,
          title: 'Backwards compatibility',
          status: 'pending',
        })
      )
      store.commit(
        events.prdCreated({
          id: 'prd-1',
          projectId: 'project-1',
          title: 'Deprecated terminal events',
          slug: 'deprecated-terminal-events',
          filePath: '/tmp/PRD-deprecated-terminal-events.md',
          status: 'draft',
          createdAt: '2026-03-06T00:00:00.000Z',
        })
      )

      const beforeDeprecatedEvents = {
        projects: store.query(tables.projects),
        workspaces: store.query(tables.workspaces),
        tasks: store.query(tables.tasks),
        prds: store.query(tables.prds),
      }

      store.commit(
        events.terminalSpawned({
          id: 'terminal-1',
          workspaceId: 'workspace-1',
          command: 'bun test',
          status: 'running',
          ptySessionRef: null,
        })
      )
      store.commit(
        events.terminalOutput({
          id: 'terminal-1',
          data: 'output',
        })
      )
      store.commit(
        events.terminalStatusChanged({
          id: 'terminal-1',
          status: 'exited',
        })
      )
      store.commit(events.terminalKilled({ id: 'terminal-1' }))
      store.commit(events.terminalRemoved({ id: 'terminal-1' }))
      store.commit(events.terminalRestarted({ id: 'terminal-1' }))

      assert.deepStrictEqual(
        {
          projects: store.query(tables.projects),
          workspaces: store.query(tables.workspaces),
          tasks: store.query(tables.tasks),
          prds: store.query(tables.prds),
        },
        beforeDeprecatedEvents
      )
    })
  )

  // ---------------------------------------------------------------------------
  // Panel layout client document
  // ---------------------------------------------------------------------------

  it('keeps window layout changes client-only', () => {
    assert.isTrue(events.windowLayoutUpdated.options.clientOnly)
  })

  const singlePanelLeaf = {
    _tag: 'LeafNode',
    id: 'panel-1',
    paneType: 'terminal',
    terminalId: 'term-1',
    workspaceId: 'ws-1',
  } as const

  const panelTab1 = {
    id: 'ptab-1',
    label: 'Terminal',
    panelLayout: singlePanelLeaf,
    focusedPaneId: 'panel-1',
  } as const

  const panelTab2 = {
    id: 'ptab-2',
    panelLayout: {
      _tag: 'LeafNode',
      id: 'panel-2',
      paneType: 'diff',
      workspaceId: 'ws-1',
    } as const,
  } as const

  const workspaceTileLeaf = {
    _tag: 'WorkspaceTileLeaf',
    id: 'tile-1',
    workspaceId: 'ws-1',
    panelTabs: [panelTab1],
    activePanelTabId: 'ptab-1',
  } as const

  const singleTabLayout = {
    tabs: [
      {
        id: 'wtab-1',
        label: 'Main',
        workspaceLayout: workspaceTileLeaf,
      },
    ],
    activeTabId: 'wtab-1',
  } as const

  const twoTabLayout = {
    tabs: [
      {
        id: 'wtab-1',
        label: 'Main',
        workspaceLayout: workspaceTileLeaf,
      },
      {
        id: 'wtab-2',
        label: 'Review',
        workspaceLayout: {
          _tag: 'WorkspaceTileLeaf',
          id: 'tile-2',
          workspaceId: 'ws-2',
          panelTabs: [panelTab2],
          activePanelTabId: 'ptab-2',
        } as const,
      },
    ],
    activeTabId: 'wtab-1',
  } as const

  const legacyReviewLayout = {
    tabs: [
      {
        id: 'wtab-review',
        workspaceLayout: {
          _tag: 'WorkspaceTileLeaf',
          id: 'tile-review',
          workspaceId: 'ws-1',
          panelTabs: [
            {
              id: 'ptab-review',
              panelLayout: {
                _tag: 'LeafNode',
                id: 'pane-review',
                paneType: 'review',
                workspaceId: 'ws-1',
              },
            },
          ],
          activePanelTabId: 'ptab-review',
        },
      },
    ],
    activeTabId: 'wtab-review',
  } as const

  it.scoped('panelLayout client document stores a valid WindowLayout', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        tables.panelLayout.set({ windowLayout: singleTabLayout }, 'window-1')
      )

      const result = store.query(tables.panelLayout.get('window-1'))
      assert.deepStrictEqual(result.windowLayout, singleTabLayout)
    })
  )

  it.scoped('panelLayout client document overwrites the same window', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        tables.panelLayout.set({ windowLayout: singleTabLayout }, 'window-1')
      )
      store.commit(
        tables.panelLayout.set({ windowLayout: twoTabLayout }, 'window-1')
      )

      const result = store.query(tables.panelLayout.get('window-1'))
      assert.deepStrictEqual(result.windowLayout, twoTabLayout)
    })
  )

  it.scoped(
    'legacy windowLayoutUpdated events no longer materialize layout',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        store.commit(
          events.windowLayoutUpdated({
            windowId: 'window-1',
            windowLayout: singleTabLayout,
            reason: 'legacy-event',
          })
        )

        const result = store.query(tables.panelLayout.get('window-1'))
        assert.deepStrictEqual(result.windowLayout, null)
      })
  )

  it.scoped('historical review layouts remain decodable', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.windowLayoutUpdated({
          windowId: 'window-1',
          windowLayout: legacyReviewLayout,
          reason: 'legacy-review-event',
        })
      )
      store.commit(
        tables.panelLayout.set({ windowLayout: legacyReviewLayout }, 'window-1')
      )

      const result = store.query(tables.panelLayout.get('window-1'))
      assert.deepStrictEqual(result.windowLayout, legacyReviewLayout)
    })
  )

  it.scoped(
    'panelLayout client document round-trips nested workspace splits',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        const nestedLayout = {
          tabs: [
            {
              id: 'wtab-1',
              label: 'Development',
              workspaceLayout: {
                _tag: 'WorkspaceTileSplit',
                id: 'wsplit-1',
                direction: 'horizontal',
                children: [
                  {
                    _tag: 'WorkspaceTileLeaf',
                    id: 'tile-1',
                    workspaceId: 'ws-1',
                    panelTabs: [panelTab1],
                    activePanelTabId: 'ptab-1',
                  },
                  {
                    _tag: 'WorkspaceTileLeaf',
                    id: 'tile-2',
                    workspaceId: 'ws-2',
                    panelTabs: [panelTab2],
                    activePanelTabId: 'ptab-2',
                  },
                ],
                sizes: [0.6, 0.4],
              } as const,
            },
          ],
          activeTabId: 'wtab-1',
        } as const

        store.commit(
          tables.panelLayout.set({ windowLayout: nestedLayout }, 'window-1')
        )

        const result = store.query(tables.panelLayout.get('window-1'))
        assert.deepStrictEqual(result.windowLayout, nestedLayout)

        const wsLayout = result.windowLayout?.tabs[0]?.workspaceLayout
        assert.strictEqual(wsLayout?._tag, 'WorkspaceTileSplit')
        if (wsLayout?._tag === 'WorkspaceTileSplit') {
          assert.strictEqual(wsLayout.children.length, 2)
          assert.strictEqual(wsLayout.direction, 'horizontal')
          assert.deepStrictEqual(wsLayout.sizes, [0.6, 0.4])
          assert.strictEqual(wsLayout.children[0]?._tag, 'WorkspaceTileLeaf')
          assert.strictEqual(wsLayout.children[1]?._tag, 'WorkspaceTileLeaf')
        }
      })
  )
})
