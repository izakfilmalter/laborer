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
            id: 'session-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
          })
        )

        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            id: 'session-1',
            layoutTree: splitLayout,
            activePaneId: 'pane-1',
          },
        ])

        store.commit(
          events.layoutPaneClosed({
            id: 'session-1',
            layoutTree: leafPane,
            activePaneId: 'pane-1',
          })
        )

        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            id: 'session-1',
            layoutTree: leafPane,
            activePaneId: 'pane-1',
          },
        ])

        store.commit(
          events.layoutPaneAssigned({
            id: 'session-1',
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
            id: 'session-1',
            layoutTree: {
              ...leafPane,
              terminalId: 'terminal-3',
              id: 'pane-assigned',
            },
            activePaneId: 'pane-assigned',
          },
        ])

        store.commit(
          events.layoutRestored({
            id: 'session-1',
            layoutTree: restoredLayout,
            activePaneId: null,
          })
        )

        assert.deepStrictEqual(store.query(tables.panelLayout), [
          {
            id: 'session-1',
            layoutTree: restoredLayout,
            activePaneId: null,
          },
        ])
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
          id: 'session-1',
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
