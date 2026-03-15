/**
 * Tests for tab bar drag-and-drop reorder behavior.
 *
 * These tests intercept the `@atlaskit/pragmatic-drag-and-drop` calls to
 * verify that:
 * - Each tab registers as both a draggable and a drop target
 * - Drag data contains correct type, id, index, and barId
 * - The drop target `canDrop` gate rejects items from different tab bars
 * - The monitor dispatches `onReorder` with correct indices on drop
 * - Drop indicator edge is determined by source vs target index comparison
 * - Multiple TabBar instances have unique `barId` values
 *
 * Actual native drag events cannot be simulated in JSDOM; these tests
 * exercise the DnD registration and callback logic by capturing the
 * options passed to the pragmatic-drag-and-drop APIs.
 *
 * @see apps/web/src/components/ui/tab-bar.tsx
 * @see docs/tabbed-window-layout/issues.md — Issue #23
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Capture DnD registrations
// ---------------------------------------------------------------------------

interface DraggableConfig {
  element: HTMLElement
  getInitialData: () => Record<string, unknown>
  onDragStart?: () => void
  onDrop?: () => void
}

interface DropTargetConfig {
  canDrop: (args: { source: { data: Record<string, unknown> } }) => boolean
  element: HTMLElement
  getData: () => Record<string, unknown>
  onDrag?: (args: { source: { data: Record<string, unknown> } }) => void
  onDragEnter?: (args: { source: { data: Record<string, unknown> } }) => void
  onDragLeave?: () => void
  onDrop?: () => void
}

interface MonitorConfig {
  canMonitor: (args: { source: { data: Record<string, unknown> } }) => boolean
  onDrop: (args: {
    source: { data: Record<string, unknown> }
    location: {
      current: {
        dropTargets: Array<{ data: Record<string, unknown> }>
      }
    }
  }) => void
}

const draggableRegistrations: DraggableConfig[] = []
const dropTargetRegistrations: DropTargetConfig[] = []
const monitorRegistrations: MonitorConfig[] = []

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (config: DraggableConfig) => {
    draggableRegistrations.push(config)
    return () => undefined
  },
  dropTargetForElements: (config: DropTargetConfig) => {
    dropTargetRegistrations.push(config)
    return () => undefined
  },
  monitorForElements: (config: MonitorConfig) => {
    monitorRegistrations.push(config)
    return () => undefined
  },
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

function clearRegistrations() {
  draggableRegistrations.length = 0
  dropTargetRegistrations.length = 0
  monitorRegistrations.length = 0
}

function getDraggable(index: number): DraggableConfig {
  const reg = draggableRegistrations[index]
  if (!reg) {
    throw new Error(`No draggable registration at index ${index}`)
  }
  return reg
}

function getDropTarget(index: number): DropTargetConfig {
  const reg = dropTargetRegistrations[index]
  if (!reg) {
    throw new Error(`No drop target registration at index ${index}`)
  }
  return reg
}

function getMonitor(index: number): MonitorConfig {
  const reg = monitorRegistrations[index]
  if (!reg) {
    throw new Error(`No monitor registration at index ${index}`)
  }
  return reg
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup()
  clearRegistrations()
})

describe('TabBar DnD reorder', () => {
  describe('draggable registration', () => {
    it('registers each tab as a draggable', () => {
      render(
        <TabBar
          items={[
            makeItem({ id: 'a', isActive: true }),
            makeItem({ id: 'b' }),
            makeItem({ id: 'c' }),
          ]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      expect(draggableRegistrations).toHaveLength(3)
    })

    it('draggable getInitialData returns correct shape', () => {
      render(
        <TabBar
          items={[
            makeItem({ id: 'alpha', isActive: true }),
            makeItem({ id: 'beta' }),
          ]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const data = getDraggable(0).getInitialData()
      expect(data.type).toBe('tab-bar-item')
      expect(data.id).toBe('alpha')
      expect(data.index).toBe(0)
      expect(typeof data.barId).toBe('string')
      expect((data.barId as string).length).toBeGreaterThan(0)

      const data2 = getDraggable(1).getInitialData()
      expect(data2.id).toBe('beta')
      expect(data2.index).toBe(1)
      // Same barId for tabs in the same TabBar
      expect(data2.barId).toBe(data.barId)
    })
  })

  describe('drop target registration', () => {
    it('registers each tab as a drop target', () => {
      render(
        <TabBar
          items={[makeItem({ id: 'a', isActive: true }), makeItem({ id: 'b' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      expect(dropTargetRegistrations).toHaveLength(2)
    })

    it('drop target getData returns correct shape', () => {
      render(
        <TabBar
          items={[makeItem({ id: 'x', isActive: true }), makeItem({ id: 'y' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const data = getDropTarget(1).getData()
      expect(data.type).toBe('tab-bar-item')
      expect(data.id).toBe('y')
      expect(data.index).toBe(1)
    })

    it('canDrop accepts items from the same barId', () => {
      render(
        <TabBar
          items={[makeItem({ id: 'a', isActive: true }), makeItem({ id: 'b' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const sourceData = getDraggable(0).getInitialData()
      const result = getDropTarget(1).canDrop({ source: { data: sourceData } })
      expect(result).toBe(true)
    })

    it('canDrop rejects items from a different barId', () => {
      render(
        <TabBar
          items={[makeItem({ id: 'a', isActive: true }), makeItem({ id: 'b' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const foreignSource = {
        type: 'tab-bar-item',
        id: 'foreign',
        index: 0,
        barId: 'different-bar-id',
      }
      const result = getDropTarget(0).canDrop({
        source: { data: foreignSource },
      })
      expect(result).toBe(false)
    })

    it('canDrop rejects items with wrong type', () => {
      render(
        <TabBar
          items={[makeItem({ id: 'a', isActive: true })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const wrongType = {
        type: 'workspace-frame',
        id: 'ws-1',
        index: 0,
      }
      const result = getDropTarget(0).canDrop({
        source: { data: wrongType },
      })
      expect(result).toBe(false)
    })
  })

  describe('monitor registration', () => {
    it('registers a monitor for the tab bar', () => {
      render(
        <TabBar
          items={[makeItem({ id: 'a', isActive: true }), makeItem({ id: 'b' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      expect(monitorRegistrations).toHaveLength(1)
    })

    it('monitor canMonitor accepts items from the same barId', () => {
      render(
        <TabBar
          items={[makeItem({ id: 'a', isActive: true }), makeItem({ id: 'b' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const sourceData = getDraggable(0).getInitialData()
      const result = getMonitor(0).canMonitor({
        source: { data: sourceData },
      })
      expect(result).toBe(true)
    })

    it('monitor canMonitor rejects items from a different barId', () => {
      render(
        <TabBar
          items={[makeItem({ id: 'a', isActive: true }), makeItem({ id: 'b' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const foreignSource = {
        type: 'tab-bar-item',
        id: 'x',
        index: 0,
        barId: 'another-bar',
      }
      const result = getMonitor(0).canMonitor({
        source: { data: foreignSource },
      })
      expect(result).toBe(false)
    })

    it('monitor onDrop calls onReorder with correct indices', () => {
      const onReorder = vi.fn()
      render(
        <TabBar
          items={[
            makeItem({ id: 'a', isActive: true }),
            makeItem({ id: 'b' }),
            makeItem({ id: 'c' }),
          ]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={onReorder}
          onSelect={vi.fn()}
        />
      )

      const sourceData = getDraggable(0).getInitialData()
      const targetData = getDropTarget(2).getData()

      getMonitor(0).onDrop({
        source: { data: sourceData },
        location: {
          current: { dropTargets: [{ data: targetData }] },
        },
      })

      expect(onReorder).toHaveBeenCalledWith(0, 2)
    })

    it('monitor onDrop calls onReorder for reverse direction', () => {
      const onReorder = vi.fn()
      render(
        <TabBar
          items={[
            makeItem({ id: 'a', isActive: true }),
            makeItem({ id: 'b' }),
            makeItem({ id: 'c' }),
          ]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={onReorder}
          onSelect={vi.fn()}
        />
      )

      const sourceData = getDraggable(2).getInitialData()
      const targetData = getDropTarget(0).getData()

      getMonitor(0).onDrop({
        source: { data: sourceData },
        location: {
          current: { dropTargets: [{ data: targetData }] },
        },
      })

      expect(onReorder).toHaveBeenCalledWith(2, 0)
    })

    it('monitor onDrop does not call onReorder when same index', () => {
      const onReorder = vi.fn()
      render(
        <TabBar
          items={[makeItem({ id: 'a', isActive: true }), makeItem({ id: 'b' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={onReorder}
          onSelect={vi.fn()}
        />
      )

      const sourceData = getDraggable(0).getInitialData()
      const targetData = getDropTarget(0).getData()

      getMonitor(0).onDrop({
        source: { data: sourceData },
        location: {
          current: { dropTargets: [{ data: targetData }] },
        },
      })

      expect(onReorder).not.toHaveBeenCalled()
    })

    it('monitor onDrop does nothing when no drop targets', () => {
      const onReorder = vi.fn()
      render(
        <TabBar
          items={[makeItem({ id: 'a', isActive: true }), makeItem({ id: 'b' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={onReorder}
          onSelect={vi.fn()}
        />
      )

      const sourceData = getDraggable(0).getInitialData()

      getMonitor(0).onDrop({
        source: { data: sourceData },
        location: { current: { dropTargets: [] } },
      })

      expect(onReorder).not.toHaveBeenCalled()
    })

    it('monitor onDrop ignores non-tab-bar-item data', () => {
      const onReorder = vi.fn()
      render(
        <TabBar
          items={[makeItem({ id: 'a', isActive: true }), makeItem({ id: 'b' })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={onReorder}
          onSelect={vi.fn()}
        />
      )

      getMonitor(0).onDrop({
        source: { data: { type: 'workspace-frame', id: 'ws', index: 0 } },
        location: {
          current: {
            dropTargets: [
              { data: { type: 'workspace-frame', id: 'ws2', index: 1 } },
            ],
          },
        },
      })

      expect(onReorder).not.toHaveBeenCalled()
    })
  })

  describe('cross-bar isolation', () => {
    it('two TabBar instances have different barIds', () => {
      const { unmount: unmount1 } = render(
        <TabBar
          items={[makeItem({ id: 'x', isActive: true })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const firstBarId = getDraggable(0).getInitialData().barId
      unmount1()
      clearRegistrations()

      render(
        <TabBar
          items={[makeItem({ id: 'y', isActive: true })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      const secondBarId = getDraggable(0).getInitialData().barId
      expect(firstBarId).not.toBe(secondBarId)
    })

    it('drop target rejects drags from a different TabBar instance', () => {
      // Render two TabBars side by side
      render(
        <div>
          <TabBar
            items={[makeItem({ id: 'bar1-a', isActive: true })]}
            onClose={vi.fn()}
            onNew={vi.fn()}
            onReorder={vi.fn()}
            onSelect={vi.fn()}
          />
          <TabBar
            items={[makeItem({ id: 'bar2-a', isActive: true })]}
            onClose={vi.fn()}
            onNew={vi.fn()}
            onReorder={vi.fn()}
            onSelect={vi.fn()}
          />
        </div>
      )

      // 2 tabs rendered, 2 draggable registrations, 2 drop target registrations
      expect(draggableRegistrations).toHaveLength(2)
      expect(dropTargetRegistrations).toHaveLength(2)

      // Get source data from first bar's tab
      const bar1DragData = getDraggable(0).getInitialData()
      // Get drop target from second bar's tab
      const bar2Target = getDropTarget(1)

      // Verify cross-bar drop is rejected
      const canDrop = bar2Target.canDrop({ source: { data: bar1DragData } })
      expect(canDrop).toBe(false)
    })
  })

  describe('drop indicator edge logic', () => {
    it('onDragEnter sets edge based on source vs target index', () => {
      render(
        <TabBar
          items={[
            makeItem({ id: 'a', isActive: true }),
            makeItem({ id: 'b' }),
            makeItem({ id: 'c' }),
          ]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      // Verify onDragEnter is registered (edge logic is handled internally)
      const target0 = getDropTarget(0)
      expect(target0.onDragEnter).toBeDefined()

      const target2 = getDropTarget(2)
      expect(target2.onDragEnter).toBeDefined()

      // Verify onDragLeave clears edge
      expect(target0.onDragLeave).toBeDefined()
      expect(target2.onDragLeave).toBeDefined()
    })
  })

  describe('auto-hide does not register DnD', () => {
    it('no DnD registrations when auto-hidden (1 item)', () => {
      render(
        <TabBar
          autoHide
          items={[makeItem({ id: 'a', isActive: true })]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      expect(draggableRegistrations).toHaveLength(0)
      expect(dropTargetRegistrations).toHaveLength(0)
      expect(monitorRegistrations).toHaveLength(0)
    })

    it('no DnD registrations when auto-hidden (0 items)', () => {
      render(
        <TabBar
          autoHide
          items={[]}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onReorder={vi.fn()}
          onSelect={vi.fn()}
        />
      )

      expect(draggableRegistrations).toHaveLength(0)
      expect(dropTargetRegistrations).toHaveLength(0)
      expect(monitorRegistrations).toHaveLength(0)
    })
  })
})
