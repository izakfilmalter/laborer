import type { LeafNode, SplitNode } from '@laborer/shared/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { activePaneIdRef, pendingPickerPaneIdRef, setActivePaneIdMock } =
  vi.hoisted(() => ({
    activePaneIdRef: { current: null as string | null },
    pendingPickerPaneIdRef: { current: null as string | null },
    setActivePaneIdMock: vi.fn(),
  }))

vi.mock('@laborer/ui/components/resizable', () => ({
  ResizableHandle: () => <div data-testid="resizable-handle" />,
  ResizablePanel: ({
    children,
    id,
  }: {
    children: React.ReactNode
    id?: string
    defaultSize?: string
    minSize?: string
  }) => (
    <div data-panel-id={id} data-testid="resizable-panel">
      {children}
    </div>
  ),
  ResizablePanelGroup: ({
    children,
    orientation,
  }: {
    children: React.ReactNode
    orientation: 'horizontal' | 'vertical'
    groupRef?: unknown
  }) => <div data-orientation={orientation}>{children}</div>,
}))

vi.mock('@/panes/terminal-pane', () => ({
  TerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div>
      <div>terminal:{terminalId}</div>
      <canvas data-testid={`terminal-canvas-${terminalId}`} />
      <textarea data-testid={`terminal-input-${terminalId}`} />
    </div>
  ),
}))

vi.mock('@/panels/panel-context', () => ({
  useActivePaneId: () => activePaneIdRef.current,
  useFullscreenPaneId: () => null,
  useFullscreenPortal: () => null,
  usePanelActions: () => ({
    setActivePaneId: setActivePaneIdMock,
  }),
  usePendingClosePane: () => ({
    paneId: null,
    onConfirm: () => undefined,
    onCancel: () => undefined,
  }),
  usePendingPicker: () => ({
    paneId: pendingPickerPaneIdRef.current,
    isPlaceholderPane: pendingPickerPaneIdRef.current !== null,
    onSelect: () => undefined,
    onCancel: () => undefined,
  }),
}))

vi.mock('@/panels/panel-group-registry', () => ({
  usePanelGroupRegistry: () => null,
}))

vi.mock('@/routes/-components/close-dialogs', () => ({
  PaneCloseConfirmDialog: () => null,
}))

vi.mock('@/components/panel-type-picker', () => ({
  PanelTypePicker: () => (
    <div data-testid="panel-type-picker" role="listbox" tabIndex={0} />
  ),
}))

// Mock the store and atom hooks used by EmptyTerminalPane / EmptyDevServerPane

vi.mock('@/hooks/use-spawn-terminal', () => ({
  useSpawnTerminal: () => vi.fn(),
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn() },
}))

