import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddCardComposer } from '@/components/kanban/task-board'

const { createTask, openProvisionedAgent } = vi.hoisted(() => ({
  createTask: vi.fn(),
  openProvisionedAgent: vi.fn(),
}))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) =>
    atom === 'task.create' ? createTask : vi.fn(),
  useAtomValue: vi.fn(),
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: (name: string) => name,
  },
}))

vi.mock('@/components/kanban/provisioned-agent', () => ({
  openProvisionedAgent,
}))

vi.mock('@/panels/panel-context', () => ({
  usePanelActions: () => null,
}))

vi.mock('@/panes/terminal-pane', () => ({
  TerminalPane: () => null,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('add card composer', () => {
  it('creates a card immediately when a Slack message URL is pasted', async () => {
    const slackUrl = 'https://acme.slack.com/archives/C123/p1700000000000000'
    createTask.mockResolvedValue({
      source: 'slack_url',
      workspaceId: null,
    })
    const user = userEvent.setup()

    render(
      <AddCardComposer
        column={{
          dotClassName: 'bg-muted',
          id: 'in_progress',
          title: 'In Progress',
        }}
        composerId="test-composer"
        onClose={vi.fn()}
        projectId="project-1"
        projectRootPath="/repo"
      />
    )

    await user.click(
      screen.getByRole('textbox', {
        name: 'Card title or Slack message link for In Progress',
      })
    )
    await user.paste(slackUrl)

    await waitFor(() => {
      expect(createTask).toHaveBeenCalledWith({
        payload: {
          // The composer mints the card's ULID so its optimistic row and the
          // stored row share one identity.
          id: expect.stringMatching(ULID_PATTERN),
          projectId: 'project-1',
          status: 'in_progress',
          text: slackUrl,
        },
      })
    })
  })

  it('queues the deferred agent open for a Slack card created in In Progress', async () => {
    const slackUrl = 'https://acme.slack.com/archives/C123/p1700000000000000'
    createTask.mockResolvedValue({
      id: 'task-1',
      source: 'slack_url',
      workspaceId: null,
    })
    const onSlackCardQueued = vi.fn()
    const user = userEvent.setup()

    render(
      <AddCardComposer
        column={{
          dotClassName: 'bg-muted',
          id: 'in_progress',
          title: 'In Progress',
        }}
        composerId="test-composer"
        onClose={vi.fn()}
        onSlackCardQueued={onSlackCardQueued}
        projectId="project-1"
        projectRootPath="/repo"
      />
    )

    await user.click(
      screen.getByRole('textbox', {
        name: 'Card title or Slack message link for In Progress',
      })
    )
    await user.paste(slackUrl)

    await waitFor(() => {
      expect(onSlackCardQueued).toHaveBeenCalledWith('task-1')
    })
  })

  it('does not queue a deferred agent open outside In Progress', async () => {
    const slackUrl = 'https://acme.slack.com/archives/C123/p1700000000000000'
    createTask.mockResolvedValue({
      id: 'task-1',
      source: 'slack_url',
      workspaceId: null,
    })
    const onSlackCardQueued = vi.fn()
    const user = userEvent.setup()

    render(
      <AddCardComposer
        column={{ dotClassName: 'bg-muted', id: 'todo', title: 'Todo' }}
        composerId="test-composer"
        onClose={vi.fn()}
        onSlackCardQueued={onSlackCardQueued}
        projectId="project-1"
        projectRootPath="/repo"
      />
    )

    await user.click(
      screen.getByRole('textbox', {
        name: 'Card title or Slack message link for Todo',
      })
    )
    await user.paste(slackUrl)

    await waitFor(() => {
      expect(createTask).toHaveBeenCalled()
    })
    expect(onSlackCardQueued).not.toHaveBeenCalled()
  })

  it('does not immediately create a card for other pasted text', async () => {
    const user = userEvent.setup()

    render(
      <AddCardComposer
        column={{ dotClassName: 'bg-muted', id: 'todo', title: 'Todo' }}
        composerId="test-composer"
        onClose={vi.fn()}
        projectId="project-1"
        projectRootPath="/repo"
      />
    )

    const input = screen.getByRole('textbox', {
      name: 'Card title or Slack message link for Todo',
    })
    await user.click(input)
    await user.paste('Write release notes')

    expect(createTask).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe('Write release notes')
  })
})
