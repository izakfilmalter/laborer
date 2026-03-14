import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createWorkspaceFn, mutationMap } = vi.hoisted(() => ({
  createWorkspaceFn: vi.fn(),
  mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
}))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => {
    return mutationMap.get(atom) ?? vi.fn()
  },
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: (name: string) => {
      const sentinel = Symbol.for(`mutation:${name}`)
      if (name === 'workspace.create') {
        mutationMap.set(sentinel, createWorkspaceFn)
      }
      return sentinel
    },
  },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-wrapper">{children}</div>
  ),
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}))

// Mock Dialog to render inline (no portal) so content is accessible in jsdom.
// The trigger is hidden so it doesn't collide with the submit button's accessible name.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog">{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogTrigger: () => null,
}))

// Mock progress/spinner — not relevant for input mask tests
vi.mock('@/components/ui/progress', () => ({
  Progress: () => null,
}))

vi.mock('@/components/ui/spinner', () => ({
  Spinner: () => null,
}))

import { CreateWorkspaceForm } from '../src/components/create-workspace-form'

const BRANCH_NAME_RE = /branch name/i
const CREATE_WORKSPACE_RE = /create workspace/i

/** Return the branch name input (dialog is always rendered inline by the mock). */
function getBranchInput() {
  return screen.getByRole('textbox', { name: BRANCH_NAME_RE })
}

describe('CreateWorkspaceForm — branch name mask', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('autofocuses the branch name input', () => {
    render(<CreateWorkspaceForm projectId="project-1" />)
    const input = getBranchInput()
    expect(document.activeElement).toBe(input)
  })

  it('renders the branch name input with correct placeholder', () => {
    render(<CreateWorkspaceForm projectId="project-1" />)
    const input = getBranchInput()
    expect(input).toBeTruthy()
    expect(input.getAttribute('placeholder')).toBe('laborer/my-feature')
  })

  it('converts spaces to hyphens', async () => {
    const user = userEvent.setup()
    render(<CreateWorkspaceForm projectId="project-1" />)
    const input = getBranchInput()

    await user.type(input, 'my feature branch')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('my-feature-branch')
    })
  })

  it('converts uppercase to lowercase', async () => {
    const user = userEvent.setup()
    render(<CreateWorkspaceForm projectId="project-1" />)
    const input = getBranchInput()

    await user.type(input, 'My-Feature')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('my-feature')
    })
  })

  it('allows forward slashes for namespaced branches', async () => {
    const user = userEvent.setup()
    render(<CreateWorkspaceForm projectId="project-1" />)
    const input = getBranchInput()

    await user.type(input, 'laborer/my-feature')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('laborer/my-feature')
    })
  })

  it('allows hyphens and underscores', async () => {
    const user = userEvent.setup()
    render(<CreateWorkspaceForm projectId="project-1" />)
    const input = getBranchInput()

    await user.type(input, 'my-feature_branch')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('my-feature_branch')
    })
  })

  it('rejects special characters not allowed in branch names', async () => {
    const user = userEvent.setup()
    render(<CreateWorkspaceForm projectId="project-1" />)
    const input = getBranchInput()

    await user.type(input, 'feat!@#$%ok')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('featok')
    })
  })

  it('submits with only projectId when branch name is empty', async () => {
    const user = userEvent.setup()
    createWorkspaceFn.mockResolvedValue({
      id: 'ws-new',
      projectId: 'project-1',
      branchName: 'auto-generated-branch',
      worktreePath: '/path/to/worktree',
      port: 3001,
      status: 'running',
    })

    render(<CreateWorkspaceForm projectId="project-1" />)

    const submitButton = screen.getByRole('button', {
      name: CREATE_WORKSPACE_RE,
    })
    await user.click(submitButton)

    await waitFor(() => {
      expect(createWorkspaceFn).toHaveBeenCalledWith({
        payload: {
          projectId: 'project-1',
        },
      })
    })
  })

  it('submits the masked branch name', async () => {
    const user = userEvent.setup()
    createWorkspaceFn.mockResolvedValue({
      id: 'ws-new',
      projectId: 'project-1',
      branchName: 'my-feature-branch',
      worktreePath: '/path/to/worktree',
      port: 3001,
      status: 'running',
    })

    render(<CreateWorkspaceForm projectId="project-1" />)
    const input = getBranchInput()

    await user.type(input, 'My Feature Branch')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('my-feature-branch')
    })

    const submitButton = screen.getByRole('button', {
      name: CREATE_WORKSPACE_RE,
    })
    await user.click(submitButton)

    await waitFor(() => {
      expect(createWorkspaceFn).toHaveBeenCalledWith({
        payload: {
          projectId: 'project-1',
          branchName: 'my-feature-branch',
        },
      })
    })
  })

  it('replaces forward slashes with hyphens on submit', async () => {
    const user = userEvent.setup()
    createWorkspaceFn.mockResolvedValue({
      id: 'ws-new',
      projectId: 'project-1',
      branchName: 'if-batch-column-variant-prd',
      worktreePath: '/path/to/worktree',
      port: 3001,
      status: 'running',
    })

    render(<CreateWorkspaceForm projectId="project-1" />)
    const input = getBranchInput()

    await user.type(input, 'if/batch-column-variant-prd')

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe(
        'if/batch-column-variant-prd'
      )
    })

    const submitButton = screen.getByRole('button', {
      name: CREATE_WORKSPACE_RE,
    })
    await user.click(submitButton)

    await waitFor(() => {
      expect(createWorkspaceFn).toHaveBeenCalledWith({
        payload: {
          projectId: 'project-1',
          branchName: 'if-batch-column-variant-prd',
        },
      })
    })
  })
})
