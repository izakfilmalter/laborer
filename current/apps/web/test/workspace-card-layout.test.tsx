/**
 * Tests for the reorganized workspace card layout.
 *
 * Row 1 (Git): branch name + PR badge
 *
 * Row 2 (Sandbox/Infra): sandbox URL/port + status badge + pause/play
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
  workspaces: { name: 'workspaces' },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
  },
}))

vi.mock('@/panels/panel-context', () => ({
  useActiveWorkspaceId: () => null,
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

const PAUSE_SANDBOX_RE = /pause sandbox/i
const RESUME_SANDBOX_RE = /resume sandbox/i
const DESTROY_WORKSPACE_RE = /destroy workspace/i
const SETTING_UP_SANDBOX_RE = /Setting up sandbox/
const CREATING_SANDBOX_RE = /Creating sandbox/
const BUILDING_CONTAINER_IMAGE_RE = /Building container image/
const PUSHING_CODE_RE = /Pushing code/

const makeWorkspace = (
  overrides: Partial<{
    id: string
    projectId: string
    branchName: string
    worktreePath: string
    status: string
    origin: string
    createdAt: string
    taskSource: string | null
    sandboxId: string | null
    sandboxUrl: string | null
    sandboxStatus: string | null
    sandboxSetupStep: string | null
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
  status: 'running',
  origin: 'laborer',
  createdAt: new Date().toISOString(),
  taskSource: null,
  sandboxId: null,
  sandboxUrl: null,
  sandboxStatus: null,
  sandboxSetupStep: null,
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

describe('Workspace card layout — Row 2 (Sandbox/Infra row)', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isElectronMock.mockReturnValue(false)
  })

  it('shows status badge and pause button on the infra row for sandboxed workspace', () => {
    mockStore([
      makeWorkspace({
        sandboxId: 'container-1',
        sandboxUrl: 'my-app--laborer.orb.local',
        sandboxStatus: 'running',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    // Status badge should be present
    expect(screen.getByText('running')).toBeTruthy()

    // Pause button should be present
    expect(screen.getByRole('button', { name: PAUSE_SANDBOX_RE })).toBeTruthy()

    // Destroy button should be present on Row 1 (non-root workspace)
    expect(
      screen.getByRole('button', { name: DESTROY_WORKSPACE_RE })
    ).toBeTruthy()
  })

  it('shows status badge on infra row for non-sandboxed workspace', () => {
    mockStore([makeWorkspace()])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    // Status badge should be present
    expect(screen.getByText('running')).toBeTruthy()

    // Destroy button should be present
    expect(
      screen.getByRole('button', { name: DESTROY_WORKSPACE_RE })
    ).toBeTruthy()
  })

  it('shows paused status with resume button for paused sandboxes', () => {
    mockStore([
      makeWorkspace({
        sandboxId: 'container-1',
        sandboxUrl: 'my-app--laborer.orb.local',
        sandboxStatus: 'paused',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText('paused')).toBeTruthy()
    expect(screen.getByRole('button', { name: RESUME_SANDBOX_RE })).toBeTruthy()
  })
})

describe('Workspace card layout — setup step progress', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isElectronMock.mockReturnValue(false)
  })

  it('shows Daytona "Creating sandbox..." label when sandboxSetupStep is creating-sandbox', () => {
    mockStore([
      makeWorkspace({
        status: 'creating',
        sandboxSetupStep: 'creating-sandbox',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText('Creating sandbox...')).toBeTruthy()
  })

  it('shows Daytona "Pushing code to sandbox..." label when sandboxSetupStep is pushing-code', () => {
    mockStore([
      makeWorkspace({
        status: 'creating',
        sandboxSetupStep: 'pushing-code',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText('Pushing code to sandbox...')).toBeTruthy()
  })

  it('shows Daytona "Building sandbox snapshot..." label when sandboxSetupStep is building-snapshot', () => {
    mockStore([
      makeWorkspace({
        status: 'creating',
        sandboxSetupStep: 'building-snapshot',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText('Building sandbox snapshot...')).toBeTruthy()
  })

  it('shows Daytona "Configuring SSH access..." label when sandboxSetupStep is configuring-ssh', () => {
    mockStore([
      makeWorkspace({
        status: 'creating',
        sandboxSetupStep: 'configuring-ssh',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText('Configuring SSH access...')).toBeTruthy()
  })

  it('shows Daytona "Starting sandbox..." label when sandboxSetupStep is starting-sandbox', () => {
    mockStore([
      makeWorkspace({
        status: 'creating',
        sandboxSetupStep: 'starting-sandbox',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText('Starting sandbox...')).toBeTruthy()
  })

  it('shows Docker "Building container image..." label when sandboxSetupStep is building-image', () => {
    mockStore([
      makeWorkspace({
        status: 'creating',
        sandboxSetupStep: 'building-image',
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.getByText('Building container image...')).toBeTruthy()
  })

  it('shows no setup step indicator when sandboxSetupStep is null', () => {
    mockStore([
      makeWorkspace({
        sandboxId: 'container-1',
        sandboxUrl: 'my-app--laborer.orb.local',
        sandboxStatus: 'running',
        sandboxSetupStep: null,
      }),
    ])

    render(<WorkspaceList projectId="project-1" repoPath="/repo" />)

    expect(screen.queryByText(SETTING_UP_SANDBOX_RE)).toBeNull()
    expect(screen.queryByText(CREATING_SANDBOX_RE)).toBeNull()
    expect(screen.queryByText(BUILDING_CONTAINER_IMAGE_RE)).toBeNull()
    expect(screen.queryByText(PUSHING_CODE_RE)).toBeNull()
  })
})
