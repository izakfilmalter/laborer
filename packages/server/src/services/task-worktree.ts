import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

const OWNER_MARKER = '.laborer-worktree-owner.json'
const MAX_OWNER_MARKER_BYTES = 16 * 1024

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

  let descriptor: number | undefined
  try {
    descriptor = openSync(
      join(worktreePath, OWNER_MARKER),
      constants.O_RDONLY + constants.O_NOFOLLOW
    )
    const metadata = fstatSync(descriptor)
    if (!(metadata.isFile() && metadata.size <= MAX_OWNER_MARKER_BYTES)) {
      return false
    }
    const marker: unknown = JSON.parse(readFileSync(descriptor, 'utf8'))
    return (
      typeof marker === 'object' &&
      marker !== null &&
      'executionId' in marker &&
      marker.executionId === executionId
    )
  } catch {
    return false
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
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
