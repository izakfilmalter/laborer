import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CreateWorkspaceButton,
  CreateWorkspaceComposer,
} from '@/components/create-workspace-composer'

const { createWorkspace, planSlackWorkspace, toastError } = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  planSlackWorkspace: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => {
    if (atom === 'workspace.create') {
      return createWorkspace
    }
    if (atom === 'workspace.planFromSlack') {
      return planSlackWorkspace
    }
    return vi.fn()
  },
  useAtomValue: vi.fn(),
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: { mutation: (name: string) => name },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn() },
}))

vi.mock('@/panels/panel-context', () => ({
  usePanelActions: () => null,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const SLACK_URL = 'https://acme.slack.com/archives/C123/p1700000000000000'

const renderComposer = (props?: {
  readonly onClose?: (reason: 'blur' | 'cancel') => void
  readonly onPendingCreationChange?: (change: unknown) => void
}) => {
  render(
    <CreateWorkspaceComposer
      composerId="test-composer"
      onClose={props?.onClose ?? vi.fn()}
      onPendingCreationChange={props?.onPendingCreationChange}
      projectId="project-1"
      projectName="laborer"
    />
  )
  return screen.getByRole('textbox', {
    name: 'Branch name or Slack URL for laborer',
  }) as HTMLInputElement
}

describe('create workspace button', () => {
  it('announces the composer it controls only while it is open', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()

    const { rerender } = render(
      <CreateWorkspaceButton
        composerId="test-composer"
        id="test-add"
        onToggle={onToggle}
        open={false}
        projectName="laborer"
      />
    )

    const button = screen.getByRole('button', {
      name: 'Create workspace in laborer',
    })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-controls')).toBeNull()

    await user.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(
      <CreateWorkspaceButton
        composerId="test-composer"
        id="test-add"
        onToggle={onToggle}
        open={true}
        projectName="laborer"
      />
    )
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe('test-composer')
  })
})

describe('create workspace composer', () => {
  it('autofocuses so a branch name can be typed straight away', () => {
    const input = renderComposer()
    expect(document.activeElement).toBe(input)
  })

  it('creates the masked branch name on Enter and stays open for the next one', async () => {
    createWorkspace.mockResolvedValue({
      branchName: 'my-feature',
      id: 'ws-1',
      projectId: 'project-1',
      status: 'creating',
      worktreePath: '/repo/.worktrees/my-feature',
    })
    const user = userEvent.setup()
    const input = renderComposer()

    await user.type(input, 'My Feature')
    await waitFor(() => {
      expect(input.value).toBe('my-feature')
    })
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith({
        payload: { branchName: 'my-feature', projectId: 'project-1' },
      })
    })
    // The composer clears itself but stays put, like the board's card composer.
    expect(input.value).toBe('')
    expect(screen.getByRole('textbox')).toBe(input)
  })

  it('lets an empty commit auto-name the branch', async () => {
    createWorkspace.mockResolvedValue({
      branchName: 'auto-generated',
      id: 'ws-1',
      projectId: 'project-1',
      status: 'creating',
      worktreePath: '/repo/.worktrees/auto-generated',
    })
    const user = userEvent.setup()
    renderComposer()

    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith({
        payload: { projectId: 'project-1' },
      })
    })
  })

  it('creates immediately when a Slack message URL is pasted', async () => {
    planSlackWorkspace.mockResolvedValue({
      branchName: 'slack/fix-auth-timeout',
      initialPrompt: 'Fix it.',
      workType: 'bug',
    })
    createWorkspace.mockResolvedValue({
      branchName: 'slack/fix-auth-timeout',
      id: 'ws-slack',
      projectId: 'project-1',
      status: 'creating',
      worktreePath: '/repo/.worktrees/slack',
    })
    const user = userEvent.setup()
    const input = renderComposer()

    await user.click(input)
    await user.paste(SLACK_URL)

    await waitFor(() => {
      expect(planSlackWorkspace).toHaveBeenCalledWith({
        payload: { slackUrl: SLACK_URL },
      })
    })
    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith({
        payload: {
          branchName: 'slack/fix-auth-timeout',
          projectId: 'project-1',
        },
      })
    })
  })

  it('does not create anything when other text is pasted', async () => {
    const user = userEvent.setup()
    const input = renderComposer()

    await user.click(input)
    await user.paste('my-feature')

    await waitFor(() => {
      expect(input.value).toBe('my-feature')
    })
    expect(createWorkspace).not.toHaveBeenCalled()
  })

  it('reports the pending sidebar item while creation runs', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined
    createWorkspace.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    )
    const onPendingCreationChange = vi.fn()
    const user = userEvent.setup()
    const input = renderComposer({ onPendingCreationChange })

    await user.type(input, 'my-feature')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(onPendingCreationChange).toHaveBeenCalledWith({
        creation: {
          branchName: 'my-feature',
          id: expect.any(String),
          phase: 'creating',
        },
        id: expect.any(String),
      })
    })

    resolveCreate?.({
      branchName: 'my-feature',
      id: 'ws-1',
      projectId: 'project-1',
      status: 'creating',
      worktreePath: '/repo/.worktrees/my-feature',
    })

    await waitFor(() => {
      expect(onPendingCreationChange).toHaveBeenLastCalledWith({
        creation: null,
        id: expect.any(String),
      })
    })
  })

  it('restores the rejected branch name inline when creation fails', async () => {
    createWorkspace.mockRejectedValue(new Error('Branch already exists'))
    const user = userEvent.setup()
    const input = renderComposer()

    await user.type(input, 'my-feature')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.getByText('Branch already exists')).toBeTruthy()
    })
    expect(input.value).toBe('my-feature')
    // The failure belongs to the open composer, not a toast behind it.
    expect(toastError).not.toHaveBeenCalled()
  })

  it('cancels on Escape and closes an abandoned empty composer on blur', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    const input = renderComposer({ onClose })

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledWith('cancel')

    input.blur()
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith('blur')
    })
  })

  it('keeps a composer with typed text open on blur', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    const input = renderComposer({ onClose })

    await user.type(input, 'my-feature')
    input.blur()

    await waitFor(() => {
      expect(input.value).toBe('my-feature')
    })
    expect(onClose).not.toHaveBeenCalled()
  })
})
