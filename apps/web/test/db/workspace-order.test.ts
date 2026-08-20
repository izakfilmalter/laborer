import { describe, expect, it } from 'vitest'
import { orderedWorkspaceViews } from '../../src/db/workspace-order'

describe('orderedWorkspaceViews', () => {
  it('presents Workspaces oldest first regardless of arrival order', () => {
    const newest = { createdAt: '30', id: 'newest' }
    const oldest = { createdAt: '10', id: 'oldest' }
    const middle = { createdAt: '20', id: 'middle' }

    expect(
      orderedWorkspaceViews([newest, oldest, middle]).map(({ id }) => id)
    ).toEqual(['oldest', 'middle', 'newest'])
  })

  it('breaks creation ties on the time-ordered Task id', () => {
    const later = { createdAt: '10', id: '01JB' }
    const earlier = { createdAt: '10', id: '01JA' }

    expect(orderedWorkspaceViews([later, earlier]).map(({ id }) => id)).toEqual(
      ['01JA', '01JB']
    )
  })
})
