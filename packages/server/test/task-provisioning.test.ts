import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { Deferred, Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  handleTaskCreateAtPath,
  handleTaskMoveAtPath,
} from '../src/rpc/handlers.js'
import { NodeTaskBoardDatabase } from '../src/services/node-task-board-database.js'
import { PrWatcher } from '../src/services/pr-watcher.js'
import { ProjectRegistry } from '../src/services/project-registry.js'
import { manualTaskBranchName } from '../src/services/task-card-creator.js'
import { WorkspaceProvider } from '../src/services/workspace-provider.js'
import { WorkspaceSyncService } from '../src/services/workspace-sync-service.js'
import { waitFor } from './helpers/timing-helpers.js'

// Analyzing a Slack thread spawns an agent, so the planner is stubbed and each
// test drives it directly.
const slackPlanner = vi.hoisted(() => ({
  plan: vi.fn<
    (permalink: string) => Effect.Effect<
      {
        readonly branchName: string
        readonly initialPrompt: string
        readonly title: string
        readonly workType: 'bug' | 'feature'
      },
      RpcError
    >
  >(),
}))

vi.mock('../src/services/slack-workspace-planner.js', () => ({
  planSlackWorkspace: (permalink: string) => slackPlanner.plan(permalink),
}))

const databasePath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'laborer-provisioning-')), 'tasks.sqlite')

const SLACK_PERMALINK = 'https://example.slack.com/archives/C1/p1'
const slackPlan = {
  branchName: 'slack/fix-auth',
  initialPrompt: 'Fix the auth flow',
  title: 'Fix auth flow',
  workType: 'bug',
} as const

/** Read a card through its own connection, the way another process would. */
const storedTask = (path: string, id: string) => {
  const database = NodeTaskBoardDatabase.open(path)
  try {
    return database.find(id)
  } finally {
    database.close()
  }
}

const project = {
  canonicalGitCommonDir: '/repo/.git',
  createdAt: '2026-08-10T00:00:00.000Z',
  defaultBranch: 'main',
  id: 'project-1',
  name: 'repo',
  repoId: 'repo-id',
  repoPath: '/repo',
}

const testLayer = (
  createWorktree: WorkspaceProvider['Service']['createWorktree'],
  findWorkspaceForTask: WorkspaceProvider['Service']['findWorkspaceForTask'] = () =>
    Effect.succeed(null)
) =>
  Layer.mergeAll(
    Layer.succeed(
      ProjectRegistry,
      ProjectRegistry.of({
        addProject: () => Effect.succeed(project),
        getProject: () => Effect.succeed(project),
        listProjects: () => Effect.succeed([project]),
        removeProject: () => Effect.void,
      })
    ),
    Layer.succeed(
      WorkspaceProvider,
      WorkspaceProvider.of({
        checkDirtyFiles: () => Effect.succeed([]),
        createWorktree,
        destroyWorktree: () => Effect.void,
        findWorkspaceForTask,
        getWorkspaceEnv: () => Effect.succeed({}),
      })
    ),
    Layer.succeed(
      PrWatcher,
      PrWatcher.of({
        checkPr: () =>
          Effect.succeed({
            baseBranch: null,
            checkStatus: null,
            checks: null,
            isDraft: false,
            mergeStatus: null,
            number: null,
            state: null,
            title: null,
            url: null,
          }),
        startPolling: () => Effect.void,
        isPolling: () => Effect.succeed(false),
        refreshPolling: () => Effect.void,
        stopAllPolling: () => Effect.void,
        stopPolling: () => Effect.void,
      })
    ),
    Layer.succeed(
      WorkspaceSyncService,
      WorkspaceSyncService.of({
        checkStatus: () => Effect.succeed({ aheadCount: 0, behindCount: 0 }),
        pull: () => Effect.succeed({ aheadCount: 0, behindCount: 0 }),
        push: () => Effect.succeed({ aheadCount: 0, behindCount: 0 }),
        startPolling: () => Effect.void,
        stopAllPolling: () => Effect.void,
        stopPolling: () => Effect.void,
      })
    )
  )

const workspace = {
  baseBranch: null,
  baseSha: null,
  branchName: 'laborer/12345678',
  createdAt: '2026-08-10T00:00:00.000Z',
  id: 'workspace-1',
  origin: 'laborer' as const,
  projectId: project.id,
  status: 'creating',
  taskSource: null,
  worktreePath: '/repo.worktrees/laborer-12345678',
}

/**
 * The durable record shape `findWorkspaceForTask` returns — the narrow
 * provisioning fixture plus the pull request facts PrWatcher persists.
 */
