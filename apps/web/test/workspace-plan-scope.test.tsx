/**
 * Tests for plan-workspace association and scoped task list in WorkspaceList.
 *
 * Verifies that workspaces associated with a plan (branch name `plan/<slug>`)
 * display a scoped PlanIssuesList showing only that plan's issues.
 *
 * @see Issue #193: Plan workspace scoped task list and brrr integration
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  destroyFn,
  isElectronMock,
  startLoopFn,
  closeWorkspaceMock,
  mutationMap,
  openExternalUrlMock,
  queryDbMock,
  useLaborerStoreMock,
} = vi.hoisted(() => ({
  destroyFn: vi.fn(),
  isElectronMock: vi.fn(() => false),
  startLoopFn: vi.fn(),
  closeWorkspaceMock: vi.fn(),
  mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
  openExternalUrlMock: vi.fn(async () => true),
  queryDbMock: vi.fn((_table, options: { label: string }) => options),
  useLaborerStoreMock: vi.fn(),
}))

vi.mock('@/lib/desktop', () => ({
  isElectron: isElectronMock,
  openExternalUrl: openExternalUrlMock,
  terminalRpcUrl: () => 'http://localhost:2101',
}))

vi.mock('@/hooks/use-terminal-list', () => ({
  useTerminalList: () => ({
    terminals: [],
    refresh: vi.fn(async () => []),
    errorMessage: null,
    isServiceAvailable: true,
    isLoading: false,
    serviceStatus: 'available' as const,
  }),
}))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => {
    return mutationMap.get(atom) ?? vi.fn()
  },
  useAtomValue: () => ({
    _tag: 'Success',
    value: { devServer: { autoOpen: { value: false } } },
  }),
}))

vi.mock('@/atoms/laborer-client', () => ({
  ConfigReactivityKeys: ['config'] as const,
  LaborerClient: {
    mutation: (name: string) => {
      const sentinel = Symbol.for(`mutation:${name}`)
      if (name === 'workspace.destroy') {
        mutationMap.set(sentinel, destroyFn)
      }
      if (name === 'brrr.startLoop') {
        mutationMap.set(sentinel, startLoopFn)
      }
      if (name === 'task.updateStatus') {
        mutationMap.set(sentinel, vi.fn())
      }
      return sentinel
    },
    query: () => Symbol.for('query:stub'),
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
  tasks: { name: 'tasks' },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), loading: vi.fn(() => 'toast-id'), success: vi.fn() },
}))

vi.mock('@/panels/panel-context', () => ({
  usePanelActions: () => ({
    closeWorkspace: closeWorkspaceMock,
    forceCloseWorkspace: closeWorkspaceMock,
  }),
}))

// Stub terminal list to avoid complex nested mocking
vi.mock('@/components/terminal-list', () => ({
  TerminalList: () => <div data-testid="terminal-list" />,
}))

// Stub review pr and fix findings forms
vi.mock('@/components/review-pr-form', () => ({
  ReviewPrForm: () => null,
}))
vi.mock('@/components/fix-findings-form', () => ({
  FixFindingsForm: () => null,
}))

// Stub copy-button
vi.mock('@/components/copy-button', () => ({
  CopyButton: () => null,
}))

// Stub alert dialog to simplify testing
vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTrigger: ({ render }: { render: React.ReactElement }) => render,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogAction: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

import { WorkspaceList } from '../src/components/workspace-list'

const START_BRRR_LOOP_RE = /start brrr loop/i
const DESTROY_ACTION_RE = /destroy ⌘ ↵/i

const WORKSPACE_PLAN = {
  id: 'ws-1',
  projectId: 'project-1',
  branchName: 'plan/my-cool-feature',
  worktreePath: '/path/to/worktree',
  port: 2101,
  status: 'running',
  origin: 'laborer',
  createdAt: '2026-03-06T00:00:00.000Z',
  taskSource: null,
}

const WORKSPACE_REGULAR = {
  id: 'ws-2',
  projectId: 'project-1',
  branchName: 'feature/something-else',
  worktreePath: '/path/to/other-worktree',
  port: 2102,
  status: 'running',
  origin: 'laborer',
  createdAt: '2026-03-06T00:00:00.000Z',
  taskSource: null,
}

const WORKSPACE_WITH_CLOSED_PR = {
  ...WORKSPACE_REGULAR,
  id: 'ws-3',
  branchName: 'feature/has-pr',
  prNumber: 77,
  prState: 'CLOSED',
  prTitle: 'Closed bug fix',
  prUrl: null,
}

const PRD = {
  id: 'prd-1',
  projectId: 'project-1',
  title: 'My Cool Feature',
  slug: 'my-cool-feature',
  filePath: '/path/to/prd.md',
  status: 'active',
  createdAt: '2026-03-06T00:00:00.000Z',
}

const PRD_TASKS = [
  {
    id: 'task-1',
    projectId: 'project-1',
    source: 'prd',
    prdId: 'prd-1',
    title: 'Implement login flow',
    status: 'pending',
    externalId: '1',
  },
  {
    id: 'task-2',
    projectId: 'project-1',
    source: 'prd',
    prdId: 'prd-1',
    title: 'Add auth middleware',
    status: 'completed',
    externalId: '2',
  },
]

describe('WorkspaceList plan association', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isElectronMock.mockReturnValue(false)
    destroyFn.mockResolvedValue(undefined)
  })

  it('closes open workspace panels after a successful destroy', async () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return [WORKSPACE_REGULAR]
        }
        if (query.label === 'workspaceList.prds') {
          return []
        }
        return []
      },
    })

    render(<WorkspaceList projectId="project-1" />)

    fireEvent.click(screen.getByRole('button', { name: DESTROY_ACTION_RE }))

    await waitFor(() => {
      expect(destroyFn).toHaveBeenCalledWith({
        payload: { workspaceId: 'ws-2', force: undefined },
      })
      expect(closeWorkspaceMock).toHaveBeenCalledWith('ws-2')
    })
  })

  it('detects plan-associated workspace and shows scoped task list', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return [WORKSPACE_PLAN]
        }
        if (query.label === 'workspaceList.prds') {
          return [PRD]
        }
        // PlanIssuesList queries tasks
        if (query.label === 'planIssuesList.tasks') {
          return PRD_TASKS
        }
        return []
      },
    })

    render(<WorkspaceList projectId="project-1" />)

    // Workspace card should be visible (branch name appears in card title
    // and destroy dialog, so use getAllByText)
    expect(screen.getAllByText('plan/my-cool-feature').length).toBeGreaterThan(
      0
    )

    // Plan Issues heading should appear
    expect(screen.getByText('Plan Issues')).toBeTruthy()

    // Scoped task list should show the PRD tasks
    expect(screen.getByText('Implement login flow')).toBeTruthy()
    expect(screen.getByText('Add auth middleware')).toBeTruthy()
  })

  it('does not show plan issues for regular (non-plan) workspaces', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return [WORKSPACE_REGULAR]
        }
        if (query.label === 'workspaceList.prds') {
          return [PRD]
        }
        if (query.label === 'planIssuesList.tasks') {
          return PRD_TASKS
        }
        return []
      },
    })

    render(<WorkspaceList projectId="project-1" />)

    // Regular workspace card should be visible (branch name appears in
    // card title and destroy dialog)
    expect(
      screen.getAllByText('feature/something-else').length
    ).toBeGreaterThan(0)

    // Plan Issues heading should NOT appear
    expect(screen.queryByText('Plan Issues')).toBeNull()
  })

  it('shows plan issues only for matching workspace, not for non-matching', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return [WORKSPACE_PLAN, WORKSPACE_REGULAR]
        }
        if (query.label === 'workspaceList.prds') {
          return [PRD]
        }
        if (query.label === 'planIssuesList.tasks') {
          return PRD_TASKS
        }
        return []
      },
    })

    render(<WorkspaceList projectId="project-1" />)

    // Both workspaces should be visible
    expect(screen.getAllByText('plan/my-cool-feature').length).toBeGreaterThan(
      0
    )
    expect(
      screen.getAllByText('feature/something-else').length
    ).toBeGreaterThan(0)

    // Only one "Plan Issues" heading should be present (for the plan workspace)
    const planIssuesHeaders = screen.getAllByText('Plan Issues')
    expect(planIssuesHeaders.length).toBe(1)
  })

  it("does not match plan workspaces from a different project's PRDs", () => {
    const otherProjectPrd = {
      ...PRD,
      projectId: 'project-2',
    }

    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return [WORKSPACE_PLAN]
        }
        if (query.label === 'workspaceList.prds') {
          return [otherProjectPrd] // PRD belongs to different project
        }
        if (query.label === 'planIssuesList.tasks') {
          return PRD_TASKS
        }
        return []
      },
    })

    render(<WorkspaceList projectId="project-1" />)

    // Workspace card should be visible
    expect(screen.getAllByText('plan/my-cool-feature').length).toBeGreaterThan(
      0
    )

    // Plan Issues should NOT appear because the PRD belongs to a different project
    expect(screen.queryByText('Plan Issues')).toBeNull()
  })

  it('shows empty state when plan has no issues', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return [WORKSPACE_PLAN]
        }
        if (query.label === 'workspaceList.prds') {
          return [PRD]
        }
        if (query.label === 'planIssuesList.tasks') {
          return [] // No tasks
        }
        return []
      },
    })

    render(<WorkspaceList projectId="project-1" />)

    // Plan Issues heading should still appear
    expect(screen.getByText('Plan Issues')).toBeTruthy()

    // The empty state from PlanIssuesList should render
    expect(screen.getByText('No issues')).toBeTruthy()
  })

  it('filters out destroyed workspaces from plan association', () => {
    const destroyedPlanWorkspace = {
      ...WORKSPACE_PLAN,
      status: 'destroyed',
    }

    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return [destroyedPlanWorkspace]
        }
        if (query.label === 'workspaceList.prds') {
          return [PRD]
        }
        if (query.label === 'planIssuesList.tasks') {
          return PRD_TASKS
        }
        return []
      },
    })

    render(<WorkspaceList projectId="project-1" />)

    // Destroyed workspaces should not render at all
    expect(screen.getByText('No workspaces')).toBeTruthy()
  })

  it('brrr start loop button is present on plan-associated workspace', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return [WORKSPACE_PLAN]
        }
        if (query.label === 'workspaceList.prds') {
          return [PRD]
        }
        if (query.label === 'planIssuesList.tasks') {
          return PRD_TASKS
        }
        return []
      },
    })

    render(<WorkspaceList projectId="project-1" />)

    // The brrr start loop button should be present
    const startButton = screen.getByRole('button', {
      name: START_BRRR_LOOP_RE,
    })
    expect(startButton).toBeTruthy()
  })

  it('shows the GitHub status badge in the sidebar even when the PR URL is missing', () => {
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return [WORKSPACE_WITH_CLOSED_PR]
        }
        if (query.label === 'workspaceList.prds') {
          return []
        }
        return []
      },
    })

    render(<WorkspaceList projectId="project-1" />)

    expect(screen.getByText('#77')).toBeTruthy()
    expect(screen.getByText('closed')).toBeTruthy()
  })

  it('opens container links in the OS browser when running in Electron', () => {
    isElectronMock.mockReturnValue(true)
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'workspaceList') {
          return [
            {
              ...WORKSPACE_REGULAR,
              containerId: 'container-1',
              containerStatus: 'running',
              containerUrl: 'preview.example.com',
            },
          ]
        }
        if (query.label === 'workspaceList.prds') {
          return []
        }
        return []
      },
    })

    render(<WorkspaceList projectId="project-1" />)

    fireEvent.click(screen.getByRole('link', { name: 'preview.example.com' }))

    expect(openExternalUrlMock).toHaveBeenCalledWith(
      'https://preview.example.com'
    )
  })
})
