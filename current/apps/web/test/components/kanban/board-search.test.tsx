import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardSearch } from '@/components/kanban/board-search'

afterEach(cleanup)

describe('BoardSearch', () => {
  it('does not steal focus while the board overlay is closed', () => {
    render(<BoardSearch onChange={vi.fn()} open={false} value="" />)

    expect(document.activeElement).not.toBe(
      screen.getByRole('textbox', { name: 'Search cards' })
    )
  })

  it('focuses the search input each time the board overlay opens', () => {
    const { rerender } = render(
      <BoardSearch onChange={vi.fn()} open={false} value="" />
    )

    rerender(<BoardSearch onChange={vi.fn()} open={true} value="" />)

    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Search cards' })
    )

    // Close and reopen: focus lands on the input again even though the
    // component never remounted.
    rerender(<BoardSearch onChange={vi.fn()} open={false} value="" />)
    screen.getByRole('textbox', { name: 'Search cards' }).blur()
    rerender(<BoardSearch onChange={vi.fn()} open={true} value="" />)

    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Search cards' })
    )
  })
})
