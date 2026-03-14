/**
 * Tests for visual indicator enhancements (Issue #26):
 * - Focused pane ring highlight
 * - Tab bar close button tooltips with keyboard shortcuts
 * - Tab shortcut hint titles
 * - Panel type picker keycap-styled number indicators
 *
 * @see docs/tabbed-window-layout/issues.md — Issue #26
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be before component imports
// ---------------------------------------------------------------------------

// Stub pragmatic-drag-and-drop to avoid native DnD in JSDOM
vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => undefined,
  dropTargetForElements: () => () => undefined,
  monitorForElements: () => () => undefined,
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine: (...fns: (() => void)[]) => {
    return () => {
      for (const fn of fns) {
        fn()
      }
    }
  },
}))

// Stub haptics to avoid web-haptics dependency in jsdom
vi.mock('@/lib/haptics', () => ({
  haptics: { buttonTap: vi.fn(), heavyImpact: vi.fn() },
}))

// Stub tooltip — render trigger and content inline for testing
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
    <span data-testid="tooltip-content">{children}</span>
  ),
}))

// ---------------------------------------------------------------------------
// Import components under test AFTER mocks
// ---------------------------------------------------------------------------

import { PanelTypePicker } from '../src/components/ui/panel-type-picker'
import type { TabBarItem } from '../src/components/ui/tab-bar'
import { TabBar } from '../src/components/ui/tab-bar'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<TabBarItem> & { id: string }): TabBarItem {
  return {
    label: `Tab ${overrides.id}`,
    isActive: false,
    ...overrides,
  }
}

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Tests: Tab bar close button tooltips
// ---------------------------------------------------------------------------

describe('Tab bar close button tooltips', () => {
  it('renders close button tooltip when closeTooltip is provided', () => {
    render(
      <TabBar
        closeTooltip="Close tab (Cmd+W)"
        items={[
          makeItem({ id: '1', label: 'Alpha', isActive: true }),
          makeItem({ id: '2', label: 'Beta' }),
        ]}
        onClose={vi.fn()}
        onNew={vi.fn()}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    const tooltips = screen.getAllByTestId('tooltip-content')
    const closeTooltips = tooltips.filter(
      (t) => t.textContent === 'Close tab (Cmd+W)'
    )
    // One per tab (2 tabs)
    expect(closeTooltips.length).toBe(2)
  })

  it('renders close button without tooltip when closeTooltip is not provided', () => {
    render(
      <TabBar
        items={[
          makeItem({ id: '1', label: 'Alpha', isActive: true }),
          makeItem({ id: '2', label: 'Beta' }),
        ]}
        onClose={vi.fn()}
        onNew={vi.fn()}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    // Close buttons have aria-labels
    expect(screen.getByLabelText('Close Alpha')).toBeTruthy()
    expect(screen.getByLabelText('Close Beta')).toBeTruthy()
    // No close tooltip content (only the new tab tooltip should exist)
    const tooltips = screen.getAllByTestId('tooltip-content')
    const closeTooltips = tooltips.filter((t) =>
      t.textContent?.includes('Close')
    )
    expect(closeTooltips.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: Tab shortcut hints
// ---------------------------------------------------------------------------

describe('Tab shortcut hints', () => {
  it('renders title attribute with shortcutHint on tab', () => {
    render(
      <TabBar
        items={[
          makeItem({
            id: '1',
            label: 'First',
            isActive: true,
            shortcutHint: 'Cmd+1',
          }),
          makeItem({ id: '2', label: 'Second', shortcutHint: 'Cmd+2' }),
        ]}
        onClose={vi.fn()}
        onNew={vi.fn()}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    const tabs = screen.getAllByTestId('tab-bar-tab')
    expect(tabs[0]?.getAttribute('title')).toBe('Cmd+1')
    expect(tabs[1]?.getAttribute('title')).toBe('Cmd+2')
  })

  it('does not render title when shortcutHint is undefined', () => {
    render(
      <TabBar
        items={[makeItem({ id: '1', label: 'First', isActive: true })]}
        onClose={vi.fn()}
        onNew={vi.fn()}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    const tabs = screen.getAllByTestId('tab-bar-tab')
    expect(tabs[0]?.getAttribute('title')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tests: Panel type picker keycap numbers
// ---------------------------------------------------------------------------

describe('Panel type picker keycap numbers', () => {
  it('renders number indicators as <kbd> elements', () => {
    render(<PanelTypePicker onCancel={vi.fn()} onSelect={vi.fn()} />)
    const picker = screen.getByTestId('panel-type-picker')
    const kbdElements = picker.querySelectorAll('kbd')
    expect(kbdElements.length).toBe(4)
    expect(kbdElements[0]?.textContent).toBe('1')
    expect(kbdElements[1]?.textContent).toBe('2')
    expect(kbdElements[2]?.textContent).toBe('3')
    expect(kbdElements[3]?.textContent).toBe('4')
  })

  it('keycap numbers have border styling for prominence', () => {
    render(<PanelTypePicker onCancel={vi.fn()} onSelect={vi.fn()} />)
    const picker = screen.getByTestId('panel-type-picker')
    const kbd = picker.querySelector('kbd')
    expect(kbd).toBeTruthy()
    // Check that the kbd element has the border and font-mono classes
    const classes = kbd?.className ?? ''
    expect(classes).toContain('border')
    expect(classes).toContain('font-mono')
  })
})
