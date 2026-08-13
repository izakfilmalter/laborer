import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/kbd', () => ({
  Kbd: ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>,
}))

import {
  FullscreenPortalContext,
  type PanelActions,
  PanelActionsProvider,
} from '../src/panels/panel-context'
import {
  PanelTabCloseConfirmDialog,
  WindowTabCloseConfirmDialog,
  WorkspaceCloseConfirmDialog,
  WorkspaceDestroyOnCloseConfirmDialog,
} from '../src/routes/-components/close-dialogs'

function makeActions(): PanelActions {
  return {
    addPanelTab: vi.fn(),
    addWindowTab: vi.fn(),
    addWorkspaceToCurrentTab: vi.fn(),
    assignTerminalToPane: vi.fn(),
    closePane: vi.fn(),
    closeTerminalPane: vi.fn(),
    closeWindowTab: vi.fn(),
    closeWorkspace: vi.fn(),
    forceCloseWorkspace: vi.fn(),
    removePanelTab: vi.fn(),
    renameWindowTab: vi.fn(),
    reorderPanelTabsDnd: vi.fn(),
    reorderWindowTabsDnd: vi.fn(),
    reorderWorkspaces: vi.fn(),
    resizePane: vi.fn(),
    setActivePaneId: vi.fn(),
    showPanelTypePicker: vi.fn(),
    splitPane: vi.fn(),
    switchPanelTab: vi.fn(),
    switchPanelTabByIndex: vi.fn(),
    switchPanelTabRelative: vi.fn(),
    switchWindowTab: vi.fn(),
    switchWindowTabByIndex: vi.fn(),
    switchWindowTabRelative: vi.fn(),
    toggleDevServerPane: vi.fn(async () => false),
    toggleDiffPane: vi.fn(() => false),
    toggleFullscreenPane: vi.fn(),
    toggleTreePane: vi.fn(() => false),
    updatePaneType: vi.fn(),
    windowLayout: undefined,
  }
}

function DialogHarness({
  children,
  fullscreenPaneId = null,
}: {
  readonly children: React.ReactNode
  readonly fullscreenPaneId?: string | null
}) {
  const [portalElement, setPortalElement] = useState<HTMLElement | null>(null)

  return (
    <PanelActionsProvider
      activePaneId={null}
      fullscreenPaneId={fullscreenPaneId}
      value={makeActions()}
    >
      <FullscreenPortalContext.Provider value={portalElement}>
        <div data-testid="normal-tree">{children}</div>
        <div data-testid="fullscreen-container" ref={setPortalElement} />
      </FullscreenPortalContext.Provider>
    </PanelActionsProvider>
  )
}

const fullscreenAwareDialogs = [
  {
    label: 'panel tab',
    renderDialog: () => (
      <PanelTabCloseConfirmDialog onCancel={vi.fn()} onConfirm={vi.fn()} />
    ),
  },
  {
    label: 'workspace',
    renderDialog: () => (
      <WorkspaceCloseConfirmDialog onCancel={vi.fn()} onConfirm={vi.fn()} />
    ),
  },
  {
    label: 'window tab',
    renderDialog: () => (
      <WindowTabCloseConfirmDialog onCancel={vi.fn()} onConfirm={vi.fn()} />
    ),
  },
  {
    label: 'destroy workspace',
    renderDialog: () => (
      <WorkspaceDestroyOnCloseConfirmDialog
        onCancel={vi.fn()}
        onCloseAndDestroy={vi.fn()}
        onConfirm={vi.fn()}
      />
    ),
  },
] as const

describe('fullscreen-aware close dialogs', () => {
  afterEach(() => {
    cleanup()
  })

  it('keeps the panel-tab dialog inline when no pane is fullscreened', () => {
    render(
      <DialogHarness>
        <PanelTabCloseConfirmDialog onCancel={vi.fn()} onConfirm={vi.fn()} />
      </DialogHarness>
    )

    const dialog = screen.getByRole('alertdialog')
    const normalTree = screen.getByTestId('normal-tree')
    const fullscreenContainer = screen.getByTestId('fullscreen-container')

    expect(normalTree.contains(dialog)).toBe(true)
    expect(fullscreenContainer.contains(dialog)).toBe(false)
  })

  it.each(
    fullscreenAwareDialogs
  )('portals the $label dialog into the fullscreen container', async ({
    renderDialog,
  }) => {
    render(
      <DialogHarness fullscreenPaneId="pane-1">{renderDialog()}</DialogHarness>
    )

    const fullscreenContainer = screen.getByTestId('fullscreen-container')

    await waitFor(() => {
      expect(
        fullscreenContainer.contains(screen.getByRole('alertdialog'))
      ).toBe(true)
    })
  })
})
