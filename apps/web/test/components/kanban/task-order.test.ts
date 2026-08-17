import { describe, expect, it } from 'vitest'

import {
  effectiveSortOrder,
  fractionalOrderAt,
} from '@/components/kanban/task-order'

describe('task ordering', () => {
  it('ranks between neighbors and beyond either edge', () => {
    expect(
      fractionalOrderAt(
        [
          { createdAt: 1, sortOrder: 10 },
          { createdAt: 1, sortOrder: 20 },
        ],
        0
      )
    ).toBe(19)
    expect(
      fractionalOrderAt(
        [
          { createdAt: 1, sortOrder: 10 },
          { createdAt: 1, sortOrder: 15 },
          { createdAt: 1, sortOrder: 20 },
        ],
        1
      )
    ).toBe(15)
    expect(fractionalOrderAt([{ createdAt: 1, sortOrder: 10 }], 0)).toBe(0)
  })

  it('keeps a card dropped between unranked neighbors at its drop slot', () => {
    const column = [
      { createdAt: 4000, id: 'newest', sortOrder: null },
      { createdAt: 3000, id: 'middle', sortOrder: null },
      { createdAt: 2000, id: 'oldest', sortOrder: null },
    ]
    const reordered = [column[0], column[2], column[1]]
    const moved = {
      ...reordered[1],
      sortOrder: fractionalOrderAt(reordered, 1),
    }

    const resorted = [column[0], column[1], moved].sort(
      (left, right) =>
        effectiveSortOrder(left) - effectiveSortOrder(right) ||
        right.createdAt - left.createdAt
    )
    expect(resorted.map(({ id }) => id)).toEqual(['newest', 'oldest', 'middle'])
  })
})
