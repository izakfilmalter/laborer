/**
 * Tests for blocking deletion of root workspace.
 *
 * The root workspace (where worktreePath matches the project's repoPath)
 * should not have a destroy button, since deleting the main git checkout
 * would be destructive and unexpected.
 *
 * @see Issue: Block delete of root workspace
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  destroyFn,
  isElectronMock,
  mutationMap,
  queryDbMock,
  useLaborerStoreMock,
} = vi.hoisted(() => ({
  destroyFn: vi.fn(),
  isElectronMock: vi.fn(() => false),
  mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
  queryDbMock: vi.fn((_table, options: { label: string }) => options),
  useLaborerStoreMock: vi.fn(),
}))

vi.mock('@/lib/desktop', () => ({
  isElectron: isElectronMock,
  openExternalUrl: vi.fn(async () => true),
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
  useAtomSet: (atom: unknown) => mutationMap.get(atom) ?? vi.fn(),
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

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
  },
}))

vi.mock('@/panels/panel-context', () => ({
  usePanelActions: () => ({
    closeWorkspace: vi.fn(),
    forceCloseWorkspace: vi.fn(),
  }),
}))

vi.mock('@/components/terminal-list', () => ({
  TerminalList: () => <div data-testid="terminal-list" />,
}))

vi.mock('@/components/review-pr-form', () => ({
  ReviewPrForm: () => null,
}))

vi.mock('@/components/fix-findings-form', () => ({
  FixFindingsForm: () => null,
}))

vi.mock('@/components/copy-button', () => ({
  CopyButton: () => null,
}))

vi.mock('@/components/github-pr-status-badge', () => ({
  GitHubPrStatusBadge: () => null,
}))

vi.mock('@/components/review-verdict-badge', () => ({
  ReviewVerdictBadge: () => null,
}))

vi.mock('@/components/plan-issues-list', () => ({
  PlanIssuesList: () => null,
}))

vi.mock('@/hooks/use-destroy-workspace-checks', () => ({
  useDestroyWorkspaceChecks: () => ({
    activeTerminals: [],
    dirtyFiles: [],
    isCheckingDirtyFiles: false,
    isCheckingTerminals: false,
    reset: vi.fn(),
    startChecks: vi.fn(),
  }),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-wrapper">{children}</div>
  ),
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode
    render?: React.ReactElement
  }) => <>{render ?? children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}))

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

// Import after mocks are set up
import { WorkspaceList } from '../src/components/workspace-list'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const DESTROY_WORKSPACE_RE = /destroy workspace/i
const PROJECT_REPO_PATH = '/Users/dev/my-project'

const makeWorkspace = (
  overrides: Partial<{
    id: string
    projectId: string
    branchName: string
    worktreePath: string
    port: number
    status: string
    origin: string
    createdAt: string
    taskSource: string | null
    containerId: string | null
    containerUrl: string | null
    containerStatus: string | null
    containerSetupStep: string | null
    worktreeSetupStep: string | null
    prNumber: number | null
    prUrl: string | null
    prTitle: string | null
    prState: string | null
    aheadCount: number | null
    behindCount: number | null
  }> = {}
) => ({
  id: 'ws-1',
  projectId: 'project-1',
  branchName: 'main',
  worktreePath: PROJECT_REPO_PATH,
  port: 3000,
  status: 'running',
  origin: 'external',
  createdAt: new Date().toISOString(),
  taskSource: null,
  containerId: null,
  containerUrl: null,
  containerStatus: null,
  containerSetupStep: null,
  worktreeSetupStep: null,
  prNumber: null,
  prUrl: null,
  prTitle: null,
  prState: null,
  aheadCount: null,
  behindCount: null,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Configure the mock store with the given workspaces (and optional PRDs). */
const mockStore = (workspaces: unknown[], prds: unknown[] = []) => {
  useLaborerStoreMock.mockReturnValue({
    useQuery: (query: { label: string }) => {
      if (query.label === 'workspaceList') {
        return workspaces
      }
      if (query.label === 'workspaceList.prds') {
        return prds
      }
      return []
    },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkspaceList — root workspace delete protection', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isElectronMock.mockReturnValue(false)
    destroyFn.mockResolvedValue(undefined)
  })

  it('does not render destroy button for root workspace (worktreePath === repoPath)', () => {
    const rootWorkspace = makeWorkspace({
      id: 'root-ws',
      branchName: 'main',
      worktreePath: PROJECT_REPO_PATH,
    })

    mockStore([rootWorkspace])

    render(<WorkspaceList projectId="project-1" repoPath={PROJECT_REPO_PATH} />)

    // The destroy button should NOT be present for the root workspace
    expect(
      screen.queryByRole('button', { name: DESTROY_WORKSPACE_RE })
    ).toBeNull()
  })

  it('renders destroy button for non-root workspace (worktreePath !== repoPath)', () => {
    const linkedWorkspace = makeWorkspace({
      id: 'linked-ws',
      branchName: 'feature/my-feature',
      worktreePath: '/Users/dev/my-project-worktrees/feature-my-feature',
    })

    mockStore([linkedWorkspace])

    render(<WorkspaceList projectId="project-1" repoPath={PROJECT_REPO_PATH} />)

    // The destroy button SHOULD be present for non-root workspaces
    expect(
      screen.getByRole('button', { name: DESTROY_WORKSPACE_RE })
    ).toBeTruthy()
  })

  it('renders destroy button for some workspaces but not root when mixed', () => {
    const rootWorkspace = makeWorkspace({
      id: 'root-ws',
      branchName: 'main',
      worktreePath: PROJECT_REPO_PATH,
    })
    const linkedWorkspace = makeWorkspace({
      id: 'linked-ws',
      branchName: 'feature/my-feature',
      worktreePath: '/Users/dev/my-project-worktrees/feature-my-feature',
    })

    mockStore([rootWorkspace, linkedWorkspace])

    render(<WorkspaceList projectId="project-1" repoPath={PROJECT_REPO_PATH} />)

    // Should have exactly ONE destroy button (for the linked workspace only)
    const destroyButtons = screen.getAllByRole('button', {
      name: DESTROY_WORKSPACE_RE,
    })
    expect(destroyButtons).toHaveLength(1)
  })
})
