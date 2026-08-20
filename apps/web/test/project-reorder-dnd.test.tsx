/**
 * Drag-to-reorder wiring shared by the sidebar project tree and the kanban
 * swim lanes.
 *
 * Native drag events cannot be simulated in JSDOM, so these tests capture the
 * options handed to `@atlaskit/pragmatic-drag-and-drop` and drive the
 * callbacks directly — the same approach the tab bar's DnD tests take.
 *
 * @see apps/web/src/components/project-reorder.tsx
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface DraggableConfig {
  dragHandle?: HTMLElement
  element: HTMLElement
  getInitialData: () => Record<string, unknown>
  onDragStart?: () => void
  onDrop?: () => void
}

interface DropTargetConfig {
  canDrop: (args: { source: { data: Record<string, unknown> } }) => boolean
  element: HTMLElement
  getData: () => Record<string, unknown>
  onDragEnter?: (args: { source: { data: Record<string, unknown> } }) => void
  onDragLeave?: () => void
  onDrop?: () => void
}

interface MonitorConfig {
  canMonitor: (args: { source: { data: Record<string, unknown> } }) => boolean
  onDrop: (args: {
    location: {
      current: { dropTargets: Array<{ data: Record<string, unknown> }> }
    }
    source: { data: Record<string, unknown> }
  }) => void
}

const draggables: DraggableConfig[] = []
const dropTargets: DropTargetConfig[] = []
const monitors: MonitorConfig[] = []

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (config: DraggableConfig) => {
    draggables.push(config)
    return () => undefined
  },
  dropTargetForElements: (config: DropTargetConfig) => {
    dropTargets.push(config)
    return () => undefined
  },
  monitorForElements: (config: MonitorConfig) => {
    monitors.push(config)
    return () => undefined
  },
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine:
    (...cleanups: (() => void)[]) =>
    () => {
      for (const cleanup of cleanups) {
        cleanup()
      }
    },
}))

const moveProject = vi.fn()
const nudgeProject = vi.fn()

vi.mock('@/hooks/use-project-reorder', () => ({
  useProjectReorder: () => ({
    moveProject,
    nudgeProject,
    projectIds: ['a', 'b', 'c'],
  }),
}))

import {
  ProjectDragHandle,
  type ProjectReorderSurface,
  useProjectDragItem,
  useProjectReorderKeys,
  useProjectReorderMonitor,
} from '../src/components/project-reorder'

/** A sidebar-style heading: the grab area is the row's own toggle button. */
function HeadingRow({ enabled }: { readonly enabled: boolean }) {
  const handleReorderKeys = useProjectReorderKeys({
    enabled,
    projectId: 'b',
  })

  return (
    <button onKeyDown={handleReorderKeys} type="button">
      Laborer
    </button>
  )
}

function Row({
  enabled,
  index,
  projectId,
  surface,
}: {
  readonly enabled: boolean
  readonly index: number
  readonly projectId: string
  readonly surface: ProjectReorderSurface
}) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const headingRef = useRef<HTMLDivElement | null>(null)
  const { closestEdge, isDragging } = useProjectDragItem({
    dragHandleRef: headingRef,
    elementRef,
    enabled,
    index,
    projectId,
    surface,
  })

  return (
    <div data-testid={`row-${projectId}`} ref={elementRef}>
      <div data-testid={`heading-${projectId}`} ref={headingRef}>
        {projectId}
      </div>
      <span data-testid={`state-${projectId}`}>
        {`${closestEdge ?? 'none'}:${String(isDragging)}`}
      </span>
    </div>
  )
}

function ProjectList({
  enabled = true,
  surface = 'sidebar',
}: {
  readonly enabled?: boolean
  readonly surface?: ProjectReorderSurface
}) {
  useProjectReorderMonitor(surface)
  return (
    <div>
      {['a', 'b', 'c'].map((projectId, index) => (
        <Row
          enabled={enabled}
          index={index}
          key={projectId}
          projectId={projectId}
          surface={surface}
        />
      ))}
    </div>
  )
}

const draggableAt = (index: number): DraggableConfig => {
  const registration = draggables[index]
  if (!registration) {
    throw new Error(`No draggable registration at index ${index}`)
  }
  return registration
}

const dropTargetAt = (index: number): DropTargetConfig => {
  const registration = dropTargets[index]
  if (!registration) {
    throw new Error(`No drop target registration at index ${index}`)
  }
  return registration
}

const monitorAt = (index: number): MonitorConfig => {
  const registration = monitors[index]
  if (!registration) {
    throw new Error(`No monitor registration at index ${index}`)
  }
  return registration
}

afterEach(() => {
  cleanup()
  draggables.length = 0
  dropTargets.length = 0
  monitors.length = 0
  moveProject.mockClear()
  nudgeProject.mockClear()
})

describe('project drag registration', () => {
  it('registers every project as a draggable and a drop target', () => {
    render(<ProjectList />)

    expect(draggables).toHaveLength(3)
    expect(dropTargets).toHaveLength(3)
    expect(monitors).toHaveLength(1)
  })

  it('drags the whole row from its heading', () => {
    render(<ProjectList />)

    const registration = draggableAt(0)
    expect(registration.element).toBe(screen.getByTestId('row-a'))
    expect(registration.dragHandle).toBe(screen.getByTestId('heading-a'))
    expect(registration.getInitialData()).toEqual({
      index: 0,
      projectId: 'a',
      surface: 'sidebar',
      type: 'project-item',
    })
  })

  it('registers nothing while the list is filtered', () => {
    render(<ProjectList enabled={false} />)

    expect(draggables).toHaveLength(0)
    expect(dropTargets).toHaveLength(0)
  })
})

