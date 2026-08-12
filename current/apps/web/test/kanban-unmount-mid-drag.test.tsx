/**
 * Regression test: dnd-kit's DndContext never tears down the active sensor
 * when it unmounts mid-drag, so the sensor's document-level mousemove/mouseup
 * listeners keep dispatching drag callbacks into the unmounted tree. In prod
 * this fired `onMove` → `OptimisticTaskMoveQueue.move` → an atom write against
 * a registry the sidecar-recovery remount had already disposed:
 *
 *   Uncaught (in promise) Error: Cannot access Atom …: registry is disposed
 *
 * The Kanban root now bails out of its drag handlers once unmounted.
 *
 * @see apps/web/src/components/reui/kanban.tsx
 * @see apps/web/src/components/kanban/task-board.tsx (persistMove)
 * @see apps/web/src/components/sidecar-runtime-boundary.tsx (generation bump)
 */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  type KanbanMoveEvent,
} from '../src/components/reui/kanban'

// ---------------------------------------------------------------------------
// Layout stubs — jsdom has no layout, so droppable/draggable rects come from
// a fixed map keyed by each node's `data-value`.
// ---------------------------------------------------------------------------

const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
  top: y,
  left: x,
  right: x + width,
  bottom: y + height,
  toJSON: () => ({ x, y, width, height }),
})

const RECTS: Record<string, ReturnType<typeof rect>> = {
  todo: rect(0, 0, 100, 200),
  done: rect(200, 0, 100, 200),
  'card-1': rect(0, 0, 100, 50),
  'card-2': rect(200, 0, 100, 50),
}

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect

beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const value = this.getAttribute('data-value')
    return (value !== null && RECTS[value]) || rect(0, 0, 0, 0)
  } as typeof Element.prototype.getBoundingClientRect
})

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
  cleanup()
})

// ---------------------------------------------------------------------------
// Harness — controlled two-column board, one card per column
// ---------------------------------------------------------------------------

interface Card {
  readonly id: string
}

function Harness({
  onMove,
  onValueChange,
}: {
  readonly onMove: (event: KanbanMoveEvent) => void
  readonly onValueChange: (value: Record<string, Card[]>) => void
}) {
  const [columns, setColumns] = useState<Record<string, Card[]>>({
    todo: [{ id: 'card-1' }],
    done: [{ id: 'card-2' }],
  })

  return (
    <Kanban
      getItemValue={(item: Card) => item.id}
      onMove={onMove}
      onValueChange={(value) => {
        setColumns(value)
        onValueChange(value)
      }}
      value={columns}
    >
      <KanbanBoard>
        {Object.keys(columns).map((column) => (
          <KanbanColumn key={column} value={column}>
            <KanbanColumnContent value={column}>
              {(columns[column] ?? []).map((item) => (
                <KanbanItem key={item.id} value={item.id}>
                  {item.id}
                </KanbanItem>
              ))}
            </KanbanColumnContent>
          </KanbanColumn>
        ))}
      </KanbanBoard>
    </Kanban>
  )
}

/**
 * Presses on card-1 and drags it over the "done" column. The MouseSensor
 * activates once movement exceeds its 10px activation constraint, then the
 * cross-column mousemove produces a DragOver that reorders the preview.
 */
const startDragOfCardOne = (container: HTMLElement) => {
  const card = container.querySelector('[data-value="card-1"]')
  if (card === null) {
    throw new Error('card-1 not rendered')
  }
  fireEvent.mouseDown(card, { button: 0, clientX: 50, clientY: 25 })
  // Exceed the 10px activation distance, then cross into the "done" column.
  fireEvent.mouseMove(document, { clientX: 80, clientY: 25 })
  fireEvent.mouseMove(document, { clientX: 250, clientY: 25 })
}

describe('Kanban drag lifecycle across unmount', () => {
  it('delivers onMove for a drag completed while mounted', async () => {
    const onMove = vi.fn()
    const onValueChange = vi.fn()
    const { container } = render(
      <Harness onMove={onMove} onValueChange={onValueChange} />
    )

    startDragOfCardOne(container)
    // Sanity: the cross-column preview engaged, so the drag is real.
    expect(onValueChange).toHaveBeenCalled()

    fireEvent.mouseUp(document, { clientX: 250, clientY: 25 })

    // dnd-kit dispatches drag-end from an async handler.
    await vi.waitFor(() => {
      expect(onMove).toHaveBeenCalledTimes(1)
    })
    expect(onMove.mock.calls[0]?.[0]).toMatchObject({
      overContainer: 'done',
    })
  })

  it('ignores stale sensor callbacks after unmounting mid-drag', async () => {
    const onMove = vi.fn()
    const onValueChange = vi.fn()
    const { container, unmount } = render(
      <Harness onMove={onMove} onValueChange={onValueChange} />
    )

    startDragOfCardOne(container)
    // Sanity: the drag engaged before the unmount.
    expect(onValueChange).toHaveBeenCalled()
    onValueChange.mockClear()

    // Sidecar recovery remounts the tree mid-drag; dnd-kit leaves the active
    // sensor's document listeners attached to the dead tree.
    unmount()

    fireEvent.mouseMove(document, { clientX: 260, clientY: 25 })
    fireEvent.mouseUp(document, { clientX: 260, clientY: 25 })

    // Flush dnd-kit's async drag-end handler before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onMove).not.toHaveBeenCalled()
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
