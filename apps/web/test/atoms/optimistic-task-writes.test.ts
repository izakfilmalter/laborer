import type { SharedTaskRow } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  applyTaskEditOverlays,
  applyTaskLabelOverlays,
  mergePendingTaskRows,
  pendingTaskRow,
  settleTaskCreateOverlays,
  settleTaskEditOverlays,
  settleTaskLabelOverlays,
  type TaskEditOverlay,
  type TaskLabelOverlay,
} from '../../src/atoms/optimistic-task-writes'

const task = (id: string, revision = 1): SharedTaskRow => ({
  actionName: null,
  baseBranch: null,
  baseSha: null,
  branchName: null,
  createdAt: 1,
  description: null,
  executionId: null,
  executionStatus: null,
  id,
  labelIds: [],
  parentTaskId: null,
  prIsDraft: false,
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  revision,
  rootPath: '/repo',
  setupCompletedAt: null,
  slackPermalink: null,
  sortOrder: null,
  source: 'manual',
  status: 'todo',
  title: id,
  updatedAt: revision,
  worktreeBotOwned: false,
  worktreeError: null,
  worktreeExists: false,
  worktreePath: null,
  worktreeStatus: null,
})

describe('pendingTaskRow', () => {
  it('synthesizes the manual card the server will store', () => {
    const row = pendingTaskRow({
      id: 'PENDING',
      now: 42,
      rootPath: '/repo',
      status: 'todo',
      text: '  Fix the flaky test  ',
    })

    expect(row).toMatchObject({
      createdAt: 42,
      executionStatus: null,
      id: 'PENDING',
      revision: 1,
      rootPath: '/repo',
      slackPermalink: null,
      sortOrder: null,
      source: 'manual',
      status: 'todo',
      title: 'Fix the flaky test',
      updatedAt: 42,
      worktreePath: null,
    })
  })

  it('mirrors the server for a Slack permalink: placeholder title and queued analysis', () => {
    const url = 'https://acme.slack.com/archives/C0123456789/p1712345678901234'
    const row = pendingTaskRow({
      id: 'PENDING',
      now: 42,
      rootPath: '/repo',
      status: 'in_progress',
      text: ` ${url} `,
    })

    expect(row.source).toBe('slack_url')
    expect(row.executionStatus).toBe('queued')
    // Normalized exactly like the server (`new URL(text).toString()`), so the
    // optimistic card renders the same thread label the stored card will.
    expect(row.slackPermalink).toBe(new URL(url).toString())
    expect(row.title).toBe(new URL(url).toString())
  })
})

describe('mergePendingTaskRows', () => {
  it('appends pending cards the stream has not stored yet', () => {
    const pending = new Map([['new', task('new')]])

    expect(
      mergePendingTaskRows([task('stored')], pending).map(({ id }) => id)
    ).toEqual(['stored', 'new'])
  })

  it('never duplicates a card once the authoritative row lands', () => {
    const pending = new Map([['stored', { ...task('stored'), title: 'mine' }]])
    const authoritative = [{ ...task('stored'), title: 'theirs' }]

    const merged = mergePendingTaskRows(authoritative, pending)
    expect(merged).toHaveLength(1)
    // The authoritative row wins over the synthesized copy.
    expect(merged[0]?.title).toBe('theirs')
  })

  it('returns the identical array when nothing is pending', () => {
    const rows = [task('stored')]
    expect(mergePendingTaskRows(rows, new Map())).toBe(rows)
  })
})

describe('settleTaskCreateOverlays', () => {
  it('keeps the overlay until the authoritative table stores the id', () => {
    const pending: ReadonlyMap<string, SharedTaskRow> = new Map([
      ['new', task('new')],
    ])

    expect(settleTaskCreateOverlays(pending, [task('other')])).toBe(pending)
  })

  it('settles the moment the id is stored', () => {
    const pending: ReadonlyMap<string, SharedTaskRow> = new Map([
      ['new', task('new')],
    ])

    expect(settleTaskCreateOverlays(pending, [task('new')]).size).toBe(0)
  })

  it('settles each pending card independently', () => {
    const pending: ReadonlyMap<string, SharedTaskRow> = new Map([
      ['stored', task('stored')],
      ['waiting', task('waiting')],
    ])

    expect([
      ...settleTaskCreateOverlays(pending, [task('stored')]).keys(),
    ]).toEqual(['waiting'])
  })
})

describe('applyTaskEditOverlays', () => {
  it('patches the edited fields over the authoritative row', () => {
    const overlays = new Map<string, TaskEditOverlay>([
      [
        'card',
        {
          expectedRevision: 1,
          patch: { description: 'brief', title: 'renamed' },
        },
      ],
    ])

    const [row] = applyTaskEditOverlays([task('card')], overlays)
    expect(row).toMatchObject({ description: 'brief', title: 'renamed' })
  })

  it('returns the identical array when no edits are in flight', () => {
    const rows = [task('card')]
    expect(applyTaskEditOverlays(rows, new Map())).toBe(rows)
  })
})

describe('settleTaskEditOverlays', () => {
  const overlay: TaskEditOverlay = {
    expectedRevision: 3,
    patch: { description: null, title: 'renamed' },
  }

  it('keeps the overlay while the row sits at the draft revision', () => {
    const overlays: ReadonlyMap<string, TaskEditOverlay> = new Map([
      ['card', overlay],
    ])

    expect(settleTaskEditOverlays(overlays, [task('card', 3)])).toBe(overlays)
  })

  it('settles once the row advances — our save landed', () => {
    const overlays: ReadonlyMap<string, TaskEditOverlay> = new Map([
      ['card', overlay],
    ])

    expect(settleTaskEditOverlays(overlays, [task('card', 4)]).size).toBe(0)
  })

  it('settles when a rival write advances the row, so the winner shows', () => {
    const overlays: ReadonlyMap<string, TaskEditOverlay> = new Map([
      ['card', overlay],
    ])

    // The rejected RPC restores the draft through the recovery dialog; the
    // board must meanwhile show the version that actually won.
    expect(settleTaskEditOverlays(overlays, [task('card', 5)]).size).toBe(0)
  })

  it('settles when the row is deleted outright', () => {
    const overlays: ReadonlyMap<string, TaskEditOverlay> = new Map([
      ['card', overlay],
    ])

    expect(settleTaskEditOverlays(overlays, []).size).toBe(0)
  })
})

describe('task label overlays', () => {
  const overlay = (
    expectedRevision: number,
    labelIds: readonly string[]
  ): TaskLabelOverlay => ({ expectedRevision, labelIds })

  it('shows the selection the picker just made', () => {
    const rows = applyTaskLabelOverlays(
      [task('one')],
      new Map([['one', overlay(1, ['label-a'])]])
    )

    expect(rows[0]?.labelIds).toEqual(['label-a'])
  })

  it('leaves rows alone when nothing is in flight', () => {
    const rows = [task('one')]

    expect(applyTaskLabelOverlays(rows, new Map())).toBe(rows)
  })

  it('settles once the authoritative row leaves the revision it was based on', () => {
    const overlays = new Map([['one', overlay(1, ['label-a'])]])

    expect(settleTaskLabelOverlays(overlays, [task('one', 1)])).toBe(overlays)
    expect(settleTaskLabelOverlays(overlays, [task('one', 2)]).size).toBe(0)
  })

  it('settles a rejected write, so a lost CAS stops hiding the stored labels', () => {
    // The row never moved, but its task is gone from the table entirely.
    expect(
      settleTaskLabelOverlays(new Map([['one', overlay(1, ['a'])]]), []).size
    ).toBe(0)
  })
})