const durableWorkspace = {
  ...workspace,
  errorMessage: null,
  origin: 'laborer' as const,
  prBaseBranch: null,
  prCheckStatus: null,
  prChecks: null,
  prMergeStatus: null,
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  status: 'creating' as const,
  taskSource: '',
  worktreeSetupStep: null,
}

describe('task provisioning', () => {
  it('provisions a manual task created directly in In Progress', async () => {
    const path = databasePath()
    const createWorktree = vi.fn(() => Effect.succeed(workspace))

    const created = await Effect.runPromise(
      handleTaskCreateAtPath(
        { rootPath: '/repo', status: 'in_progress', text: 'Start now' },
        path
      ).pipe(Effect.provide(testLayer(createWorktree)))
    )

    expect(created).toMatchObject({
      source: 'manual',
      status: 'in_progress',
      workspaceId: workspace.id,
    })
    expect(createWorktree).toHaveBeenCalledTimes(1)
    expect(createWorktree).toHaveBeenCalledWith(
      project.id,
      manualTaskBranchName('Start now'),
      expect.any(Function),
      undefined,
      expect.any(Function),
      created.id
    )
  })

  it('asks for a pasted branch name verbatim so origin can supply it', async () => {
    const path = databasePath()
    const createWorktree = vi.fn(() => Effect.succeed(workspace))

    const created = await Effect.runPromise(
      handleTaskCreateAtPath(
        {
          rootPath: '/repo',
          status: 'in_progress',
          text: 'feature/colleague-pr',
        },
        path
      ).pipe(Effect.provide(testLayer(createWorktree)))
    )

    // The slugified title ("feature-colleague-pr") would never match
    // origin/feature/colleague-pr, so the colleague's commits would be lost.
    expect(createWorktree).toHaveBeenCalledWith(
      project.id,
      'feature/colleague-pr',
      expect.any(Function),
      undefined,
      expect.any(Function),
      created.id
    )
  })

  it('provisions once on entering In Progress and returns the stored prompt', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      description: 'Implement the queued work',
      id: 'task-1',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Queued work',
    })
    database.close()
    const createWorktree = vi.fn(() => Effect.succeed(workspace))
    const layer = testLayer(createWorktree)

    const first = await Effect.runPromise(
      handleTaskMoveAtPath(
        { expectedRevision: 1, status: 'in_progress', taskId: 'task-1' },
        path
      ).pipe(Effect.provide(layer))
    )

    expect(first).toMatchObject({
      description: 'Implement the queued work',
      workspaceId: workspace.id,
    })
    const afterFirst = NodeTaskBoardDatabase.open(path)
    expect(afterFirst.find('task-1')).toMatchObject({
      branchName: workspace.branchName,
      status: 'in_progress',
      worktreePath: workspace.worktreePath,
    })
    const todo = afterFirst.move('task-1', first.revision, 'todo')
    afterFirst.close()

    const second = await Effect.runPromise(
      handleTaskMoveAtPath(
        {
          expectedRevision: todo.revision,
          status: 'in_progress',
          taskId: 'task-1',
        },
        path
      ).pipe(Effect.provide(layer))
    )
    expect(second.workspaceId).toBeNull()
    expect(createWorktree).toHaveBeenCalledTimes(1)
  })

  it('provisions an agent-filed Todo task dragged into In Progress', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      description: 'Ship the follow-up work',
      id: 'task-agent',
      rootPath: '/repo',
      source: 'agent',
      status: 'todo',
      title: 'Agent staged work',
    })
    database.close()
    const createWorktree = vi.fn(() => Effect.succeed(workspace))

    const result = await Effect.runPromise(
      handleTaskMoveAtPath(
        { expectedRevision: 1, status: 'in_progress', taskId: 'task-agent' },
        path
      ).pipe(Effect.provide(testLayer(createWorktree)))
    )

    expect(result).toMatchObject({
      description: 'Ship the follow-up work',
      status: 'in_progress',
      workspaceId: workspace.id,
    })
    expect(createWorktree).toHaveBeenCalledTimes(1)
    expect(createWorktree).toHaveBeenCalledWith(
      project.id,
      manualTaskBranchName('Agent staged work'),
      expect.any(Function),
      undefined,
      expect.any(Function),
      'task-agent'
    )
    const bound = NodeTaskBoardDatabase.open(path)
    expect(bound.find('task-agent')).toMatchObject({
      branchName: workspace.branchName,
      status: 'in_progress',
      worktreePath: workspace.worktreePath,
    })
    bound.close()
  })

  it('returns a failed agent-task provisioning to Todo with a cleared branch', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      id: 'task-agent-failure',
      rootPath: '/repo',
      source: 'agent',
      status: 'todo',
      title: 'Agent broken worktree',
    })
    database.close()
    const createWorktree: WorkspaceProvider['Service']['createWorktree'] = () =>
      Effect.fail(
        new RpcError({
          code: 'GIT_WORKTREE_FAILED',
          message: 'git worktree add failed',
        })
      )

    const error = await Effect.runPromise(
      Effect.flip(
        handleTaskMoveAtPath(
          {
            expectedRevision: 1,
            status: 'in_progress',
            taskId: 'task-agent-failure',
          },
          path
        ).pipe(Effect.provide(testLayer(createWorktree)))
      )
    )
    expect(error).toMatchObject({ code: 'GIT_WORKTREE_FAILED' })

    const failed = NodeTaskBoardDatabase.open(path)
    expect(failed.find('task-agent-failure')).toMatchObject({
      branchName: null,
      status: 'todo',
      worktreePath: null,
    })
    failed.close()
  })

  it('keeps non-In-Progress moves as pure status writes', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      id: 'task-2',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Declare done',
    })
    database.close()
    const createWorktree = vi.fn(() => Effect.succeed(workspace))

    const result = await Effect.runPromise(
      handleTaskMoveAtPath(
        { expectedRevision: 1, status: 'done', taskId: 'task-2' },
        path
      ).pipe(Effect.provide(testLayer(createWorktree)))
    )

    expect(result).toMatchObject({ status: 'done', workspaceId: null })
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('serializes concurrent replays and provisions only one workspace', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      id: 'task-concurrent',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Concurrent move',
    })
    database.close()
    const createWorktree = vi.fn(() => Effect.succeed(workspace))
    const layer = testLayer(createWorktree)

    const results = await Promise.all(
      [1, 2].map(() =>
        Effect.runPromise(
          handleTaskMoveAtPath(
            {
              expectedRevision: 1,
              status: 'in_progress',
              taskId: 'task-concurrent',
            },
            path
          ).pipe(Effect.provide(layer))
        )
      )
    )

    expect(
      results.filter(({ workspaceId }) => workspaceId !== null)
    ).toHaveLength(1)
    expect(createWorktree).toHaveBeenCalledTimes(1)
  })

  it('recovers provisioning after a status-only crash boundary', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      id: 'task-replay',
      rootPath: '/repo',
      source: 'manual',
      status: 'in_progress',
      title: 'Replay move',
    })
    database.close()
    const createWorktree = vi.fn(() => Effect.succeed(workspace))

    const result = await Effect.runPromise(
      handleTaskMoveAtPath(
        {
          expectedRevision: 1,
          status: 'in_progress',
          taskId: 'task-replay',
        },
        path
      ).pipe(Effect.provide(testLayer(createWorktree)))
    )

    expect(result.workspaceId).toBe(workspace.id)
    expect(createWorktree).toHaveBeenCalledTimes(1)
  })

  it('adopts a workspace published before task binding was interrupted', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      id: 'task-adopt',
      rootPath: '/repo',
      source: 'manual',
      status: 'in_progress',
      title: 'Adopt workspace',
    })
    database.close()
    const createWorktree = vi.fn(() => Effect.succeed(workspace))

    const result = await Effect.runPromise(
      handleTaskMoveAtPath(
        {
          expectedRevision: 1,
          status: 'in_progress',
          taskId: 'task-adopt',
        },
        path
      ).pipe(
        Effect.provide(
          testLayer(createWorktree, () =>
            Effect.succeed({ ...durableWorkspace, taskSource: 'task-adopt' })
          )
        )
      )
    )

    expect(result.workspaceId).toBe(workspace.id)
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('returns an immediate worktree failure to Todo', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      id: 'task-worktree-failure',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Broken worktree',
    })
    database.close()
    const createWorktree: WorkspaceProvider['Service']['createWorktree'] = () =>
      Effect.fail(
        new RpcError({
          code: 'GIT_WORKTREE_FAILED',
          message: 'git worktree add failed',
        })
      )

    const error = await Effect.runPromise(
      Effect.flip(
        handleTaskMoveAtPath(
          {
            expectedRevision: 1,
            status: 'in_progress',
            taskId: 'task-worktree-failure',
          },
          path
        ).pipe(Effect.provide(testLayer(createWorktree)))
      )
    )
    expect(error).toMatchObject({ code: 'GIT_WORKTREE_FAILED' })

    const failed = NodeTaskBoardDatabase.open(path)
    expect(failed.find('task-worktree-failure')).toMatchObject({
      branchName: null,
      status: 'todo',
      worktreePath: null,
    })
    failed.close()
  })

  it('returns a background provisioning failure to Todo without deleting the workspace', async () => {
    const path = databasePath()
    const database = NodeTaskBoardDatabase.open(path)
    database.insert({
      id: 'task-3',
      rootPath: '/repo',
      source: 'manual',
      status: 'todo',
      title: 'Failing setup',
    })
    database.close()
    let onFailure:
      | ((workspaceId: string, error: RpcError) => Effect.Effect<void, never>)
      | undefined
    const createWorktree: WorkspaceProvider['Service']['createWorktree'] = (
      _projectId,
      _branchName,
      _onReady,
      _baseWorkspaceId,
      failure
    ) => {
      onFailure = failure
      return Effect.succeed(workspace)
    }

    await Effect.runPromise(
      handleTaskMoveAtPath(
        { expectedRevision: 1, status: 'in_progress', taskId: 'task-3' },
        path
      ).pipe(Effect.provide(testLayer(createWorktree)))
    )
    expect(onFailure).toBeDefined()
    await Effect.runPromise(
      onFailure?.(
        workspace.id,
        new RpcError({ code: 'SETUP_SCRIPT_FAILED', message: 'setup failed' })
      ) ?? Effect.void
    )

    const failed = NodeTaskBoardDatabase.open(path)
    const failedTask = failed.find('task-3')
    expect(failedTask).toMatchObject({
      branchName: null,
      status: 'todo',
      worktreePath: null,
    })
    failed.close()

    const retry = await Effect.runPromise(
      handleTaskMoveAtPath(
        {
          expectedRevision: failedTask?.revision ?? -1,
          status: 'in_progress',
          taskId: 'task-3',
        },
        path
      ).pipe(Effect.provide(testLayer(createWorktree)))
    )
    expect(retry.workspaceId).toBe(workspace.id)
    const retried = NodeTaskBoardDatabase.open(path)
    expect(retried.find('task-3')?.worktreePath).toBe(workspace.worktreePath)
    retried.close()
  })

  it('keeps a Slack card in In Progress while it is analyzed, then provisions it', async () => {
    const path = databasePath()
    const analysis = await Effect.runPromise(Deferred.make<void>())
    slackPlanner.plan.mockReturnValue(
      Deferred.await(analysis).pipe(Effect.as(slackPlan))
    )
    const createWorktree = vi.fn(() => Effect.succeed(workspace))

    const created = await Effect.runPromise(
      handleTaskCreateAtPath(
        { rootPath: '/repo', status: 'in_progress', text: SLACK_PERMALINK },
        path
      ).pipe(Effect.provide(testLayer(createWorktree)))
    )

    // The card belongs to the column it was added to from the first render,
    // not once the thread has been read.
    expect(created).toMatchObject({
      source: 'slack_url',
      status: 'in_progress',
      workspaceId: null,
    })
    expect(storedTask(path, created.id)).toMatchObject({
      description: null,
      executionStatus: 'queued',
      status: 'in_progress',
      worktreePath: null,
    })
    expect(createWorktree).not.toHaveBeenCalled()

    await Effect.runPromise(Deferred.succeed(analysis, undefined))
    await waitFor(
      () =>
        Promise.resolve(
          storedTask(path, created.id)?.worktreePath === workspace.worktreePath
        ),
      5000,
      'the analyzed Slack card to be provisioned'
    )

    expect(storedTask(path, created.id)).toMatchObject({
      branchName: workspace.branchName,
      description: slackPlan.initialPrompt,
      executionStatus: null,
      status: 'in_progress',
      title: slackPlan.title,
    })
    expect(createWorktree).toHaveBeenCalledWith(
      project.id,
      slackPlan.branchName,
      expect.any(Function),
      undefined,
      expect.any(Function),
      created.id
    )
  })

  it('marks a Slack card added to In Progress failed when analysis fails', async () => {
    const path = databasePath()
    slackPlanner.plan.mockReturnValue(
      Effect.fail(
        new RpcError({
          code: 'SLACK_ANALYSIS_FAILED',
          message: 'planner unavailable',
        })
      )
    )
    const createWorktree = vi.fn(() => Effect.succeed(workspace))

    const created = await Effect.runPromise(
      handleTaskCreateAtPath(
        { rootPath: '/repo', status: 'in_progress', text: SLACK_PERMALINK },
        path
      ).pipe(Effect.provide(testLayer(createWorktree)))
    )

    await waitFor(
      () =>
        Promise.resolve(
          storedTask(path, created.id)?.executionStatus === 'failed'
        ),
      5000,
      'the failed Slack analysis to be recorded'
    )
    // The card stays where it was added, showing a failure the board can
    // explain, rather than an unprovisioned card that claims to be analyzing.
    expect(storedTask(path, created.id)).toMatchObject({
      description: null,
      status: 'in_progress',
      worktreePath: null,
    })
    expect(createWorktree).not.toHaveBeenCalled()
  })
})
