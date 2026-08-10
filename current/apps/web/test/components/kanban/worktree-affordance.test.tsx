/**
 * Render tests for the bot-card worktree affordances (#379).
 *
 * These cover what only exists in the DOM: each worktree state says itself
 * once, the degraded states stay pressable so the click is the re-check, and
 * the advisory owner marker changes wording without changing what the button
 * can do.
 *
 * @see apps/web/src/components/kanban/worktree-affordance.tsx
 */

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalAttachButton,
  type WorktreeCard,
  WorktreeChip,
} from '@/components/kanban/worktree-affordance'

afterEach(cleanup)

const card = (overrides: Partial<WorktreeCard> = {}): WorktreeCard => ({
  title: 'Fix the board',
  worktreeBotOwned: false,
  worktreePath: '/repo.worktrees/fix-the-board',
  worktreeState: 'exists',
  ...overrides,
})

describe('worktree chip', () => {
  it('names each worktree state once', () => {
    const { rerender } = render(<WorktreeChip card={card()} />)
    expect(screen.getByText('Worktree')).toBeTruthy()

    rerender(<WorktreeChip card={card({ worktreeState: 'provisioning' })} />)
    expect(screen.getByText('Provisioning…')).toBeTruthy()

    rerender(<WorktreeChip card={card({ worktreeState: 'gone' })} />)
    expect(screen.getByText('Worktree gone')).toBeTruthy()
  })

  it('labels a bot-owned worktree without hiding the plain one', () => {
    const { container, rerender } = render(
      <WorktreeChip card={card({ worktreeBotOwned: true })} />
    )
    expect(screen.getByText('Bot worktree')).toBeTruthy()

    rerender(<WorktreeChip card={card({ worktreeBotOwned: false })} />)
    expect(screen.getByText('Worktree')).toBeTruthy()
    expect(container.textContent).not.toContain('Bot')
  })

  it('stays quiet when the card has no worktree at all', () => {
    const { container } = render(
      <WorktreeChip
        card={card({ worktreePath: null, worktreeState: 'none' })}
      />
    )
    expect(container.textContent).toBe('')
  })
})

describe('terminal attach button', () => {
  it('offers a terminal for an existing worktree', () => {
    render(<TerminalAttachButton card={card()} onAttach={vi.fn()} />)
    const button = screen.getByRole('button', {
      name: 'Open terminal in worktree for Fix the board',
    })
    expect(button.textContent).toContain('Terminal')
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('stays pressable while provisioning so the click re-checks', async () => {
    const onAttach = vi.fn()
    render(
      <TerminalAttachButton
        card={card({ worktreeState: 'provisioning' })}
        onAttach={onAttach}
      />
    )
    const button = screen.getByRole('button', {
      name: 'Re-check provisioning worktree for Fix the board',
    })
    expect(button.textContent).toContain('Re-check')

    await userEvent.click(button)
    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it('stays pressable after the worktree is gone', async () => {
    const onAttach = vi.fn()
    render(
      <TerminalAttachButton
        card={card({ worktreeState: 'gone' })}
        onAttach={onAttach}
      />
    )
    const button = screen.getByRole('button', {
      name: 'Re-check missing worktree for Fix the board',
    })

    await userEvent.click(button)
    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when the task has no worktree path', () => {
    const { container } = render(
      <TerminalAttachButton
        card={card({ worktreePath: null, worktreeState: 'none' })}
        onAttach={vi.fn()}
      />
    )
    expect(container.querySelector('button')).toBeNull()
  })

  it('announces the in-flight attach and refuses a second press', async () => {
    const onAttach = vi.fn()
    render(<TerminalAttachButton busy card={card()} onAttach={onAttach} />)
    const button = screen.getByRole('button', {
      name: 'Open terminal in worktree for Fix the board',
    })
    expect(button.getAttribute('aria-busy')).toBe('true')

    await userEvent.click(button)
    expect(onAttach).not.toHaveBeenCalled()
  })

  it('marks the card whose terminal is already showing and toggles back', async () => {
    const onAttach = vi.fn()
    render(
      <TerminalAttachButton
        attached
        card={card()}
        id="terminal-attach-task-1"
        onAttach={onAttach}
      />
    )
    const button = screen.getByRole('button', {
      name: 'Terminal attached for Fix the board',
    })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.id).toBe('terminal-attach-task-1')

    // The pressed state promises a toggle, so the press must still be handled.
    await userEvent.click(button)
    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it('keeps the terminal available when the owner marker is missing', () => {
    render(
      <TerminalAttachButton
        card={card({ worktreeBotOwned: false })}
        onAttach={vi.fn()}
      />
    )
    const button = screen.getByRole('button', {
      name: 'Open terminal in worktree for Fix the board',
    })
    expect(button.hasAttribute('disabled')).toBe(false)
  })
})
