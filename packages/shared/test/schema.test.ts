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

const leafPane = {
  _tag: 'LeafNode',
  id: 'pane-1',
  paneType: 'terminal',
  terminalId: 'terminal-1',
  workspaceId: 'workspace-1',
} as const

const splitLayout = {
  _tag: 'SplitNode',
  id: 'layout-root',
  direction: 'horizontal',
  children: [
    leafPane,
    {
      _tag: 'LeafNode',
      id: 'pane-2',
      paneType: 'diff',
      diffOpen: true,
      workspaceId: 'workspace-1',
    },
  ],
  sizes: [0.6, 0.4],
} as const

const restoredLayout = {
  _tag: 'LeafNode',
  id: 'pane-restored',
  paneType: 'terminal',
  terminalId: 'terminal-2',
  workspaceId: 'workspace-1',
} as const

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
            rlphConfig: null,
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
          rlphConfig: null,
        })

        store.commit(events.projectRemoved({ id: 'project-1' }))

        assert.deepStrictEqual(
          store.query(tables.projects.where('id', 'project-1')),
          []
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
            rlphConfig: null,
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
              rlphConfig: null,
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
            port: 4321,
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
          port: 4321,
          status: 'creating',
          origin: 'laborer',
          createdAt: '2026-03-06T00:00:00.000Z',
          baseSha: 'abc123',
          containerId: null,
          containerUrl: null,
          containerImage: null,
          containerStatus: null,
          containerSetupStep: null,
          prNumber: null,
          prUrl: null,
          prTitle: null,
          prState: null,
          worktreeSetupStep: null,
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
            port: 4322,
            status: 'running',
            origin: 'laborer',
            createdAt: '2026-03-06T00:00:00.000Z',
            baseSha: 'def456',
          })
        )

        // Verify container fields start as null
        const beforeContainer = store.query(
          tables.workspaces.where('id', 'workspace-container')
        )
        assert.strictEqual(beforeContainer.length, 1)
        assert.strictEqual(beforeContainer[0]?.containerId, null)
        assert.strictEqual(beforeContainer[0]?.containerUrl, null)
        assert.strictEqual(beforeContainer[0]?.containerImage, null)
        assert.strictEqual(beforeContainer[0]?.containerStatus, null)

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
        assert.strictEqual(afterStart[0]?.containerId, 'docker-abc123')
        assert.strictEqual(
          afterStart[0]?.containerUrl,
          'feature-container-test--project-1.orb.local'
        )
        assert.strictEqual(afterStart[0]?.containerImage, 'node:22')
        assert.strictEqual(afterStart[0]?.containerStatus, 'running')

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
        assert.strictEqual(afterPause[0]?.containerStatus, 'paused')
        // Other container fields should be preserved
        assert.strictEqual(afterPause[0]?.containerId, 'docker-abc123')
        assert.strictEqual(afterPause[0]?.containerImage, 'node:22')

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
        assert.strictEqual(afterUnpause[0]?.containerStatus, 'running')
        assert.strictEqual(afterUnpause[0]?.containerId, 'docker-abc123')

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
        assert.strictEqual(afterStop[0]?.containerId, null)
        assert.strictEqual(afterStop[0]?.containerUrl, null)
        assert.strictEqual(afterStop[0]?.containerImage, null)
        assert.strictEqual(afterStop[0]?.containerStatus, null)

        // Verify other workspace fields are preserved after container events
        assert.strictEqual(afterStop[0]?.branchName, 'feature/container-test')
        assert.strictEqual(afterStop[0]?.port, 4322)
        assert.strictEqual(afterStop[0]?.status, 'running')
      })
  )

  it.scoped('materializes diff lifecycle events into the diffs table', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.diffUpdated({
          workspaceId: 'workspace-1',
          diffContent: 'diff --git a/file.ts b/file.ts',
          lastUpdated: '2026-03-06T00:00:00.000Z',
        })
      )

      store.commit(
        events.diffUpdated({
          workspaceId: 'workspace-1',
          diffContent: 'diff --git a/file.ts b/file.ts\n+updated line',
          lastUpdated: '2026-03-06T00:01:00.000Z',
        })
      )

      assert.deepStrictEqual(store.query(tables.diffs), [
        {
          workspaceId: 'workspace-1',
          diffContent: 'diff --git a/file.ts b/file.ts\n+updated line',
          lastUpdated: '2026-03-06T00:01:00.000Z',
        },
      ])

      store.commit(events.diffCleared({ workspaceId: 'workspace-1' }))

      assert.deepStrictEqual(
        store.query(tables.diffs.where('workspaceId', 'workspace-1')),
        []
      )
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

  it.scoped(
    'materializes panel layout events into the panel_layout table',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        store.commit(
          events.layoutSplit({
            windowId: 'window-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
          })
        )

        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            windowId: 'window-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
            workspaceOrder: null,
          },
        ])

        store.commit(
          events.layoutPaneClosed({
            windowId: 'window-1',
            layoutTree: leafPane,
            activePaneId: 'pane-1',
          })
        )

        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            windowId: 'window-1',
            layoutTree: leafPane,
            activePaneId: 'pane-1',
            workspaceOrder: null,
          },
        ])

        store.commit(
          events.layoutPaneAssigned({
            windowId: 'window-1',
            layoutTree: {
              ...leafPane,
              terminalId: 'terminal-3',
              id: 'pane-assigned',
            },
            activePaneId: 'pane-assigned',
          })
        )

        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            windowId: 'window-1',
            layoutTree: {
              ...leafPane,
              terminalId: 'terminal-3',
              id: 'pane-assigned',
            },
            activePaneId: 'pane-assigned',
            workspaceOrder: null,
          },
        ])

        store.commit(
          events.layoutRestored({
            windowId: 'window-1',
            layoutTree: restoredLayout,
            activePaneId: null,
          })
        )

        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            windowId: 'window-1',
            layoutTree: restoredLayout,
            activePaneId: null,
            workspaceOrder: null,
          },
        ])
      })
  )

  it.scoped(
    'stores multiple window-scoped panel layouts without overwriting each other',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        store.commit(
          events.layoutRestored({
            windowId: 'window-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
          })
        )
        store.commit(
          events.layoutRestored({
            windowId: 'window-2',
            layoutTree: restoredLayout,
            activePaneId: 'pane-restored',
          })
        )

        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            windowId: 'window-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
            workspaceOrder: null,
          },
          {
            windowId: 'window-2',
            layoutTree: restoredLayout,
            activePaneId: 'pane-restored',
            workspaceOrder: null,
          },
        ])
      })
  )

  it.scoped(
    'materializes layoutWorkspacesReordered into the panel_layout table',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        // Seed a layout first
        store.commit(
          events.layoutRestored({
            windowId: 'window-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
          })
        )

        // Existing row should have null workspaceOrder
        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            windowId: 'window-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
            workspaceOrder: null,
          },
        ])

        // Reorder workspaces
        store.commit(
          events.layoutWorkspacesReordered({
            windowId: 'window-1',
            workspaceOrder: ['workspace-2', 'workspace-1'],
          })
        )

        // workspaceOrder should be updated, layout and activePaneId preserved
        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            windowId: 'window-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
            workspaceOrder: ['workspace-2', 'workspace-1'],
          },
        ])
      })
  )

  it.scoped(
    'preserves workspaceOrder when layout events fire after a reorder',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        // Seed a layout
        store.commit(
          events.layoutRestored({
            windowId: 'session-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
          })
        )

        // Reorder workspaces
        store.commit(
          events.layoutWorkspacesReordered({
            windowId: 'session-1',
            workspaceOrder: ['workspace-2', 'workspace-1'],
          })
        )

        // Verify reorder was persisted
        assert.deepStrictEqual(
          store.query(tables.panelLayout)[0]?.workspaceOrder,
          ['workspace-2', 'workspace-1']
        )

        // Now simulate clicking a pane (layoutPaneAssigned)
        store.commit(
          events.layoutPaneAssigned({
            windowId: 'session-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-2',
          })
        )

        // workspaceOrder must survive the layoutPaneAssigned event
        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            windowId: 'session-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-2',
            workspaceOrder: ['workspace-2', 'workspace-1'],
          },
        ])

        // Also verify layoutSplit preserves workspaceOrder
        store.commit(
          events.layoutSplit({
            windowId: 'session-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
          })
        )

        assert.deepStrictEqual(
          store.query(tables.panelLayout)[0]?.workspaceOrder,
          ['workspace-2', 'workspace-1']
        )

        // Also verify layoutPaneClosed preserves workspaceOrder
        store.commit(
          events.layoutPaneClosed({
            windowId: 'session-1',
            layoutTree: leafPane,
            activePaneId: 'pane-1',
          })
        )

        assert.deepStrictEqual(
          store.query(tables.panelLayout)[0]?.workspaceOrder,
          ['workspace-2', 'workspace-1']
        )

        // Also verify layoutRestored preserves workspaceOrder
        store.commit(
          events.layoutRestored({
            windowId: 'session-1',
            layoutTree: restoredLayout,
            activePaneId: null,
          })
        )

        assert.deepStrictEqual(
          store.query(tables.panelLayout)[0]?.workspaceOrder,
          ['workspace-2', 'workspace-1']
        )
      })
  )

  it.scoped('keeps deprecated terminal events as no-op materializers', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.projectCreated({
          id: 'project-1',
          repoPath: '/tmp/project-1',
          name: 'Project One',
          rlphConfig: null,
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
        events.diffUpdated({
          workspaceId: 'workspace-1',
          diffContent: 'diff --git a/file.ts b/file.ts',
          lastUpdated: '2026-03-06T00:00:00.000Z',
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
      store.commit(
        events.layoutRestored({
          windowId: 'window-1',
          layoutTree: restoredLayout,
          activePaneId: 'pane-restored',
        })
      )

      const beforeDeprecatedEvents = {
        projects: store.query(tables.projects),
        workspaces: store.query(tables.workspaces),
        diffs: store.query(tables.diffs),
        tasks: store.query(tables.tasks),
        prds: store.query(tables.prds),
        panelLayout: store.query(tables.panelLayout),
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
          diffs: store.query(tables.diffs),
          tasks: store.query(tables.tasks),
          prds: store.query(tables.prds),
          panelLayout: store.query(tables.panelLayout),
        },
        beforeDeprecatedEvents
      )
    })
  )
})