describe('project drop targets', () => {
  it('accepts another project from the same surface', () => {
    render(<ProjectList />)

    expect(
      dropTargetAt(1).canDrop({
        source: { data: draggableAt(0).getInitialData() },
      })
    ).toBe(true)
  })

  it('rejects a drop onto itself', () => {
    render(<ProjectList />)

    expect(
      dropTargetAt(0).canDrop({
        source: { data: draggableAt(0).getInitialData() },
      })
    ).toBe(false)
  })

  it('rejects a lane dragged onto the sidebar', () => {
    render(<ProjectList />)

    expect(
      dropTargetAt(1).canDrop({
        source: {
          data: {
            index: 0,
            projectId: 'a',
            surface: 'board',
            type: 'project-item',
          },
        },
      })
    ).toBe(false)
  })

  it('rejects drags that are not projects', () => {
    render(<ProjectList />)

    expect(
      dropTargetAt(0).canDrop({
        source: {
          data: { barId: 'x', id: 't', index: 0, type: 'tab-bar-item' },
        },
      })
    ).toBe(false)
  })

  it('points the indicator at the edge the project will land on', () => {
    render(<ProjectList />)

    // Dragging "a" down onto "c" lands it below "c".
    act(() => {
      dropTargetAt(2).onDragEnter?.({
        source: { data: draggableAt(0).getInitialData() },
      })
    })
    expect(screen.getByTestId('state-c').textContent).toBe('bottom:false')

    // Dragging "c" up onto "a" lands it above "a".
    act(() => {
      dropTargetAt(0).onDragEnter?.({
        source: { data: draggableAt(2).getInitialData() },
      })
    })
    expect(screen.getByTestId('state-a').textContent).toBe('top:false')

    act(() => {
      dropTargetAt(0).onDragLeave?.()
    })
    expect(screen.getByTestId('state-a').textContent).toBe('none:false')
  })
})

describe('project drop monitor', () => {
  it('commits the move on drop', () => {
    render(<ProjectList />)

    monitorAt(0).onDrop({
      location: {
        current: { dropTargets: [{ data: dropTargetAt(2).getData() }] },
      },
      source: { data: draggableAt(0).getInitialData() },
    })

    expect(moveProject).toHaveBeenCalledWith('a', 'c')
  })

  it('ignores a drop with no target, onto itself, or from another surface', () => {
    render(<ProjectList />)

    monitorAt(0).onDrop({
      location: { current: { dropTargets: [] } },
      source: { data: draggableAt(0).getInitialData() },
    })
    monitorAt(0).onDrop({
      location: {
        current: { dropTargets: [{ data: dropTargetAt(0).getData() }] },
      },
      source: { data: draggableAt(0).getInitialData() },
    })
    monitorAt(0).onDrop({
      location: {
        current: { dropTargets: [{ data: dropTargetAt(0).getData() }] },
      },
      source: { data: { barId: 'x', id: 't', index: 2, type: 'tab-bar-item' } },
    })

    expect(moveProject).not.toHaveBeenCalled()
  })

  it('only monitors drags from its own surface', () => {
    render(<ProjectList surface="board" />)

    expect(
      monitorAt(0).canMonitor({
        source: { data: draggableAt(0).getInitialData() },
      })
    ).toBe(true)
    expect(
      monitorAt(0).canMonitor({
        source: {
          data: {
            index: 0,
            projectId: 'a',
            surface: 'sidebar',
            type: 'project-item',
          },
        },
      })
    ).toBe(false)
  })
})

describe('keyboard reordering', () => {
  it('moves a project with the arrow keys', () => {
    render(<ProjectDragHandle projectId="b" projectName="Laborer" />)

    const handle = screen.getByRole('button', { name: 'Reorder Laborer' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(nudgeProject).toHaveBeenCalledWith('b', -1)

    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(nudgeProject).toHaveBeenCalledWith('b', 1)

    fireEvent.keyDown(handle, { key: 'Enter' })
    expect(nudgeProject).toHaveBeenCalledTimes(2)
  })

  it('moves a handle-less project with alt and the arrow keys', () => {
    render(<HeadingRow enabled={true} />)

    const heading = screen.getByRole('button', { name: 'Laborer' })
    fireEvent.keyDown(heading, { altKey: true, key: 'ArrowUp' })
    expect(nudgeProject).toHaveBeenCalledWith('b', -1)

    fireEvent.keyDown(heading, { altKey: true, key: 'ArrowDown' })
    expect(nudgeProject).toHaveBeenCalledWith('b', 1)

    // Plain arrows stay free for navigating the tree.
    fireEvent.keyDown(heading, { key: 'ArrowUp' })
    expect(nudgeProject).toHaveBeenCalledTimes(2)
  })

  it('ignores the arrow keys while reordering is disabled', () => {
    render(<HeadingRow enabled={false} />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Laborer' }), {
      altKey: true,
      key: 'ArrowUp',
    })
    expect(nudgeProject).not.toHaveBeenCalled()
  })
})
