import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createWorkspaceFn, mutationMap, queryDbMock, useLaborerStoreMock } =
  vi.hoisted(() => ({
    createWorkspaceFn: vi.fn(),
    mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
    queryDbMock: vi.fn((_table, options: { label: string }) => options),
    useLaborerStoreMock: vi.fn(),
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

vi.mock('@livestore/livestore', () => ({
  queryDb: queryDbMock,
}))

vi.mock('@/livestore/store', () => ({
  useLaborerStore: useLaborerStoreMock,
}))

vi.mock('@laborer/shared/schema', () => ({
  prds: { name: 'prds' },
  workspaces: { name: 'workspaces' },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

// Mock the tooltip since @base-ui/react tooltip uses portal which isn't
// available in test environment. We just need the trigger to render.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-wrapper">{children}</div>
  ),
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}))

import {
  CreatePlanWorkspace,
  planBranchName,
} from '../src/components/create-plan-workspace'

const CREATE_WORKSPACE_RE = /Create Workspace/i

const PRD = {
  id: 'prd-1',
  projectId: 'project-1',
  title: 'My Test Plan',
  slug: 'my-test-plan',
  filePath: '/path/to/prd.md',
  status: 'active',
  createdAt: '2026-03-06T00:00:00.000Z',
}

describe('CreatePlanWorkspace', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders a 'Create Workspace' button when no workspace exists", () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'createPlanWorkspace.prds') {
          return [PRD]
        }
        return [] // no workspaces
      },
    })

    render(<CreatePlanWorkspace prdId="prd-1" />)

    const button = screen.getByRole('button', { name: CREATE_WORKSPACE_RE })
    expect(button).toBeTruthy()
    expect(button.getAttribute('disabled')).toBeNull()
  })

  it('disables the button with tooltip when workspace already exists for the plan', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'createPlanWorkspace.prds') {
          return [PRD]
        }
        return [
          {
            id: 'ws-1',
            projectId: 'project-1',
            branchName: 'plan/my-test-plan',
            worktreePath: '/path/to/worktree',
            port: 2101,
            status: 'running',
            origin: 'laborer',
            createdAt: '2026-03-06T00:00:00.000Z',
          },
        ]
      },
    })

    render(<CreatePlanWorkspace prdId="prd-1" />)

    const button = screen.getByRole('button', { name: CREATE_WORKSPACE_RE })
    expect(button.hasAttribute('disabled')).toBe(true)

    // Tooltip content should mention the existing workspace
    const tooltipContent = screen.getByTestId('tooltip-content')
    expect(tooltipContent.textContent).toContain('plan/my-test-plan')
  })

  it('does not treat destroyed workspaces as existing', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'createPlanWorkspace.prds') {
          return [PRD]
        }
        return [
          {
            id: 'ws-1',
            projectId: 'project-1',
            branchName: 'plan/my-test-plan',
            worktreePath: '/path/to/worktree',
            port: 2101,
            status: 'destroyed',
            origin: 'laborer',
            createdAt: '2026-03-06T00:00:00.000Z',
          },
        ]
      },
    })

    render(<CreatePlanWorkspace prdId="prd-1" />)

    const button = screen.getByRole('button', { name: CREATE_WORKSPACE_RE })
    expect(button.getAttribute('disabled')).toBeNull()
  })

  it('calls workspace.create with the correct branch name on click', async () => {
    const user = userEvent.setup()
    createWorkspaceFn.mockResolvedValue({
      id: 'ws-new',
      projectId: 'project-1',
      branchName: 'plan/my-test-plan',
      worktreePath: '/path/to/worktree',
      port: 3001,
      status: 'running',
    })

    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'createPlanWorkspace.prds') {
          return [PRD]
        }
        return []
      },
    })

    render(<CreatePlanWorkspace prdId="prd-1" />)

    const button = screen.getByRole('button', { name: CREATE_WORKSPACE_RE })
    await user.click(button)

    expect(createWorkspaceFn).toHaveBeenCalledWith({
      payload: {
        projectId: 'project-1',
        branchName: 'plan/my-test-plan',
      },
    })
  })

  it('renders nothing when the PRD is not found', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [],
    })

    const { container } = render(<CreatePlanWorkspace prdId="prd-missing" />)
    expect(container.innerHTML).toBe('')
  })

  it('does not match workspaces from a different project', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'createPlanWorkspace.prds') {
          return [PRD]
        }
        return [
          {
            id: 'ws-1',
            projectId: 'different-project',
            branchName: 'plan/my-test-plan',
            worktreePath: '/path/to/worktree',
            port: 2101,
            status: 'running',
            origin: 'laborer',
            createdAt: '2026-03-06T00:00:00.000Z',
          },
        ]
      },
    })

    render(<CreatePlanWorkspace prdId="prd-1" />)

    const button = screen.getByRole('button', { name: CREATE_WORKSPACE_RE })
    expect(button.getAttribute('disabled')).toBeNull()
  })
})

describe('planBranchName', () => {
  it('derives branch name from plan slug', () => {
    expect(planBranchName('my-test-plan')).toBe('plan/my-test-plan')
  })

  it('handles slugs with hyphens', () => {
    expect(planBranchName('mcp-server-prd-driven-tasks')).toBe(
      'plan/mcp-server-prd-driven-tasks'
    )
  })
})
