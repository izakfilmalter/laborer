import type { SharedProjectRow } from '@laborer/shared/rpc'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
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

const workspaceContainers: HTMLElement[] = []

function openPalette() {
  const result = render(<CommandPalette {...props} />)
  act(() => {
    mocks.hotkeyHandler?.({ preventDefault: vi.fn() })
  })
  return result
}

function addVisibleWorkspaceContainer({
  testId = 'workspace-frame',
  workspaceId,
}: {
  readonly testId?: 'fullscreen-workspace' | 'workspace-frame'
  readonly workspaceId: string
}) {
  const container = document.createElement('div')
  container.dataset.testid = testId
  container.dataset.workspaceOverlayContainer =
    testId === 'fullscreen-workspace' ? 'fullscreen' : 'frame'
  container.dataset.workspaceId = workspaceId
  vi.spyOn(container, 'getClientRects').mockReturnValue([
    {} as DOMRect,
  ] as unknown as DOMRectList)
  document.body.append(container)
  workspaceContainers.push(container)
  return container
}

afterEach(() => {
  cleanup()
  mocks.activeWorkspaceId = 'workspace-b'
  mocks.createWorkspace.mockClear()
  mocks.hotkeyHandler = null
  for (const container of workspaceContainers) {
    container.remove()
  }
  workspaceContainers.length = 0
})

describe('CommandPalette contextual workspace creation', () => {
  it('puts creation in the focused workspace project first', () => {
    openPalette()

    const options = screen.getAllByRole('option')
    expect(options[0]?.textContent).toContain('New workspace in Beta')
    expect(options[1]?.textContent).toContain('Toggle task board')
  })

  it('opens the shared creation input for the focused project', async () => {
    openPalette()

    fireEvent.click(screen.getByText('New workspace in Beta'))
    const input = screen.getByLabelText('Branch name or Slack URL for Beta')
    fireEvent.change(input, { target: { value: 'my feature' } })
    fireEvent.click(await screen.findByText('Create “my-feature”'))

    expect(mocks.createWorkspace).toHaveBeenCalledWith({
      branchNameOrSlackUrl: 'my-feature',
      projectId: 'project-b',
    })
  })

  it('uses the same creation flow from the project picker', async () => {
    openPalette()

    fireEvent.click(screen.getByText('New workspace in...'))
    fireEvent.click(screen.getByText('Beta'))
    const input = screen.getByLabelText('Branch name or Slack URL for Beta')
    fireEvent.change(input, { target: { value: 'picked feature' } })
    fireEvent.click(await screen.findByText('Create “picked-feature”'))

    expect(mocks.createWorkspace).toHaveBeenCalledWith({
      branchNameOrSlackUrl: 'picked-feature',
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

  it('closes on Escape', async () => {
    openPalette()

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByText('New workspace in...')).toBeNull()
    })
  })
})

describe('CommandPalette workspace containment', () => {
  it('renders the palette and backdrop inside the focused workspace', () => {
    const unfocusedWorkspace = addVisibleWorkspaceContainer({
      workspaceId: 'workspace-a',
    })
    const focusedWorkspace = addVisibleWorkspaceContainer({
      workspaceId: 'workspace-b',
    })

    openPalette()

    const palette = screen.getByTestId('command-palette')
    const backdrop = document.querySelector(
      '[data-slot="command-dialog-backdrop"]'
    )
    const viewport = document.querySelector(
      '[data-slot="command-dialog-viewport"]'
    )

    expect(focusedWorkspace.contains(palette)).toBe(true)
    expect(focusedWorkspace.contains(backdrop)).toBe(true)
    expect(focusedWorkspace.contains(viewport)).toBe(true)
    expect(unfocusedWorkspace.contains(palette)).toBe(false)
    expect(backdrop?.classList.contains('absolute')).toBe(true)
    expect(backdrop?.classList.contains('fixed')).toBe(false)
    expect(viewport?.classList.contains('absolute')).toBe(true)
    expect(viewport?.classList.contains('fixed')).toBe(false)
  })

  it('uses the fullscreen workspace container when its focused pane is fullscreen', () => {
    const inlineWorkspace = addVisibleWorkspaceContainer({
      workspaceId: 'workspace-b',
    })
    const fullscreenWorkspace = addVisibleWorkspaceContainer({
      testId: 'fullscreen-workspace',
      workspaceId: 'workspace-a',
    })

    openPalette()

    const palette = screen.getByTestId('command-palette')
    expect(fullscreenWorkspace.contains(palette)).toBe(true)
    expect(inlineWorkspace.contains(palette)).toBe(false)
    expect(screen.getByText('New workspace in Alpha')).toBeDefined()
  })

  it('ignores a hidden copy of the focused workspace in an inactive window tab', () => {
    const hiddenWorkspace = document.createElement('div')
    hiddenWorkspace.dataset.testid = 'workspace-frame'
    hiddenWorkspace.dataset.workspaceOverlayContainer = 'frame'
    hiddenWorkspace.dataset.workspaceId = 'workspace-b'
    document.body.append(hiddenWorkspace)
    workspaceContainers.push(hiddenWorkspace)
    const visibleWorkspace = addVisibleWorkspaceContainer({
      workspaceId: 'workspace-b',
    })

    openPalette()

    const palette = screen.getByTestId('command-palette')
    expect(visibleWorkspace.contains(palette)).toBe(true)
    expect(hiddenWorkspace.contains(palette)).toBe(false)
  })

  it('uses the full-screen fallback for a minimized focused workspace', () => {
    const minimizedWorkspace = addVisibleWorkspaceContainer({
      workspaceId: 'workspace-b',
    })
    minimizedWorkspace.dataset.workspaceMinimized = 'true'

    openPalette()

    const palette = screen.getByTestId('command-palette')
    const viewport = document.querySelector(
      '[data-slot="command-dialog-viewport"]'
    )
    expect(minimizedWorkspace.contains(palette)).toBe(false)
    expect(viewport?.classList.contains('fixed')).toBe(true)
  })

  it('stays in the workspace where the palette was opened', () => {
    const focusedWorkspace = addVisibleWorkspaceContainer({
      workspaceId: 'workspace-b',
    })
    const nextWorkspace = addVisibleWorkspaceContainer({
      workspaceId: 'workspace-a',
    })
    const result = openPalette()

    mocks.activeWorkspaceId = 'workspace-a'
    result.rerender(<CommandPalette {...props} />)

    const palette = screen.getByTestId('command-palette')
    expect(focusedWorkspace.contains(palette)).toBe(true)
    expect(nextWorkspace.contains(palette)).toBe(false)
    expect(screen.getByText('New workspace in Beta')).toBeDefined()
  })

  it('keeps the full-screen fallback when no workspace is focused', () => {
    mocks.activeWorkspaceId = null

    openPalette()

    const backdrop = document.querySelector(
      '[data-slot="command-dialog-backdrop"]'
    )
    const viewport = document.querySelector(
      '[data-slot="command-dialog-viewport"]'
    )
    expect(backdrop?.classList.contains('fixed')).toBe(true)
    expect(viewport?.classList.contains('fixed')).toBe(true)
  })
})
