import { statSync } from 'node:fs'
import { readWorktreeOwnerMarkerSync } from '@laborer/worktree-owner'

export interface TaskWorktreeInspection {
  readonly botOwned: boolean
  readonly exists: boolean
}

const markerMatches = (
  worktreePath: string,
  executionId: string | null
): boolean => {
  if (executionId === null) {
    return false
  }

  try {
    return readWorktreeOwnerMarkerSync(worktreePath).executionId === executionId
  } catch {
    return false
  }
}

/** Passive filesystem evidence. Ownership is advisory and never gates use. */
export const inspectTaskWorktree = (
  worktreePath: string | null,
  executionId: string | null
): TaskWorktreeInspection => {
  if (worktreePath === null) {
    return { botOwned: false, exists: false }
  }
  try {
    if (!statSync(worktreePath).isDirectory()) {
      return { botOwned: false, exists: false }
    }
  } catch {
    return { botOwned: false, exists: false }
  }
  return {
    botOwned: markerMatches(worktreePath, executionId),
    exists: true,
  }
}
