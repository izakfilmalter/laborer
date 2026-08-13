/**
 * The board's columns, shared by the board that renders them and the card
 * detail dialog that names the one a card sits in.
 *
 * They live apart from `task-board.tsx` because the dialog is reachable from
 * the sidebar now, and the sidebar has no business importing the board.
 */

import type { BoardTaskStatus } from '@/components/kanban/board-data'

interface BoardColumn {
  readonly dotClassName: string
  readonly id: Exclude<BoardTaskStatus, 'cancelled'>
  readonly title: string
}

/** The four rendered columns, in board order. Cancelled never renders. */
const BOARD_COLUMNS: readonly BoardColumn[] = [
  { id: 'todo', title: 'Todo', dotClassName: 'bg-muted-foreground/50' },
  { id: 'in_progress', title: 'In Progress', dotClassName: 'bg-success' },
  { id: 'in_review', title: 'In Review', dotClassName: 'bg-purple-500' },
  { id: 'done', title: 'Done', dotClassName: 'bg-primary' },
]

export { BOARD_COLUMNS }
export type { BoardColumn }
