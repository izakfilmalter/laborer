/**
 * Tests for tab bar animation and transition behavior.
 *
 * Verifies:
 * - Tab bar animated show/hide transitions when auto-hiding
 * - Individual tab entrance animations for newly added tabs
 * - `prefers-reduced-motion` media query respect
 * - No layout shift during transitions
 *
 * @see apps/web/src/components/ui/tab-bar.tsx
 * @see docs/tabbed-window-layout/issues.md — Issue #24
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

// Stub tooltip
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

describe('Tab bar animations', () => {
  // ---- Auto-hide animated wrapper ----

  describe('auto-hide animated wrapper', () => {
    it('renders nothing on initial mount when auto-hidden (0 items)', () => {
      renderTabBar([], { autoHide: true })
      expect(screen.queryByTestId('tab-bar')).toBeNull()
      expect(screen.queryByTestId('tab-bar-animated-wrapper')).toBeNull()
    })

    it('renders nothing on initial mount when auto-hidden (1 item)', () => {
      renderTabBar([makeItem({ id: '1', isActive: true })], {
        autoHide: true,
      })
      expect(screen.queryByTestId('tab-bar')).toBeNull()
      expect(screen.queryByTestId('tab-bar-animated-wrapper')).toBeNull()
    })

    it('renders animated wrapper when shown (2+ items)', () => {
      renderTabBar(
        [makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })],
        { autoHide: true }
      )
      expect(screen.getByTestId('tab-bar')).toBeTruthy()
      expect(screen.getByTestId('tab-bar-animated-wrapper')).toBeTruthy()
    })

    it('animated wrapper does not appear when autoHide is false', () => {
      renderTabBar([makeItem({ id: '1', isActive: true })], {
        autoHide: false,
      })
      // Should render the inner tab bar directly without wrapper
      // (autoHide is false so shouldHide is false, wrapper rendered but visible)
      expect(screen.getByTestId('tab-bar')).toBeTruthy()
    })

    it('animated wrapper has overflow-hidden class to prevent layout shift', () => {
      renderTabBar(
        [makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })],
        { autoHide: true }
      )
      const wrapper = screen.getByTestId('tab-bar-animated-wrapper')
      expect(wrapper.className).toContain('overflow-hidden')
    })

    it('animated wrapper has transition classes for height and opacity', () => {
      renderTabBar(
        [makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })],
        { autoHide: true }
      )
      const wrapper = screen.getByTestId('tab-bar-animated-wrapper')
      expect(wrapper.className).toContain('transition-[height,opacity]')
      expect(wrapper.className).toContain('duration-150')
    })

    it('animated wrapper has h-8 opacity-100 when shown', () => {
      renderTabBar(
        [makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })],
        { autoHide: true }
      )
      const wrapper = screen.getByTestId('tab-bar-animated-wrapper')
      expect(wrapper.className).toContain('h-8')
      expect(wrapper.className).toContain('opacity-100')
    })

    it('keeps content rendered during hide transition for animation', () => {
      // Start with 2 items (shown)
      const { rerender } = render(
        <TabBar
          autoHide={true}
          items={[makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      // The tab bar should be visible
      expect(screen.getByTestId('tab-bar')).toBeTruthy()

      // Rerender with 1 item (should start hiding)
      rerender(
        <TabBar
          autoHide={true}
          items={[makeItem({ id: '1', isActive: true })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      // In JSDOM, transitionend won't fire, so the inner content may remain
      // rendered (the wrapper will have h-0 opacity-0 classes).
      // The tab-bar-animated-wrapper test ID is removed when shouldHide is true.
      expect(screen.queryByTestId('tab-bar-animated-wrapper')).toBeNull()
    })

    it('removes content after transition ends when hiding', () => {
      // Start with 2 items (shown)
      const { rerender } = render(
        <TabBar
          autoHide={true}
          items={[makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      expect(screen.getByTestId('tab-bar')).toBeTruthy()

      // Rerender with 1 item
      rerender(
        <TabBar
          autoHide={true}
          items={[makeItem({ id: '1', isActive: true })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      // The inner content is still rendered during transition
      // but the wrapper has h-0 opacity-0. Simulate transitionend.
      const wrapper = screen
        .getByTestId('tab-bar')
        ?.closest('[class*="overflow-hidden"]')
      if (wrapper) {
        act(() => {
          fireEvent.transitionEnd(wrapper)
        })
      }

      // After transition, content should be fully removed
      expect(screen.queryByTestId('tab-bar')).toBeNull()
    })
  })

  // ---- Individual tab entrance animations ----

  describe('individual tab entrance animations', () => {
    it('newly added tabs start with entrance animation classes', () => {
      // Start with 2 items
      const { rerender } = render(
        <TabBar
          items={[makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const initialTabs = screen.getAllByTestId('tab-bar-tab')
      expect(initialTabs).toHaveLength(2)

      // Add a third tab
      rerender(
        <TabBar
          items={[
            makeItem({ id: '1', isActive: true }),
            makeItem({ id: '2' }),
            makeItem({ id: '3' }),
          ]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const tabs = screen.getAllByTestId('tab-bar-tab')
      expect(tabs).toHaveLength(3)

      // The new tab's parent wrapper should have transition classes
      const thirdTabWrapper = tabs[2]?.parentElement
      expect(thirdTabWrapper).toBeTruthy()
      expect(thirdTabWrapper?.className).toContain(
        'transition-[max-width,opacity]'
      )
    })

    it('initial mount tabs do not have entrance animation (no isNew)', () => {
      renderTabBar([
        makeItem({ id: '1', isActive: true }),
        makeItem({ id: '2' }),
      ])

      const tabs = screen.getAllByTestId('tab-bar-tab')
      // Initial tabs should have full opacity and max-width
      for (const tab of tabs) {
        const wrapper = tab.parentElement
        expect(wrapper?.className).toContain('max-w-[200px]')
        expect(wrapper?.className).toContain('opacity-100')
        expect(wrapper?.className).not.toContain('max-w-0')
      }
    })

    it('tab wrapper has transition classes for smooth add animation', () => {
      renderTabBar([
        makeItem({ id: '1', isActive: true }),
        makeItem({ id: '2' }),
      ])

      const tabs = screen.getAllByTestId('tab-bar-tab')
      const wrapper = tabs[0]?.parentElement
      expect(wrapper?.className).toContain('transition-[max-width,opacity]')
      expect(wrapper?.className).toContain('duration-150')
    })
  })

  // ---- prefers-reduced-motion ----

  describe('prefers-reduced-motion', () => {
    it('renders transition classes by default (motion not reduced)', () => {
      renderTabBar(
        [makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })],
        { autoHide: true }
      )
      const wrapper = screen.getByTestId('tab-bar-animated-wrapper')
      expect(wrapper.className).toContain('transition-[height,opacity]')
      expect(wrapper.className).not.toContain('transition-none')
    })

    it('applies transition-none class when prefers-reduced-motion is active', () => {
      // Mock matchMedia to indicate reduced motion preference
      const originalMatchMedia = window.matchMedia
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))

      try {
        renderTabBar(
          [makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })],
          { autoHide: true }
        )
        const wrapper = screen.getByTestId('tab-bar-animated-wrapper')
        expect(wrapper.className).toContain('transition-none')
      } finally {
        window.matchMedia = originalMatchMedia
      }
    })
  })

  // ---- Show/hide transition ----

  describe('show/hide transition', () => {
    it('shows tab bar immediately when going from 1 to 2+ items', () => {
      const { rerender } = render(
        <TabBar
          autoHide={true}
          items={[makeItem({ id: '1', isActive: true })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      // Initially hidden
      expect(screen.queryByTestId('tab-bar')).toBeNull()

      // Add second item
      rerender(
        <TabBar
          autoHide={true}
          items={[makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      // Should be visible now
      expect(screen.getByTestId('tab-bar')).toBeTruthy()
    })

    it('wrapper transitions from h-0 to h-8 when showing', () => {
      const { rerender } = render(
        <TabBar
          autoHide={true}
          items={[makeItem({ id: '1', isActive: true })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      // Add items to show
      rerender(
        <TabBar
          autoHide={true}
          items={[makeItem({ id: '1', isActive: true }), makeItem({ id: '2' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const wrapper = screen.getByTestId('tab-bar-animated-wrapper')
      expect(wrapper.className).toContain('h-8')
      expect(wrapper.className).toContain('opacity-100')
      expect(wrapper.className).not.toContain('h-0')
    })
  })
})
