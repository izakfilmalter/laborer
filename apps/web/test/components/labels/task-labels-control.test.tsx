/**
 * Labels are app-wide, not per project.
 *
 * The control used to resolve a project root for the task and offer only the
 * labels defined against it. Nothing scopes the option list now, so the tests
 * below pin the opposite: the same label reaches a task in any project.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TaskLabelOption } from '@/components/labels/label-chips'

const LABELS: readonly TaskLabelOption[] = [
  { color: 'blue', id: 'label-admin', name: 'Admin' },
  { color: 'emerald', id: 'label-worship', name: 'Worship' },
]

// Sentinels stand in for the atoms so the stubbed `useAtomValue` can tell the
// option list apart from the by-id map.
vi.mock('@/atoms/shared-state', () => ({
  clearTaskLabelOverlayAtom: 'clear-overlay',
  installTaskLabelOverlayAtom: 'install-overlay',
  labelRowsAtom: 'label-rows',
  labelsByIdAtom: 'labels-by-id',
}))

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: () => vi.fn(),
  useAtomValue: (atom: unknown) =>
    atom === 'label-rows'
      ? LABELS
      : new Map(LABELS.map((label) => [label.id, label])),
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: { mutation: (name: string) => name },
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

// The picker's popup is Base UI's; what matters here is which options the
// control hands it, so the stub renders them where a query can see them.
vi.mock('@/components/labels/labels-picker', () => ({
  LabelsPicker: ({ options }: { options: readonly TaskLabelOption[] }) => (
    <ul>
      {options.map((option) => (
        <li key={option.id}>{option.name}</li>
      ))}
    </ul>
  ),
}))

const { TaskLabelsControl, resolveTaskLabels } = await import(
  '@/components/labels/task-labels-control'
)

afterEach(cleanup)

const label = (id: string): TaskLabelOption => ({ color: 'blue', id, name: id })

describe('label options', () => {
  it('offers every label to a task, whichever project the task belongs to', () => {
    // Two tasks that would previously have landed in different label scopes.
    const { rerender } = render(
      <TaskLabelsControl
        task={{ id: 'task-in-repo-a', labelIds: [], revision: 1 }}
      />
    )

    expect(screen.getByText('Admin')).toBeTruthy()
    expect(screen.getByText('Worship')).toBeTruthy()

    rerender(
      <TaskLabelsControl
        task={{ id: 'task-in-repo-b', labelIds: [], revision: 1 }}
      />
    )

    expect(screen.getByText('Admin')).toBeTruthy()
    expect(screen.getByText('Worship')).toBeTruthy()
  })

  it('applies one label to tasks in two different projects', () => {
    // The same label id is carried by both cards, and both resolve it — a
    // label crosses projects rather than belonging to one.
    const byId = new Map(LABELS.map((option) => [option.id, option]))

    expect(resolveTaskLabels(['label-admin'], byId)).toEqual([
      { color: 'blue', id: 'label-admin', name: 'Admin' },
    ])
    expect(
      resolveTaskLabels(['label-admin', 'label-worship'], byId)
    ).toHaveLength(2)
  })
})

describe('resolving a task’s labels', () => {
  it('keeps application order', () => {
    const byId = new Map([
      ['b', label('b')],
      ['a', label('a')],
    ])

    expect(resolveTaskLabels(['b', 'a'], byId).map(({ id }) => id)).toEqual([
      'b',
      'a',
    ])
  })

  it('drops ids no label answers, so a deleted label cannot render', () => {
    expect(
      resolveTaskLabels(['a', 'gone'], new Map([['a', label('a')]]))
    ).toEqual([label('a')])
  })
})
