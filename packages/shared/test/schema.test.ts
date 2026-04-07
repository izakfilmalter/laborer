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
            brrrConfig: null,
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
          brrrConfig: null,
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
            brrrConfig: null,
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
              brrrConfig: null,
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
  // windowLayoutUpdated — single unified layout event
  // ---------------------------------------------------------------------------

  it.scoped('keeps deprecated terminal events as no-op materializers', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.projectCreated({
          id: 'project-1',
          repoPath: '/tmp/project-1',
          name: 'Project One',
          brrrConfig: null,
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
          tasks: store.query(tables.tasks),
          prds: store.query(tables.prds),
          panelLayout: store.query(tables.panelLayout),
        },
        beforeDeprecatedEvents
      )
    })
  )

  // ---------------------------------------------------------------------------
  // windowLayoutUpdated — single unified layout event
  // ---------------------------------------------------------------------------

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

  it.scoped(
    'windowLayoutUpdated persists a valid WindowLayout and is queryable',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        store.commit(
          events.windowLayoutUpdated({
            windowId: 'window-1',
            windowLayout: singleTabLayout,
            reason: 'initial-seed',
          })
        )

        const result = store.query(tables.panelLayout)
        assert.strictEqual(result.length, 1)
        assert.deepStrictEqual(result[0], {
          windowId: 'window-1',
          windowLayout: singleTabLayout,
        })
      })
  )

  it.scoped('windowLayoutUpdated upserts on same windowId (overwrites)', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.windowLayoutUpdated({
          windowId: 'window-1',
          windowLayout: singleTabLayout,
        })
      )

      store.commit(
        events.windowLayoutUpdated({
          windowId: 'window-1',
          windowLayout: twoTabLayout,
          reason: 'tab-added',
        })
      )

      const result = store.query(tables.panelLayout)
      assert.strictEqual(result.length, 1)
      assert.deepStrictEqual(result[0]?.windowLayout, twoTabLayout)
    })
  )

  it.scoped(
    'windowLayoutUpdated reason field is optional and does not affect materialization',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        // Without reason
        store.commit(
          events.windowLayoutUpdated({
            windowId: 'window-1',
            windowLayout: singleTabLayout,
          })
        )

        const result1 = store.query(tables.panelLayout)
        assert.deepStrictEqual(result1[0]?.windowLayout, singleTabLayout)

        // With reason — same result
        store.commit(
          events.windowLayoutUpdated({
            windowId: 'window-1',
            windowLayout: twoTabLayout,
            reason: 'split',
          })
        )

        const result2 = store.query(tables.panelLayout)
        assert.deepStrictEqual(result2[0]?.windowLayout, twoTabLayout)
      })
  )

  it.scoped(
    'panelLayout table returns only windowId and windowLayout columns',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        store.commit(
          events.windowLayoutUpdated({
            windowId: 'window-1',
            windowLayout: singleTabLayout,
          })
        )

        const result = store.query(tables.panelLayout)
        assert.strictEqual(result.length, 1)
        const row = result[0]
        assert.ok(row)
        const keys = Object.keys(row)
        assert.deepStrictEqual(keys.sort(), ['windowId', 'windowLayout'])
      })
  )

  it.scoped('windowLayoutUpdated stores multiple windows independently', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      store.commit(
        events.windowLayoutUpdated({
          windowId: 'window-1',
          windowLayout: singleTabLayout,
        })
      )

      const window2Layout = {
        tabs: [
          {
            id: 'wtab-3',
            workspaceLayout: {
              _tag: 'WorkspaceTileLeaf',
              id: 'tile-3',
              workspaceId: 'ws-3',
              panelTabs: [panelTab2],
              activePanelTabId: 'ptab-2',
            } as const,
          },
        ],
        activeTabId: 'wtab-3',
      }

      store.commit(
        events.windowLayoutUpdated({
          windowId: 'window-2',
          windowLayout: window2Layout,
        })
      )

      const result = store.query(tables.panelLayout)
      assert.strictEqual(result.length, 2)
      assert.strictEqual(result[0]?.windowId, 'window-1')
      assert.deepStrictEqual(result[0]?.windowLayout, singleTabLayout)
      assert.strictEqual(result[1]?.windowId, 'window-2')
      assert.deepStrictEqual(result[1]?.windowLayout, window2Layout)
    })
  )

  it.scoped(
    'windowLayoutUpdated with nested workspace tile splits round-trips correctly',
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
          events.windowLayoutUpdated({
            windowId: 'window-1',
            windowLayout: nestedLayout,
            reason: 'restore',
          })
        )

        const result = store.query(tables.panelLayout)
        assert.deepStrictEqual(result[0]?.windowLayout, nestedLayout)

        // Verify the nested structure is fully deserialized
        const wsLayout = result[0]?.windowLayout?.tabs[0]?.workspaceLayout
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
