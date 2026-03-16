/**
 * Tests for the TabBar presentational component.
 *
 * Verifies auto-hide behavior, rendering of tab items, active tab indicator,
 * close and new tab button callbacks, keyboard accessibility, and dirty
 * indicator rendering.
 *
 * Drag-and-drop reorder is tested via the pure layout utility function tests;
 * actual DnD event simulation is limited in JSDOM.
 *
 * @see apps/web/src/components/ui/tab-bar.tsx
 * @see docs/tabbed-window-layout/issues.md — Issue #7
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be before component import
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

// Stub tooltip — the @base-ui/react tooltip uses a portal that isn't
// available in jsdom. Render trigger content directly.
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

// ---------------------------------------------------------------------------
// Import component under test AFTER mocks
// ---------------------------------------------------------------------------

import { TabBar, type TabBarItem } from '../src/components/ui/tab-bar'

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

function renderTabBar(
  items: readonly TabBarItem[],
  overrides: {
    autoHide?: boolean
    className?: string
    newTabTooltip?: string
    onClose?: (id: string) => void
    onNew?: () => void
    onReorder?: (fromIndex: number, toIndex: number) => void
    onSelect?: (id: string) => void
  } = {}
) {
  const onSelect = overrides.onSelect ?? vi.fn()
  const onClose = overrides.onClose ?? vi.fn()
  const onNew = overrides.onNew ?? vi.fn()
  const onReorder = overrides.onReorder ?? vi.fn()

  const result = render(
    <TabBar
      autoHide={overrides.autoHide}
      className={overrides.className}
      items={items}
      newTabTooltip={overrides.newTabTooltip}
      onClose={onClose}
      onNew={onNew}
      onReorder={onReorder}
      onSelect={onSelect}
    />
  )

  return { ...result, onSelect, onClose, onNew, onReorder }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup)

describe('TabBar', () => {
  // ---- Auto-hide behavior ----

  describe('auto-hide', () => {
    it('renders nothing when autoHide is true and there are 0 items', () => {
      renderTabBar([], { autoHide: true })
      expect(screen.queryByTestId('tab-bar')).toBeNull()
    })

    it('renders nothing when autoHide is true and there is 1 item', () => {
      renderTabBar([makeItem({ id: '1', isActive: true })], {
        autoHide: true,
      })
      expect(screen.queryByTestId('tab-bar')).toBeNull()
    })

    it('renders the tab bar when autoHide is true and there are 2+ items', () => {
      renderTabBar(
        [makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })],
        { autoHide: true }
      )
      expect(screen.getByTestId('tab-bar')).toBeTruthy()
    })

    it('renders the tab bar with 1 item when autoHide is false', () => {
      renderTabBar([makeItem({ id: '1', isActive: true })], {
        autoHide: false,
      })
      expect(screen.getByTestId('tab-bar')).toBeTruthy()
    })

    it('renders the tab bar with 0 items when autoHide is false', () => {
      renderTabBar([], { autoHide: false })
      expect(screen.getByTestId('tab-bar')).toBeTruthy()
    })

    it('defaults autoHide to false', () => {
      renderTabBar([makeItem({ id: '1', isActive: true })])
      expect(screen.getByTestId('tab-bar')).toBeTruthy()
    })
  })

  // ---- Rendering items ----

  describe('rendering items', () => {
    it('renders all tab items', () => {
      renderTabBar([
        makeItem({ id: '1', isActive: true }),
        makeItem({ id: '2' }),
        makeItem({ id: '3' }),
      ])
      const tabs = screen.getAllByTestId('tab-bar-tab')
      expect(tabs).toHaveLength(3)
    })

    it('renders tab labels', () => {
      renderTabBar([
        makeItem({ id: '1', label: 'Alpha', isActive: true }),
        makeItem({ id: '2', label: 'Beta' }),
      ])
      expect(screen.getByText('Alpha')).toBeTruthy()
      expect(screen.getByText('Beta')).toBeTruthy()
    })

    it('renders the active tab with aria-selected="true"', () => {
      renderTabBar([
        makeItem({ id: '1', isActive: true }),
        makeItem({ id: '2' }),
      ])
      const tabs = screen.getAllByRole('tab')
      expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
      expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    })

    it('renders dirty indicator when isDirty is true', () => {
      renderTabBar([
        makeItem({ id: '1', isActive: true, isDirty: true }),
        makeItem({ id: '2', isDirty: false }),
      ])
      const indicators = screen.queryAllByTitle('Unsaved changes')
      expect(indicators).toHaveLength(1)
    })

    it('does not render dirty indicator when isDirty is false or undefined', () => {
      renderTabBar([
        makeItem({ id: '1', isActive: true }),
        makeItem({ id: '2', isDirty: false }),
      ])
      const indicators = screen.queryAllByTitle('Unsaved changes')
      expect(indicators).toHaveLength(0)
    })

    it('renders the icon when provided', () => {
      const icon = <span data-testid="custom-icon">IC</span>
      renderTabBar([makeItem({ id: '1', isActive: true, icon })])
      expect(screen.getByTestId('custom-icon')).toBeTruthy()
    })
  })

  // ---- Callbacks ----

  describe('callbacks', () => {
    it('calls onSelect with correct id when a tab is clicked', () => {
      const { onSelect } = renderTabBar([
        makeItem({ id: '1', isActive: true }),
        makeItem({ id: '2' }),
      ])
      const tabs = screen.getAllByTestId('tab-bar-tab')
      const secondTab = tabs[1]
      expect(secondTab).toBeDefined()
      fireEvent.click(secondTab as HTMLElement)
      expect(onSelect).toHaveBeenCalledWith('2')
    })

    it('calls onClose with correct id when close button is clicked', () => {
      const { onClose } = renderTabBar([
        makeItem({ id: '1', label: 'Alpha', isActive: true }),
        makeItem({ id: '2', label: 'Beta' }),
      ])
      const closeButton = screen.getByLabelText('Close Beta')
      fireEvent.click(closeButton)
      expect(onClose).toHaveBeenCalledWith('2')
    })

    it('close button click does not trigger onSelect', () => {
      const { onSelect, onClose } = renderTabBar([
        makeItem({ id: '1', label: 'Alpha', isActive: true }),
        makeItem({ id: '2', label: 'Beta' }),
      ])
      const closeButton = screen.getByLabelText('Close Beta')
      fireEvent.click(closeButton)
      expect(onClose).toHaveBeenCalledWith('2')
      expect(onSelect).not.toHaveBeenCalled()
    })

    it('calls onNew when the new tab button is clicked', () => {
      const { onNew } = renderTabBar([makeItem({ id: '1', isActive: true })])
      const newButton = screen.getByLabelText('New tab')
      fireEvent.click(newButton)
      expect(onNew).toHaveBeenCalledOnce()
    })

    it('uses custom newTabTooltip as aria-label for the new button', () => {
      renderTabBar([makeItem({ id: '1', isActive: true })], {
        newTabTooltip: 'Add panel',
      })
      expect(screen.getByLabelText('Add panel')).toBeTruthy()
    })
  })

  // ---- Keyboard accessibility ----

  describe('keyboard accessibility', () => {
    it('tab bar has role="tablist"', () => {
      renderTabBar([makeItem({ id: '1', isActive: true })])
      expect(screen.getByRole('tablist')).toBeTruthy()
    })

    it('each tab item has role="tab"', () => {
      renderTabBar([
        makeItem({ id: '1', isActive: true }),
        makeItem({ id: '2' }),
      ])
      const tabs = screen.getAllByRole('tab')
      expect(tabs).toHaveLength(2)
    })

    it('active tab has tabIndex=0, inactive tabs have tabIndex=-1', () => {
      renderTabBar([
        makeItem({ id: '1', isActive: true }),
        makeItem({ id: '2' }),
        makeItem({ id: '3' }),
      ])
      const tabs = screen.getAllByRole('tab')
      expect(tabs[0]?.tabIndex).toBe(0)
      expect(tabs[1]?.tabIndex).toBe(-1)
      expect(tabs[2]?.tabIndex).toBe(-1)
    })

    it('Enter key on a tab triggers onSelect', () => {
      const { onSelect } = renderTabBar([
        makeItem({ id: '1', isActive: true }),
        makeItem({ id: '2' }),
      ])
      const tabs = screen.getAllByRole('tab')
      const secondTab = tabs[1]
      expect(secondTab).toBeDefined()
      fireEvent.keyDown(secondTab as HTMLElement, { key: 'Enter' })
      expect(onSelect).toHaveBeenCalledWith('2')
    })

    it('Space key on a tab triggers onSelect', () => {
      const { onSelect } = renderTabBar([
        makeItem({ id: '1', isActive: true }),
        makeItem({ id: '2' }),
      ])
      const tabs = screen.getAllByRole('tab')
      const secondTab = tabs[1]
      expect(secondTab).toBeDefined()
      fireEvent.keyDown(secondTab as HTMLElement, { key: ' ' })
      expect(onSelect).toHaveBeenCalledWith('2')
    })
  })

  // ---- Multiple tabs ----

  describe('multiple tabs', () => {
    it('renders close buttons for all tabs', () => {
      renderTabBar([
        makeItem({ id: '1', label: 'A', isActive: true }),
        makeItem({ id: '2', label: 'B' }),
        makeItem({ id: '3', label: 'C' }),
      ])
      expect(screen.getByLabelText('Close A')).toBeTruthy()
      expect(screen.getByLabelText('Close B')).toBeTruthy()
      expect(screen.getByLabelText('Close C')).toBeTruthy()
    })

    it('only one tab is aria-selected at a time', () => {
      renderTabBar([
        makeItem({ id: '1' }),
        makeItem({ id: '2', isActive: true }),
        makeItem({ id: '3' }),
      ])
      const tabs = screen.getAllByRole('tab')
      const selectedTabs = tabs.filter(
        (t) => t.getAttribute('aria-selected') === 'true'
      )
      expect(selectedTabs).toHaveLength(1)
    })
  })

  // ---- className prop ----

  describe('className prop', () => {
    it('applies additional className to the root element', () => {
      renderTabBar([makeItem({ id: '1', isActive: true })], {
        className: 'custom-class',
      })
      const tabBar = screen.getByTestId('tab-bar')
      expect(tabBar.className).toContain('custom-class')
    })
  })
})