vi.mock('@laborer/ui/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}))

vi.mock('@/lib/errors', () => ({
  extractErrorMessage: (e: unknown) => String(e),
}))

// ---------- Fixtures ----------

function createTerminalLeaf(overrides: Partial<LeafNode> = {}): LeafNode {
  return {
    _tag: 'LeafNode',
    id: 'pane-1',
    paneType: 'terminal',
    terminalId: 'term-1',
    workspaceId: 'ws-1',
    ...overrides,
  }
}

function createSplitNode(overrides: Partial<SplitNode> = {}): SplitNode {
  return {
    _tag: 'SplitNode',
    id: 'split-1',
    direction: 'horizontal',
    children: [
      createTerminalLeaf({ id: 'pane-1', terminalId: 'term-1' }),
      createTerminalLeaf({ id: 'pane-2', terminalId: 'term-2' }),
    ],
    sizes: [50, 50],
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  activePaneIdRef.current = null
  pendingPickerPaneIdRef.current = null
  setActivePaneIdMock.mockReset()
})

// ---------- PanelManager tests ----------

// Lazy import to ensure mocks are set up first
const { PanelManager, PanelRenderer } = await import(
  '../src/panels/panel-manager'
)

describe('PanelManager', () => {
  it('renders empty state when layout is undefined', () => {
    render(<PanelManager />)
    expect(screen.getByText('No panels')).toBeTruthy()
  })

  it('accepts PanelNode directly without conversion', () => {
    const leaf = createTerminalLeaf()
    render(<PanelManager layout={leaf} />)
    expect(screen.getByText('terminal:term-1')).toBeTruthy()
  })
})

describe('PanelRenderer', () => {
  it('renders a single LeafNode with terminal content', () => {
    const leaf = createTerminalLeaf()
    render(<PanelRenderer node={leaf} />)
    expect(screen.getByText('terminal:term-1')).toBeTruthy()
  })

  it('focuses the terminal textarea for the active pane', () => {
    activePaneIdRef.current = 'pane-1'

    render(<PanelRenderer node={createTerminalLeaf()} />)

    expect(document.activeElement).toBe(
      screen.getByTestId('terminal-input-term-1')
    )
  })

  it('re-focuses the active pane when a terminal is assigned after render', () => {
    activePaneIdRef.current = 'pane-1'

    const { rerender } = render(
      <PanelRenderer node={createTerminalLeaf({ terminalId: undefined })} />
    )

    const pane = document.querySelector<HTMLElement>('[data-pane-id="pane-1"]')
    expect(document.activeElement).toBe(pane)

    rerender(<PanelRenderer node={createTerminalLeaf()} />)

    expect(document.activeElement).toBe(
      screen.getByTestId('terminal-input-term-1')
    )
  })

  it('renders SplitNode with two children in horizontal layout', () => {
    const split = createSplitNode()
    render(<PanelRenderer node={split} />)

    const group = document.querySelector('[data-orientation="horizontal"]')
    expect(group).toBeTruthy()

    const panels = screen.getAllByTestId('resizable-panel')
    expect(panels).toHaveLength(2)

    expect(screen.getByText('terminal:term-1')).toBeTruthy()
    expect(screen.getByText('terminal:term-2')).toBeTruthy()
  })

  it('renders SplitNode with vertical direction', () => {
    const split = createSplitNode({ direction: 'vertical' })
    render(<PanelRenderer node={split} />)

    const group = document.querySelector('[data-orientation="vertical"]')
    expect(group).toBeTruthy()
  })

  it('renders nested splits correctly', () => {
    const innerSplit = createSplitNode({
      id: 'inner-split',
      direction: 'vertical',
      children: [
        createTerminalLeaf({ id: 'pane-3', terminalId: 'term-3' }),
        createTerminalLeaf({ id: 'pane-4', terminalId: 'term-4' }),
      ],
    })
    const outerSplit: SplitNode = {
      _tag: 'SplitNode',
      id: 'outer-split',
      direction: 'horizontal',
      children: [
        createTerminalLeaf({ id: 'pane-1', terminalId: 'term-1' }),
        innerSplit,
      ],
      sizes: [50, 50],
    }

    render(<PanelRenderer node={outerSplit} />)

    // Outer horizontal + inner vertical
    const horizontalGroups = document.querySelectorAll(
      '[data-orientation="horizontal"]'
    )
    const verticalGroups = document.querySelectorAll(
      '[data-orientation="vertical"]'
    )
    expect(horizontalGroups).toHaveLength(1)
    expect(verticalGroups).toHaveLength(1)

    // All 3 terminals rendered
    expect(screen.getByText('terminal:term-1')).toBeTruthy()
    expect(screen.getByText('terminal:term-3')).toBeTruthy()
    expect(screen.getByText('terminal:term-4')).toBeTruthy()
  })

  it('renders empty terminal pane (no terminalId) with CTA', () => {
    const leaf = createTerminalLeaf({ terminalId: undefined })
    render(<PanelRenderer node={leaf} />)

    // EmptyTerminalPane initially shows "Starting terminal..." then after
    // timeout shows the CTA. Since no active workspaces are mocked, it
    // should show the CTA immediately.
    expect(screen.getByText('No terminal')).toBeTruthy()
  })

  it('dispatches on LeafNode _tag correctly', () => {
    const leaf: LeafNode = {
      _tag: 'LeafNode',
      id: 'leaf-1',
      paneType: 'terminal',
      terminalId: 'term-x',
      workspaceId: 'ws-1',
    }
    render(<PanelRenderer node={leaf} />)
    expect(screen.getByText('terminal:term-x')).toBeTruthy()
  })

  it('dispatches on SplitNode _tag correctly', () => {
    const split: SplitNode = {
      _tag: 'SplitNode',
      id: 'split-x',
      direction: 'horizontal',
      children: [
        createTerminalLeaf({ id: 'a', terminalId: 'ta' }),
        createTerminalLeaf({ id: 'b', terminalId: 'tb' }),
      ],
      sizes: [50, 50],
    }
    render(<PanelRenderer node={split} />)
    expect(screen.getByText('terminal:ta')).toBeTruthy()
    expect(screen.getByText('terminal:tb')).toBeTruthy()
  })

  it('does not mount pane content while the picker is open on its placeholder pane', () => {
    pendingPickerPaneIdRef.current = 'placeholder-pane'
    const leaf = createTerminalLeaf({
      id: 'placeholder-pane',
      terminalId: 'term-placeholder',
    })

    render(<PanelRenderer node={leaf} />)

    expect(screen.queryByText('terminal:term-placeholder')).toBeNull()
    expect(screen.getByTestId('panel-type-picker')).toBeTruthy()
  })

  it('refocuses the panel type picker when clicking its pane', () => {
    pendingPickerPaneIdRef.current = 'placeholder-pane'
    const leaf = createTerminalLeaf({
      id: 'placeholder-pane',
      terminalId: undefined,
    })

    render(
      <>
        <button type="button">Other focus target</button>
        <PanelRenderer node={leaf} />
      </>
    )
    screen.getByRole('button', { name: 'Other focus target' }).focus()

    const pickerContainer =
      screen.getByTestId('panel-type-picker').parentElement
    expect(pickerContainer).toBeTruthy()
    fireEvent.mouseDown(pickerContainer as HTMLElement)

    expect(document.activeElement).toBe(screen.getByTestId('panel-type-picker'))
  })

  it('activates the pane on mouse down inside its content', () => {
    const leaf = createTerminalLeaf({ id: 'pane-1', terminalId: 'term-1' })

    render(<PanelRenderer node={leaf} />)

    fireEvent.mouseDown(screen.getByText('terminal:term-1'))

    expect(setActivePaneIdMock).toHaveBeenCalledWith('pane-1')
  })
})
