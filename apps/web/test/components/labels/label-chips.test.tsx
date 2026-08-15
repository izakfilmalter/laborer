import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type TaskLabelOption,
  TaskLabelsBadge,
  TaskLabelsPillTrigger,
} from '@/components/labels/label-chips'
import { labelDotClassName } from '@/components/labels/label-colors'

afterEach(cleanup)

const TAILWIND_BACKGROUND = /^bg-/

const label = (name: string, color = 'blue'): TaskLabelOption => ({
  color,
  id: `label-${name}`,
  name,
})

describe('label chips', () => {
  it('names one or two labels, and counts the rest', () => {
    const { rerender } = render(
      <TaskLabelsBadge labels={[label('Worship'), label('Kids')]} />
    )

    expect(screen.getByText('Worship')).toBeTruthy()
    expect(screen.getByText('Kids')).toBeTruthy()

    rerender(
      <TaskLabelsBadge
        labels={[label('Worship'), label('Kids'), label('Admin')]}
      />
    )

    expect(screen.queryByText('Worship')).toBeNull()
    expect(screen.getByText('3 labels')).toBeTruthy()
  })

  it('stays out of the way of a card that carries no labels', () => {
    const { container } = render(<TaskLabelsBadge labels={[]} />)

    expect(container.firstChild).toBeNull()
  })

  it('offers the empty trigger as the way to add labels', () => {
    render(<TaskLabelsPillTrigger labels={[]} />)

    expect(screen.getByText('Labels')).toBeTruthy()
  })

  it('falls back to a name-derived color for a token this build cannot read', () => {
    expect(labelDotClassName({ color: 'chartreuse', name: 'Worship' })).toMatch(
      TAILWIND_BACKGROUND
    )
    // The fallback is deterministic, so the same label keeps its color.
    expect(labelDotClassName({ color: 'chartreuse', name: 'Worship' })).toBe(
      labelDotClassName({ color: 'not-a-color', name: 'Worship' })
    )
  })
})
