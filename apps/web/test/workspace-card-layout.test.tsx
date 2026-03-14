/**
 * Tests for the reorganized workspace card layout.
 *
 * Row 1 (Git): branch name + PR badge + review verdict + findings count
 *   + Review/Fix action buttons (hidden when no PR)
 *
 * Row 2 (Docker/Infra): container URL/port + status badge + pause/play
 *
 * @see Issue: Reorganize workspace actions
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  destroyFn,
  isElectronMock,
  mutationMap,
  queryDbMock,
  startLoopFn,
  useLaborerStoreMock,
} = vi.hoisted(() => ({
  destroyFn: vi.fn(),
  isElectronMock: vi.fn(() => false),
  mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
  queryDbMock: vi.fn((_table, options: { label: string }) => options),
  startLoopFn: vi.fn(),
  useLaborerStoreMock: vi.fn(),
}))

vi.mock('@/lib/desktop', () => ({
  isElectron: isElectronMock,
  openExternalUrl: vi.fn(async () => true),
  terminalRpcUrl: () => 'http://localhost:2101',
}))

vi.mock('@/components/review-findings-count', () => ({
  ReviewFindingsCount: () => (
    <span data-testid="review-findings-count">findings</span>
  ),
  useUnresolvedFindingsCount: () => 0,
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
      if (name === 'brrr.startLoop') {
        mutationMap.set(sentinel, startLoopFn)
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

vi.mock('@/components/copy-button', () => ({
  CopyButton: () => null,
}))

vi.mock('@/components/review-verdict-badge', () => ({
  ReviewVerdictBadge: () => (
    <span data-testid="review-verdict-badge">verdict</span>
  ),
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
    <div>{children}</div>
  ),
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode
    render?: React.ReactElement
  }) => <>{render ?? children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
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

// Import after mocks
import { WorkspaceList } from '../src/components/workspace-list'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REVIEW_PR_RE = /review pr/i
const FIX_FINDINGS_RE = /fix findings/i
const PAUSE_CONTAINER_RE = /pause container/i
const RESUME_CONTAINER_RE = /resume container/i
const DESTROY_WORKSPACE_RE = /destroy workspace/i

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
  }> = {}
) => ({
  id: 'ws-1',
  projectId: 'project-1',
  branchName: 'feature/my-feature',
  worktreePath: '/path/to/worktree',
  port: 3000,
  status: 'running',
  origin: 'laborer',
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
  ...overrides,
})

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

describe('Workspace card layout — Row 1 (Git row)', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isElectronMock.mockReturnValue(false)
  })

  it('hides Review PR and Fix Findings buttons when workspace has no PR', () => {
    mockStore([makeWorkspace()])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.queryByRole('button', { name: REVIEW_PR_RE })).toBeNull()
    expect(screen.queryByRole('button', { name: FIX_FINDINGS_RE })).toBeNull()
  })

  it('shows Review PR and Fix Findings buttons when workspace has a PR', () => {
    mockStore([
      makeWorkspace({
        prNumber: 42,
        prState: 'OPEN',
        prTitle: 'Add feature',
        prUrl: 'https://github.com/org/repo/pull/42',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByRole('button', { name: REVIEW_PR_RE })).toBeTruthy()
    expect(screen.getByRole('button', { name: FIX_FINDINGS_RE })).toBeTruthy()
  })
})

describe('Workspace card layout — Row 2 (Docker/Infra row)', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isElectronMock.mockReturnValue(false)
  })

  it('shows status badge and pause button on the infra row for containerized workspace', () => {
    mockStore([
      makeWorkspace({
        containerId: 'container-1',
        containerUrl: 'my-app--laborer.orb.local',
        containerStatus: 'running',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    // Status badge should be present
    expect(screen.getByText('running')).toBeTruthy()

    // Pause button should be present
    expect(
      screen.getByRole('button', { name: PAUSE_CONTAINER_RE })
    ).toBeTruthy()

    // Destroy button should be present on Row 1 (non-root workspace)
    expect(
      screen.getByRole('button', { name: DESTROY_WORKSPACE_RE })
    ).toBeTruthy()
  })

  it('shows status badge on infra row for non-containerized workspace', () => {
    mockStore([makeWorkspace()])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    // Status badge should be present
    expect(screen.getByText('running')).toBeTruthy()

    // Destroy button should be present
    expect(
      screen.getByRole('button', { name: DESTROY_WORKSPACE_RE })
    ).toBeTruthy()
  })

  it('shows paused status with resume button for paused containers', () => {
    mockStore([
      makeWorkspace({
        containerId: 'container-1',
        containerUrl: 'my-app--laborer.orb.local',
        containerStatus: 'paused',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText('paused')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: RESUME_CONTAINER_RE })
    ).toBeTruthy()
  })
})
