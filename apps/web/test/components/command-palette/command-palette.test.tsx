import type { SharedProjectRow } from '@laborer/shared/rpc'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '@/components/command-palette/command-palette'
import type { WorkspaceView } from '@/db/shared-state'

const mocks = vi.hoisted(() => ({
  activeWorkspaceId: 'workspace-b' as string | null,
  createWorkspace: vi.fn(async () => ({
    branchName: 'feature',
    fromSlack: false,
    id: 'created-workspace',
  })),
  hotkeyHandler: null as
    | null
    | ((event: { preventDefault: () => void }) => void),
}))

vi.mock('@tanstack/react-hotkeys', () => ({
  useHotkeySequence: (
    _sequence: readonly string[],
    handler: (event: { preventDefault: () => void }) => void
  ) => {
    mocks.hotkeyHandler = handler
  },
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}))

vi.mock('@/hooks/use-create-workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-create-workspace')>()),
  useCreateWorkspace: () => mocks.createWorkspace,
}))

vi.mock('@/hooks/use-workspace-sync-actions', () => ({
  useWorkspaceSyncActions: () => ({
    pullWorkspace: vi.fn(),
    pushWorkspace: vi.fn(),
  }),
}))

vi.mock('@/panels/panel-context', () => ({
  useActiveWorkspaceId: () => mocks.activeWorkspaceId,
  usePanelActions: () => null,
}))

const project = (id: string, name: string): SharedProjectRow => ({
  branchName: null,
  canonicalGitCommonDir: `/repos/${id}/.git`,
  createdAt: 1,
  id,
  name,
  repoId: `repo-${id}`,
  revision: 1,
  rootPath: `/repos/${id}`,
  sortOrder: null,
  updatedAt: 1,
})

const workspace = (id: string, projectId: string): WorkspaceView => ({
  baseBranch: null,
  baseSha: null,
  branchName: id,
  createdAt: '1',
  errorMessage: null,
  id,
  origin: 'laborer',
  parentTaskId: null,
  prApprovals: null,
  prAuthorLogin: null,
  prBaseBranch: null,
  prCheckStatus: null,
  prChecks: null,
  prIsDraft: false,
  prMergeStatus: null,
  prNumber: null,
  projectId,
  prReviewDecision: null,
  prState: null,
  prTitle: null,
  prUnresolvedThreads: null,
  prUrl: null,
  status: 'running',
  taskNumber: 1,
  taskSource: 'manual',
  worktreePath: `/worktrees/${id}`,
  worktreeSetupStep: null,
})

const props: ComponentProps<typeof CommandPalette> = {
  onToggleBoard: vi.fn(),
  projects: [project('project-a', 'Alpha'), project('project-b', 'Beta')],
  workspaces: [
    workspace('workspace-a', 'project-a'),
    workspace('workspace-b', 'project-b'),
  ],
}

function openPalette() {
  render(<CommandPalette {...props} />)
  act(() => {
    mocks.hotkeyHandler?.({ preventDefault: vi.fn() })
  })
}

afterEach(() => {
  cleanup()
  mocks.activeWorkspaceId = 'workspace-b'
  mocks.createWorkspace.mockClear()
  mocks.hotkeyHandler = null
})

describe('CommandPalette contextual workspace creation', () => {
  it('puts creation in the focused workspace project first', () => {
    openPalette()

    const options = screen.getAllByRole('option')
    expect(options[0]?.textContent).toContain('New workspace in Beta')
    expect(options[1]?.textContent).toContain('Toggle task board')
  })

  it('creates an auto-named project-level workspace in the focused project', () => {
    openPalette()

    fireEvent.click(screen.getByText('New workspace in Beta'))

    expect(mocks.createWorkspace).toHaveBeenCalledWith({
      branchNameOrSlackUrl: '',
      projectId: 'project-b',
    })
  })

  it('does not show a contextual action without a focused workspace', () => {
    mocks.activeWorkspaceId = null
    openPalette()

    const options = screen.getAllByRole('option')
    expect(options[0]?.textContent).toContain('Toggle task board')
    expect(screen.queryByText('New workspace in Beta')).toBeNull()
    expect(screen.getByText('New workspace in...')).toBeDefined()
  })
})
