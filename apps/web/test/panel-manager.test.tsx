import type { PanelLeafNode } from '@laborer/shared/types'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalPaneWithSidebars } from '../src/panels/terminal-pane-with-sidebars'

vi.mock('@/panes/terminal-pane', () => ({
  TerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-pane">terminal:{terminalId}</div>
  ),
}))

function createTerminalLeaf(
  overrides: Partial<PanelLeafNode> = {}
): PanelLeafNode {
  return {
    _tag: 'PanelLeafNode',
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
  it('renders the terminal pane with the correct terminal ID', () => {
    const { getByText } = render(
      <TerminalPaneWithSidebars node={createTerminalLeaf()} />
    )

    expect(getByText('terminal:term-1')).toBeTruthy()
  })

  it('renders with a different terminal ID', () => {
    const { getByText } = render(
      <TerminalPaneWithSidebars
        node={createTerminalLeaf({ terminalId: 'term-42' })}
      />
    )

    expect(getByText('terminal:term-42')).toBeTruthy()
  })
})
