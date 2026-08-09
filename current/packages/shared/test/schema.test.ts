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
    'keeps historical execution-environment events as no-op decoders',
    () =>
      Effect.gen(function* () {
        const store = yield* makeTestStore

        store.commit(
          events.workspaceCreated({
            id: 'workspace-history',
            projectId: 'project-1',
            taskSource: null,
            branchName: 'feature/history',
            worktreePath: '/tmp/project-1/.laborer/workspace-history',
            status: 'running',
            origin: 'laborer',
            createdAt: '2026-04-07T00:00:00.000Z',
            baseSha: 'abc123',
            sandboxProvider: 'historical-provider',
          })
        )

        const workspaceBeforeHistoricalEvents = structuredClone(
          store.query(tables.workspaces.where('id', 'workspace-history'))
        )

        store.commit(
          events.containerStarted({
            workspaceId: 'workspace-history',
            containerId: 'container-1',
            containerUrl: 'container.example.test',
            containerImage: 'node:22',
          })
        )
        store.commit(
          events.containerPortChanged({
            workspaceId: 'workspace-history',
            containerPort: 4000,
          })
        )
        store.commit(
          events.containerStopped({ workspaceId: 'workspace-history' })
        )
        store.commit(
          events.containerPaused({ workspaceId: 'workspace-history' })
        )
        store.commit(
          events.containerUnpaused({ workspaceId: 'workspace-history' })
        )
        store.commit(
          events.containerSetupStepChanged({
            workspaceId: 'workspace-history',
            step: 'historical-step',
          })
        )
        store.commit(
          events.sandboxStarted({
            workspaceId: 'workspace-history',
            sandboxId: 'historical-environment-1',
            sandboxUrl: 'historical-environment.example.test',
            sandboxImage: 'node:22',
            sandboxProvider: 'historical-provider',
          })
        )
        store.commit(
          events.sandboxStopped({ workspaceId: 'workspace-history' })
        )
        store.commit(events.sandboxPaused({ workspaceId: 'workspace-history' }))
        store.commit(
          events.sandboxResumed({ workspaceId: 'workspace-history' })
        )
        store.commit(
          events.sandboxSetupStepChanged({
            workspaceId: 'workspace-history',
            step: 'historical-step',
          })
        )
        store.commit(
          events.sandboxPortChanged({
            workspaceId: 'workspace-history',
            sandboxPort: 4000,
          })
        )
        store.commit(
          events.sandboxUrlChanged({
            workspaceId: 'workspace-history',
            sandboxUrl: 'updated.example.test',
          })
        )

        assert.deepStrictEqual(
          store.query(tables.workspaces.where('id', 'workspace-history')),
          workspaceBeforeHistoricalEvents
        )
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

  it.scoped('keeps historical task and PRD events as no-ops', () =>
    Effect.gen(function* () {
      const store = yield* makeTestStore

      assert.isFalse(schema.state.sqlite.tables.has('tasks'))
      assert.isFalse(schema.state.sqlite.tables.has('prds'))

      store.commit(
        events.taskCreated({
          id: 'task-1',
          projectId: 'project-1',
          source: 'manual',
          prdId: null,
          externalId: null,
          title: 'Cover schema compatibility',
          status: 'pending',
        })
      )
      store.commit(
        events.taskStatusChanged({ id: 'task-1', status: 'completed' })
      )
      store.commit(events.taskRemoved({ id: 'task-1' }))
      store.commit(
        events.prdCreated({
          id: 'prd-1',
          projectId: 'project-1',
          title: 'Historical planning',
          slug: 'historical-planning',
          filePath: '/tmp/PRD-historical-planning.md',
          status: 'draft',
          createdAt: '2026-03-06T00:00:00.000Z',
        })
      )
      store.commit(events.prdStatusChanged({ id: 'prd-1', status: 'active' }))
      store.commit(
        events.prdUpdated({
          id: 'prd-1',
          projectId: 'project-1',
          title: 'Updated historical planning',
          slug: 'updated-historical-planning',
          filePath: '/tmp/PRD-updated-historical-planning.md',
          status: 'active',
          createdAt: '2026-03-06T00:00:00.000Z',
        })
      )
      store.commit(events.prdRemoved({ id: 'prd-1' }))
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
