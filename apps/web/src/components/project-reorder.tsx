/**
 * Drag-to-reorder plumbing shared by the sidebar project tree and the kanban
 * swim lanes. Both surfaces are vertical lists of the same projects, so they
 * share one drag contract and one committed order; the surface tag keeps a
 * drag that started in the sidebar from dropping onto a lane and vice versa.
 *
 * Built on `@atlaskit/pragmatic-drag-and-drop`, matching the tab bar, so a
 * project drag never has to nest a second dnd-kit context inside the board's.
 *
 * @see apps/web/src/hooks/use-project-reorder.ts — how a drop is committed
 */

import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { cn } from '@laborer/ui/lib/utils'
import { GripVertical } from 'lucide-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { useProjectReorder } from '@/hooks/use-project-reorder'

const PROJECT_DRAG_TYPE = 'project-item'

/** The list a drag belongs to. Drags never cross surfaces. */
export type ProjectReorderSurface = 'board' | 'sidebar'

export type ProjectDropEdge = 'bottom' | 'top'

interface ProjectDragData {
  /** Position within the rendered list; only the drop indicator reads it. */
  readonly index: number
  readonly projectId: string
  readonly surface: ProjectReorderSurface
  readonly type: typeof PROJECT_DRAG_TYPE
  readonly [key: string | symbol]: unknown
}

function isProjectDragData(
  data: Record<string, unknown>
): data is ProjectDragData {
  return data.type === PROJECT_DRAG_TYPE
}

/**
 * Registers the surface's drop monitor. Exactly one per rendered list — the
 * monitor, not the item, is what commits the new order.
 */
export function useProjectReorderMonitor(surface: ProjectReorderSurface): void {
  const { moveProject } = useProjectReorder()
  const moveProjectRef = useRef(moveProject)
  moveProjectRef.current = moveProject

  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) =>
          isProjectDragData(source.data) && source.data.surface === surface,
        onDrop: ({ location, source }) => {
          const target = location.current.dropTargets[0]
          if (!target) {
            return
          }
          const sourceData = source.data
          const targetData = target.data
          if (
            !(isProjectDragData(sourceData) && isProjectDragData(targetData))
          ) {
            return
          }
          if (sourceData.projectId === targetData.projectId) {
            return
          }
          moveProjectRef.current(sourceData.projectId, targetData.projectId)
        },
      }),
    [surface]
  )
}

interface ProjectDragItemInput {
  /** The grab area. Dragging is limited to it so buttons stay clickable. */
  readonly dragHandleRef: RefObject<HTMLElement | null>
  /** The whole row, which is what moves and what accepts a drop. */
  readonly elementRef: RefObject<HTMLElement | null>
  /** False while the list is filtered, where a drop slot would be a guess. */
  readonly enabled: boolean
  readonly index: number
  readonly projectId: string
  readonly surface: ProjectReorderSurface
}

export interface ProjectDragItem {
  /** The edge the dragged project would land on, for the drop indicator. */
  readonly closestEdge: ProjectDropEdge | null
  readonly isDragging: boolean
}

/** Makes one project row draggable and a drop target within its surface. */
export function useProjectDragItem({
  dragHandleRef,
  elementRef,
  enabled,
  index,
  projectId,
  surface,
}: ProjectDragItemInput): ProjectDragItem {
  const [isDragging, setIsDragging] = useState(false)
  const [closestEdge, setClosestEdge] = useState<ProjectDropEdge | null>(null)

  useEffect(() => {
    const element = elementRef.current
    const dragHandle = dragHandleRef.current
    if (!(enabled && element && dragHandle)) {
      return
    }

    const data = (): ProjectDragData => ({
      index,
      projectId,
      surface,
      type: PROJECT_DRAG_TYPE,
    })

    return combine(
      draggable({
        dragHandle,
        element,
        getInitialData: data,
        onDragStart: () => setIsDragging(true),
        onDrop: () => {
          setIsDragging(false)
          setClosestEdge(null)
        },
      }),
      dropTargetForElements({
        canDrop: ({ source }) =>
          isProjectDragData(source.data) &&
          source.data.surface === surface &&
          source.data.projectId !== projectId,
        element,
        getData: data,
        onDragEnter: ({ source }) => {
          if (!isProjectDragData(source.data)) {
            return
          }
          setClosestEdge(source.data.index < index ? 'bottom' : 'top')
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    )
    // dragHandleRef and elementRef are stable ref objects.
  }, [dragHandleRef, elementRef, enabled, index, projectId, surface])

  return { closestEdge, isDragging }
}

/** The line showing where the dragged project would land. */
export function ProjectDropIndicator({
  edge,
}: {
  readonly edge: ProjectDropEdge | null
}) {
  if (edge === null) {
    return null
  }
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-primary',
        edge === 'top' ? '-top-1' : '-bottom-1'
      )}
    />
  )
}

/**
 * The grab affordance. Pointer users drag it; keyboard users move the project
 * with the arrow keys, which is the only reordering route pragmatic
 * drag-and-drop does not provide.
 */
export function ProjectDragHandle({
  className,
  disabled = false,
  projectId,
  projectName,
}: {
  readonly className?: string | undefined
  readonly disabled?: boolean | undefined
  readonly projectId: string
  readonly projectName: string
}) {
  const { nudgeProject } = useProjectReorder()

  return (
    <button
      aria-label={`Reorder ${projectName}`}
      className={cn(
        'flex size-4 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default group-hover/project:opacity-100',
        className
      )}
      disabled={disabled}
      onKeyDown={(event) => {
        const delta = { ArrowDown: 1, ArrowUp: -1 }[event.key]
        if (delta === undefined) {
          return
        }
        event.preventDefault()
        nudgeProject(projectId, delta)
      }}
      title="Drag to reorder — or use the arrow keys"
      type="button"
    >
      <GripVertical className="size-3.5" />
    </button>
  )
}
