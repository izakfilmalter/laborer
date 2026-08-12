import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { cloneElement, isValidElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardTask } from '@/components/kanban/board-data'
import { TaskBoardCard, TaskDetailDialog } from '@/components/kanban/task-board'

const { toastError, updateTask } = vi.hoisted(() => ({
  toastError: vi.fn(),
  updateTask: vi.fn(),
}))

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) =>
    atom === 'task.update' ? updateTask : vi.fn(),
  useAtomValue: vi.fn(),
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: (name: string) => name,
  },
}))

vi.mock('sonner', () => ({
  toast: { error: toastError, info: vi.fn() },
}))

// Stub tooltip — the real trigger merges its children into `render`, so the
// stub has to as well or every chip loses its label.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode
    render?: React.ReactElement
  }) =>
    render && isValidElement(render)
      ? cloneElement(render, render.props as Record<string, unknown>, children)
      : children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}))

vi.mock('@/components/github-pr-status-badge', () => ({
  GitHubPrStatusBadge: () => null,
}))

vi.mock('@/components/kanban/worktree-affordance', () => ({
  TerminalAttachButton: () => null,
  WorktreeChip: () => null,
}))

vi.mock('@/panes/terminal-pane', () => ({
  TerminalPane: () => null,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  actionName: null,
  branch: null,
  branchName: null,
  createdAt: 1,
  description: 'Run the focused tests.',
  executionId: null,
  executionMirror: null,
  executionStatus: null,
  id: 'task-1',
  pr: null,
  revision: 4,
  rootPath: '/repo',
  slackPermalink: null,
  source: 'agent',
  status: 'todo',
  title: 'Improve task details',
  updatedAt: 2,
  worktreeBotOwned: false,
  worktreeExists: false,
  worktreePath: null,
  worktreeState: 'none',
  ...overrides,
})

describe('task card details', () => {
  it('makes agent-authored and described cards distinct', () => {
    render(<TaskBoardCard onOpen={vi.fn()} task={task()} />)

    expect(screen.getByText('Agent staged')).toBeTruthy()
    expect(screen.getByText('Has description')).toBeTruthy()
  })

  it('sends the card body to the work and leaves editing to its own button', async () => {
    const onActivate = vi.fn()
    const onOpen = vi.fn()
    render(
      <TaskBoardCard onActivate={onActivate} onOpen={onOpen} task={task()} />
    )

    await userEvent.click(screen.getByText('Improve task details'))
    expect(onActivate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' })
    )
    expect(onOpen).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Improve task details' })
    )
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' })
    )
  })

  it('says the body leads to the card while no workspace exists', () => {
    render(<TaskBoardCard onActivate={vi.fn()} task={task()} />)

    expect(
      screen.getByRole('button', {
        name: 'Card details for Improve task details',
      })
    ).toBeTruthy()
  })

  it('edits and saves title and plain-text description with the card revision', async () => {
    updateTask.mockResolvedValue({})
    const onOpenChange = vi.fn()
    render(<TaskDetailDialog onOpenChange={onOpenChange} task={task()} />)

    expect(screen.getByText('Agent staged')).toBeTruthy()
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
      'Improve task details'
    )
    expect(
      (screen.getByLabelText('Description') as HTMLTextAreaElement).value
    ).toBe('Run the focused tests.')

    await userEvent.clear(screen.getByLabelText('Title'))
    await userEvent.type(screen.getByLabelText('Title'), 'Polish task details')
    await userEvent.clear(screen.getByLabelText('Description'))
    await userEvent.type(
      screen.getByLabelText('Description'),
      'Keep this plain.'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(updateTask).toHaveBeenCalledWith({
      payload: {
        description: 'Keep this plain.',
        expectedRevision: 4,
        taskId: 'task-1',
        title: 'Polish task details',
      },
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the dialog open and explains a revision conflict', async () => {
    updateTask
      .mockRejectedValueOnce({
        code: 'CAS_CONFLICT',
        message: 'stale revision for task task-1',
      })
      .mockResolvedValueOnce({})
    const onOpenChange = vi.fn()
    const view = render(
      <TaskDetailDialog onOpenChange={onOpenChange} task={task()} />
    )

    await userEvent.type(screen.getByLabelText('Description'), ' More.')
    view.rerender(
      <TaskDetailDialog
        onOpenChange={onOpenChange}
        task={task({ description: 'Winning edit.', revision: 5 })}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'This card changed elsewhere'
    )
    expect(updateTask).toHaveBeenLastCalledWith({
      payload: expect.objectContaining({ expectedRevision: 4 }),
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(
      'Card changed elsewhere',
      expect.any(Object)
    )

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(updateTask).toHaveBeenLastCalledWith({
      payload: expect.objectContaining({ expectedRevision: 5 }),
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('asks before dropping unsaved edits and can go back to editing', async () => {
    const onOpenChange = vi.fn()
    render(<TaskDetailDialog onOpenChange={onOpenChange} task={task()} />)

    await userEvent.type(screen.getByLabelText('Description'), ' And more.')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByText('Discard your unsaved edits?')).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(
      (screen.getByLabelText('Description') as HTMLTextAreaElement).value
    ).toBe('Run the focused tests. And more.')

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes straight away when nothing was edited', async () => {
    const onOpenChange = vi.fn()
    render(<TaskDetailDialog onOpenChange={onOpenChange} task={task()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps a draft when the card changes elsewhere, and adopts the change when there is none', async () => {
    const { rerender } = render(
      <TaskDetailDialog onOpenChange={vi.fn()} task={task()} />
    )

    await userEvent.type(screen.getByLabelText('Description'), ' Twice.')
    rerender(
      <TaskDetailDialog
        onOpenChange={vi.fn()}
        task={task({ description: 'Rewritten by someone else.', revision: 5 })}
      />
    )

    expect(
      (screen.getByLabelText('Description') as HTMLTextAreaElement).value
    ).toBe('Run the focused tests. Twice.')
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This card changed elsewhere'
    )

    cleanup()
    const untouched = render(
      <TaskDetailDialog onOpenChange={vi.fn()} task={task()} />
    )
    untouched.rerender(
      <TaskDetailDialog
        onOpenChange={vi.fn()}
        task={task({ description: 'Rewritten by someone else.', revision: 5 })}
      />
    )

    expect(
      (screen.getByLabelText('Description') as HTMLTextAreaElement).value
    ).toBe('Rewritten by someone else.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers a name instead of a raw permalink for an unnamed Slack card', () => {
    render(
      <TaskDetailDialog
        onOpenChange={vi.fn()}
        task={task({
          description: null,
          slackPermalink: 'https://acme.slack.com/archives/C123/p1700000000',
          source: 'slack_url',
          title: 'https://acme.slack.com/archives/C123/p1700000000',
        })}
      />
    )

    const titleField = screen.getByLabelText('Title') as HTMLInputElement
    expect(titleField.value).toBe('')
    expect(titleField.placeholder).toContain('Slack thread')
  })
})
