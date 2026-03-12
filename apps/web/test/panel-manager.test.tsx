import type { LeafNode } from '@laborer/shared/types'
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalPaneWithSidebars } from '../src/panels/terminal-pane-with-sidebars'

vi.mock('@/hooks/use-responsive-layout', () => ({
  useResponsiveLayout: () => ({
    paneMin: '10%',
  }),
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizableHandle: () => <div data-testid="resizable-handle" />,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizablePanelGroup: ({
    children,
    orientation,
  }: {
    children: React.ReactNode
    orientation: 'horizontal' | 'vertical'
  }) => <div data-orientation={orientation}>{children}</div>,
}))

vi.mock('@/panes/terminal-pane', () => ({
  TerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div>terminal:{terminalId}</div>
  ),
}))

vi.mock('@/panes/diff-pane', () => ({
  DiffPane: ({ workspaceId }: { workspaceId: string }) => (
    <div>diff:{workspaceId}</div>
  ),
}))

vi.mock('@/panes/dev-server-terminal-pane', () => ({
  DevServerTerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div>dev-server:{terminalId}</div>
  ),
}))

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

afterEach(() => {
  cleanup()
})

describe('TerminalPaneWithSidebars', () => {
  it('renders the dev server terminal to the right of the terminal', () => {
    render(
      <TerminalPaneWithSidebars
        node={createTerminalLeaf({
          devServerOpen: true,
          devServerTerminalId: 'dev-1',
        })}
      />
    )

    const groups = Array.from(document.querySelectorAll('[data-orientation]'))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('data-orientation')).toBe('horizontal')

    const group = groups[0] as HTMLElement
    expect(within(group).getByText('terminal:term-1')).toBeTruthy()
    expect(within(group).getByText('dev-server:dev-1')).toBeTruthy()
  })

  it('stacks diff above dev server in the right sidebar when both are open', () => {
    render(
      <TerminalPaneWithSidebars
        node={createTerminalLeaf({
          devServerOpen: true,
          devServerTerminalId: 'dev-1',
          diffOpen: true,
        })}
      />
    )

    const groups = Array.from(document.querySelectorAll('[data-orientation]'))
    expect(groups).toHaveLength(2)
    expect(groups[0]?.getAttribute('data-orientation')).toBe('horizontal')
    expect(groups[1]?.getAttribute('data-orientation')).toBe('vertical')

    const horizontalGroup = groups[0] as HTMLElement
    const verticalGroup = groups[1] as HTMLElement

    expect(within(horizontalGroup).getByText('terminal:term-1')).toBeTruthy()
    expect(within(verticalGroup).getByText('diff:ws-1')).toBeTruthy()
    expect(within(verticalGroup).getByText('dev-server:dev-1')).toBeTruthy()
  })
})
