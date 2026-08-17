/** PROTOTYPE — executable evidence for issue #548. */
import { Stream } from 'effect'
import { makePrototypeCollections } from './shared-state-sync-adapter.prototype'

const label = (id: string, name = id) => ({
  color: 'blue' as const,
  createdAt: 1,
  id,
  name,
  revision: 1,
  updatedAt: 1,
})

const project = (rootPath: string) => ({
  branchName: 'main',
  canonicalGitCommonDir: '/repo/.git',
  createdAt: 1,
  id: 'project-1',
  name: 'Project',
  repoId: 'repo-1',
  revision: 1,
  rootPath,
  sortOrder: null,
  updatedAt: 1,
})

const task = (rootPath: string, labelIds = ['label-1']) => ({
  actionName: null,
  baseBranch: null,
  baseSha: null,
  branchName: 'prototype',
  createdAt: 1,
  description: null,
  executionId: null,
  executionStatus: null,
  id: 'task-1',
  labelIds,
  parentTaskId: null,
  prBaseBranch: null,
  prCheckStatus: null,
  prChecks: null,
  prIsDraft: false,
  prMergeStatus: null,
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  revision: 1,
  rootPath,
  setupCompletedAt: null,
  slackPermalink: null,
  sortOrder: null,
  source: 'manual' as const,
  status: 'todo' as const,
  taskNumber: 1,
  title: 'Prototype',
  updatedAt: 1,
  worktreeBotOwned: false,
  worktreeError: null,
  worktreeExists: false,
  worktreePath: null,
  worktreeStatus: null,
})

const setting = (value: string) => ({
  createdAt: 1,
  key: 'setting-1',
  revision: 1,
  updatedAt: 1,
  value,
})

const events: unknown[] = [
  {
    labels: {
      cursor: 8,
      rows: [label('obsolete'), label('label-1')],
      type: 'snapshot',
    },
    projects: { cursor: 8, rows: [project('/repo')], type: 'snapshot' },
    settings: { cursor: 8, rows: [setting('old')], type: 'snapshot' },
    tasks: { cursor: 20, rows: [task('/repo')], type: 'snapshot' },
  },
  {
    labels: { cursor: 9, deletedRowIds: ['label-1'], rows: [], type: 'delta' },
    tasks: {
      cursor: 21,
      deletedRowIds: [],
      rows: [task('/repo', [])],
      type: 'delta',
    },
  },
  // Independently advancing state cursor; task cursor stays at 21.
  {
    settings: {
      cursor: 10,
      deletedRowIds: [],
      rows: [setting('new')],
      type: 'delta',
    },
  },
  // Duplicate/stale task delta must not resurrect its old labels.
  {
    tasks: {
      cursor: 21,
      deletedRowIds: [],
      rows: [task('/repo', ['obsolete'])],
      type: 'delta',
    },
  },
  // Reconnect snapshot is authoritative even though all cursors regress.
  {
    labels: { cursor: 2, rows: [label('label-2')], type: 'snapshot' },
    projects: { cursor: 2, rows: [project('/replacement')], type: 'snapshot' },
    settings: { cursor: 2, rows: [], type: 'snapshot' },
    tasks: {
      cursor: 3,
      rows: [task('/replacement', ['label-2'])],
      type: 'snapshot',
    },
  },
  // Deletes and upserts share one collection-local transaction.
  {
    labels: {
      cursor: 3,
      deletedRowIds: ['label-2'],
      rows: [label('label-3')],
      type: 'delta',
    },
    tasks: { cursor: 4, deletedRowIds: ['task-1'], rows: [], type: 'delta' },
  },
]

const main = async () => {
  const collections = makePrototypeCollections(() =>
    Stream.fromIterable(events).pipe(Stream.concat(Stream.never))
  )
  const consistencyObservations: Array<{
    after: string
    danglingTaskLabelIds: string[]
  }> = []
  collections.coordinator.observeCommit = (after) => {
    const labelIds = new Set(
      [...collections.labels.values()].map(({ id }) => id)
    )
    const danglingTaskLabelIds = [...collections.tasks.values()].flatMap(
      ({ labelIds: ids }) => ids.filter((id) => !labelIds.has(id))
    )
    consistencyObservations.push({ after, danglingTaskLabelIds })
  }

  await collections.preload()
  // Let the finite prefix drain before printing the stable frame.
  await new Promise((resolve) => setTimeout(resolve, 0))

  console.log(
    '\nPROTOTYPE — shared RPC stream → four TanStack DB collections\n'
  )
  console.log(
    JSON.stringify(
      {
        cleanup: {
          starts: collections.coordinator.subscriptionStarts,
          stopsBeforeCleanup: collections.coordinator.subscriptionStops,
        },
        commits: collections.coordinator.commits,
        consistencyObservations,
        cursors: collections.coordinator.cursors,
        rejectedStaleDeltas: collections.coordinator.rejections,
        rows: {
          labels: [...collections.labels.values()],
          projects: [...collections.projects.values()],
          settings: [...collections.settings.values()],
          tasks: [...collections.tasks.values()],
        },
        statuses: {
          labels: collections.labels.status,
          projects: collections.projects.status,
          settings: collections.settings.status,
          tasks: collections.tasks.status,
        },
      },
      null,
      2
    )
  )

  await collections.cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  console.log(
    `\nsubscription stops after collection cleanup: ${String(collections.coordinator.subscriptionStops)}`
  )
}

await main()
