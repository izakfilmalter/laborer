/**
 * The "Remove project?" confirmation carries the same keyboard contract as the
 * destroy-workspace dialog: Escape cancels, plain Enter does nothing, and
 * Cmd+Enter confirms.
 *
 * @see apps/web/src/components/project-group.tsx
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { removeProjectMock, useAtomSetMock } = vi.hoisted(() => ({
  removeProjectMock: vi.fn(() => Promise.resolve()),
  useAtomSetMock: vi.fn(),
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: { mutation: vi.fn(() => 'project.remove-atom') },
}))

vi.mock('@/atoms/shared-state', () => ({
  clearProjectRemoveOverlayAtom: 'clear-overlay',
  installProjectRemoveOverlayAtom: 'install-overlay',
}))

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: useAtomSetMock,
}))

vi.mock('@/hooks/use-when-phase', () => ({
  useWhenPhase: () => true,
}))

vi.mock('@/components/project-reorder', () => ({
  ProjectDragHandle: () => null,
  ProjectDropIndicator: () => null,
  useProjectDragItem: () => ({ closestEdge: null, isDragging: false }),
}))

vi.mock('@/components/project-settings-modal', () => ({
  ProjectSettingsModal: () => null,
}))

vi.mock('@/components/create-workspace-composer', () => ({
  CreateWorkspaceButton: () => null,
  CreateWorkspaceComposer: () => null,
}))

vi.mock('@/components/workspace-list', () => ({
  WorkspaceList: () => null,
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { ProjectGroup } from '../src/components/project-group'

const project = { id: 'p1', name: 'laborer', repoPath: '/tmp/laborer' }
const CANCEL_RE = /cancel/i
const CONFIRM_RE = /^Remove/

function renderGroup() {
  return render(
    <ProjectGroup
      expanded={false}
      index={0}
      onToggle={() => undefined}
      project={project}
      reorderEnabled={false}
    />
  )
}

async function openDialog() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Remove project laborer' })
  )
  return await screen.findByRole('alertdialog')
}

describe('ProjectGroup remove dialog keyboard shortcuts', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useAtomSetMock.mockImplementation((atom: string) =>
      atom === 'project.remove-atom' ? removeProjectMock : vi.fn()
    )
  })

  it('confirms removal on Cmd+Enter', async () => {
    renderGroup()
    const dialog = await openDialog()

    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true })

    expect(removeProjectMock).toHaveBeenCalledWith({
      payload: { projectId: 'p1' },
    })
  })

  it('ignores a plain Enter press', async () => {
    renderGroup()
    const dialog = await openDialog()

    fireEvent.keyDown(dialog, { key: 'Enter' })

    expect(removeProjectMock).not.toHaveBeenCalled()
  })

  it('cancels on Escape without removing the project', async () => {
    renderGroup()
    const dialog = await openDialog()

    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(removeProjectMock).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
  })

  it('labels both actions with their shortcuts', async () => {
    renderGroup()
    await openDialog()

    expect(
      screen.getByRole('button', { name: CANCEL_RE }).textContent
    ).toContain('Esc')
    const confirm = screen.getByRole('button', { name: CONFIRM_RE })
    expect(confirm.textContent).toContain('⌘')
    expect(confirm.textContent).toContain('↵')
  })
})
