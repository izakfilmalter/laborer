import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardSearch } from '@/components/kanban/board-search'

afterEach(cleanup)

describe('BoardSearch', () => {
  it('focuses the search input when the board mounts', () => {
    render(<BoardSearch onChange={vi.fn()} value="" />)

    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Search cards' })
    )
  })
})
