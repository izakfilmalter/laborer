/**
 * List rendering for the description editor, including checkable to-do items.
 *
 * Plate models lists as indented blocks rather than nested `<ul>`s, so each
 * block wraps itself in its own single-item list. The markup still has to read
 * as a list to a screen reader, which is why the to-do variant keeps a real
 * `<li>` and hangs its checkbox outside the text column.
 */

'use client'

import { Checkbox } from '@laborer/ui/components/checkbox'
import { cn } from '@laborer/ui/lib/utils'
import { isOrderedList } from '@platejs/list'
import {
  useTodoListElement,
  useTodoListElementState,
} from '@platejs/list/react'
import type { TListElement } from 'platejs'
import {
  type PlateElementProps,
  type RenderNodeWrapper,
  useReadOnly,
} from 'platejs/react'
import type { ReactNode } from 'react'

type ListItemProps = PlateElementProps & { lineBreakBadge?: ReactNode }

function TodoMarker(props: PlateElementProps) {
  const state = useTodoListElementState({ element: props.element })
  const { checkboxProps } = useTodoListElement(state)
  const readOnly = useReadOnly()

  return (
    <div contentEditable={false}>
      <Checkbox
        className={cn(
          'absolute top-1.5 -left-6',
          readOnly && 'pointer-events-none'
        )}
        {...checkboxProps}
      />
    </div>
  )
}

function TodoListItem(props: ListItemProps) {
  return (
    <li
      className={cn(
        'list-none',
        (props.element.checked as boolean) &&
          'text-muted-foreground line-through'
      )}
    >
      {props.children}
      {props.lineBreakBadge}
    </li>
  )
}

function List(props: ListItemProps) {
  const { listStart, listStyleType } = props.element as TListElement
  const Tag = isOrderedList(props.element) ? 'ol' : 'ul'
  const isTodo = listStyleType === 'todo'

  return (
    <Tag
      className="relative m-0 p-0"
      start={listStart}
      style={{ listStyleType }}
    >
      {isTodo && <TodoMarker {...props} />}
      {isTodo ? (
        <TodoListItem {...props} />
      ) : (
        <li>
          {props.children}
          {props.lineBreakBadge}
        </li>
      )}
    </Tag>
  )
}

const BlockList: RenderNodeWrapper = ({ element }) =>
  element.listStyleType ? (itemProps) => <List {...itemProps} /> : undefined

export { BlockList }
