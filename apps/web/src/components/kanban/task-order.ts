import type { SharedTaskRow } from '@laborer/shared/rpc'

/** Stable ordering key shared by optimistic and authoritative task rows. */
export const effectiveSortOrder = (
  task: Pick<SharedTaskRow, 'createdAt' | 'sortOrder'>
): number => task.sortOrder ?? -task.createdAt

/** Fractional rank for the final slot represented by an already-reordered list. */
export const fractionalOrderAt = (
  tasks: readonly Pick<SharedTaskRow, 'createdAt' | 'sortOrder'>[],
  index: number
): number => {
  const beforeTask = index > 0 ? tasks[index - 1] : undefined
  const afterTask = index + 1 < tasks.length ? tasks[index + 1] : undefined
  const before =
    beforeTask === undefined ? null : effectiveSortOrder(beforeTask)
  const after = afterTask === undefined ? null : effectiveSortOrder(afterTask)
  if (before !== null) {
    return after !== null ? before + (after - before) / 2 : before + 1
  }
  return after !== null ? after - 1 : 0
}
