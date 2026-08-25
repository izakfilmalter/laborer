import type { WindowLayout } from '@laborer/shared/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { cloneElement, isValidElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => undefined,
  dropTargetForElements: () => () => undefined,
  monitorForElements: () => () => undefined,
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine:
    (...cleanups: Array<() => void>) =>
    () => {
      for (const cleanupFn of cleanups) {
        cleanupFn()
      }
    },
}))

vi.mock('@laborer/ui/lib/haptics', async () => {
  const { createHapticsStub } = await import('./haptics-stub')
  return { haptics: createHapticsStub() }
})

vi.mock('@laborer/ui/components/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode
    render?: React.ReactElement
  }) =>
    render && isValidElement(render)
      ? cloneElement(render, render.props as Record<string, unknown>, children)
      : children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

import { PanelHeaderBar } from '../src/routes/-components/panel-header-bar'

const windowLayout: WindowLayout = {
  activeTabId: 'window-tab-active',
  tabs: [
    { id: 'window-tab-active', label: 'Active' },
    { id: 'window-tab-inactive', label: 'Inactive' },
  ],
}

afterEach(cleanup)

describe('PanelHeaderBar', () => {
  it('forwards the clicked window tab id when closing an inactive tab', () => {
    const onCloseWindowTab = vi.fn()
    const onSelectWindowTab = vi.fn()

    render(
      <PanelHeaderBar
        boardOpen={false}
        onCloseWindowTab={onCloseWindowTab}
        onSelectWindowTab={onSelectWindowTab}
        onToggleBoard={vi.fn()}
        windowLayout={windowLayout}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close Inactive' }))

    expect(onCloseWindowTab).toHaveBeenCalledWith('window-tab-inactive')
    expect(onSelectWindowTab).not.toHaveBeenCalled()
  })
})
