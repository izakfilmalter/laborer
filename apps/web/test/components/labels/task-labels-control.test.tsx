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

vi.mock('@/db/shared-mutations', () => ({
  createLabel: vi.fn(),
  setTaskLabels: vi.fn(),
}))

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: () => vi.fn(),
}))

vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: () => ({ data: LABELS }),
}))

vi.mock('@/db/shared-state', () => ({
  labelCollection: Symbol.for('labelCollection'),
  labelsForIds: (ids: readonly string[], labels: readonly TaskLabelOption[]) =>
    ids.flatMap((id) => labels.find((label) => label.id === id) ?? []),
  orderedLabelsFromRows: (labels: readonly TaskLabelOption[]) => labels,
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

const { TaskLabelsControl } = await import(
  '@/components/labels/task-labels-control'
)

afterEach(cleanup)

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
})
