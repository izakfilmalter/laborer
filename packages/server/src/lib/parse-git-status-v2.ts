/**
 * Pure parser for `git status -z --porcelain=v2` output.
 *
 * Converts the raw null-delimited output into `GitStatusEntry[]` compatible
 * with `@pierre/trees`. Maps the full porcelain v2 two-character status codes
 * (index column X + working tree column Y) down to three statuses:
 *
 * - `'added'`    — new file (A) or untracked (?)
 * - `'deleted'`  — removed file (D)
 * - `'modified'` — modified (M), renamed (R), copied (C), or conflict (u)
 *
 * When a file has different statuses in the index vs working tree, the most
 * severe wins: deleted > modified > added.
 *
 * No side effects — this module never spawns processes or touches the
 * filesystem.
 *
 * @see https://git-scm.com/docs/git-status#_porcelain_format_version_2
 * @see Issue #3: Git status porcelain v2 parser + unit tests
 */

import type { GitStatusEntry } from '@laborer/shared/rpc'
import { Array as Arr, Order, pipe, Record } from 'effect'

type Status = GitStatusEntry['status']

/**
 * Severity ranking for status deduplication. When a file has different
 * statuses in index vs working tree, the higher-severity status wins.
 */
const SEVERITY: Record<Status, number> = {
  added: 1,
  modified: 2,
  deleted: 3,
}

/**
 * Map a single XY character (from either the index or working-tree column)
 * to a GitStatusEntry status, or undefined if the character indicates "no change".
 */
const mapStatusChar = (char: string): Status | undefined => {
  switch (char) {
    case 'M':
    case 'T':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
    case 'C':
      // Renames and copies are treated as modified for the new path.
      // The old path (for renames) gets a separate 'deleted' entry.
      return 'modified'
    case '.':
      // '.' means "not modified" in that column
      return undefined
    default:
      return undefined
  }
}

/**
 * Merge two statuses for the same file by choosing the more severe one.
 * deleted > modified > added
 */
const mergeStatuses = (a: Status, b: Status): Status =>
  (SEVERITY[a] ?? 0) >= (SEVERITY[b] ?? 0) ? a : b

/**
 * Mutable accumulator for path -> status entries.
 * Merges duplicates by severity.
 */
interface StatusAccumulator {
  readonly map: Record<string, Status>
}

const addEntry = (
  acc: StatusAccumulator,
  path: string,
  status: Status
): void => {
  const existing = acc.map[path]
  acc.map[path] =
    existing !== undefined ? mergeStatuses(existing, status) : status
}

/**
 * Apply XY status characters from index and working tree columns
 * to the accumulator for the given path.
 */
const applyXYStatus = (
  acc: StatusAccumulator,
  path: string,
  x: string,
  y: string
): void => {
  const indexStatus = mapStatusChar(x)
  const wtStatus = mapStatusChar(y)

  if (indexStatus !== undefined) {
    addEntry(acc, path, indexStatus)
  }
  if (wtStatus !== undefined) {
    addEntry(acc, path, wtStatus)
  }
}

/**
 * Extract the XY characters from a porcelain v2 line.
 * XY is always at positions 2-3 (after the type character and a space).
 */
const extractXY = (line: string): [x: string, y: string] => [
  line[2] ?? '.',
  line[3] ?? '.',
]

/**
 * Extract a path by skipping a fixed number of space-separated fields.
 * Returns everything after the Nth space.
 */
const extractPathAfterNSpaces = (line: string, n: number): string => {
  let spaceCount = 0
  for (let j = 0; j < line.length; j++) {
    if (line[j] === ' ') {
      spaceCount++
      if (spaceCount === n) {
        return line.substring(j + 1)
      }
    }
  }
  return ''
}

/**
 * Extract the file path from an ordinary changed entry (type `1`).
 * Format: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 * That's 8 space-separated fields before the path.
 */
const extractPathFromOrdinary = (line: string): string =>
  extractPathAfterNSpaces(line, 8)

/**
 * Extract the file path from a rename/copy entry (type `2`).
 * Format: `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`
 * That's 9 space-separated fields before the path.
 */
const extractPathFromRename = (line: string): string =>
  extractPathAfterNSpaces(line, 9)

/**
 * Extract the file path from an unmerged entry (type `u`).
 * Format: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
 * That's 10 space-separated fields before the path.
 */
const extractPathFromUnmerged = (line: string): string =>
  extractPathAfterNSpaces(line, 10)

/**
 * Process an ordinary changed entry (type `1`).
 * Returns the number of NUL-delimited parts consumed (always 1).
 */
const processOrdinaryEntry = (acc: StatusAccumulator, part: string): number => {
  const [x, y] = extractXY(part)
  const path = extractPathFromOrdinary(part)
  applyXYStatus(acc, path, x, y)
  return 1
}

/**
 * Process a rename/copy entry (type `2`).
 * Returns the number of NUL-delimited parts consumed (always 2: entry + orig path).
 */
const processRenameEntry = (
  acc: StatusAccumulator,
  part: string,
  nextPart: string | undefined
): number => {
  const [x, y] = extractXY(part)
  const newPath = extractPathFromRename(part)
  const origPath = nextPart ?? ''

  applyXYStatus(acc, newPath, x, y)

  // The old path is considered 'deleted' (it no longer exists under that name)
  if (origPath.length > 0) {
    addEntry(acc, origPath, 'deleted')
  }

  return 2
}

/**
 * Process an unmerged entry (type `u`).
 * Conflict states are always mapped to 'modified' as a conservative fallback.
 * Returns 1.
 */
const processUnmergedEntry = (acc: StatusAccumulator, part: string): number => {
  const path = extractPathFromUnmerged(part)
  addEntry(acc, path, 'modified')
  return 1
}

/**
 * Process an untracked entry (type `?`).
 * Returns 1.
 */
const processUntrackedEntry = (
  acc: StatusAccumulator,
  part: string
): number => {
  const path = part.substring(2)
  addEntry(acc, path, 'added')
  return 1
}

/**
 * Dispatch an entry to the correct processor based on its prefix character.
 * Returns the number of NUL-delimited parts consumed.
 */
const dispatchEntry = (
  acc: StatusAccumulator,
  parts: string[],
  index: number,
  part: string
): number => {
  const prefix = part[0]

  switch (prefix) {
    case '1':
      return processOrdinaryEntry(acc, part)
    case '2':
      return processRenameEntry(acc, part, parts[index + 1])
    case 'u':
      return processUnmergedEntry(acc, part)
    case '?':
      return processUntrackedEntry(acc, part)
    default:
      // '!' (ignored) or unknown — skip
      return 1
  }
}

/**
 * Order GitStatusEntry by path for consistent output.
 */
const gitStatusEntryOrder = Order.mapInput(
  Order.string,
  (entry: GitStatusEntry) => entry.path
)

/**
 * Parse `git status -z --porcelain=v2` output into `GitStatusEntry[]`.
 *
 * The `-z` flag causes git to use NUL (`\0`) as the field terminator.
 * Each entry type has a different format:
 *
 * - Ordinary:  `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>\0`
 * - Rename:    `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>\0`
 * - Unmerged:  `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>\0`
 * - Untracked: `? <path>\0`
 * - Ignored:   `! <path>\0`
 */
const parseGitStatusV2 = (output: string): GitStatusEntry[] => {
  if (output.length === 0) {
    return []
  }

  // Split on NUL bytes. The last element may be empty from a trailing NUL.
  const parts = output.split('\0')
  const acc: StatusAccumulator = { map: {} }

  let i = 0
  while (i < parts.length) {
    const part = parts[i]

    // Skip empty parts (trailing NUL or empty input)
    if (part === undefined || part.length === 0) {
      i++
      continue
    }

    i += dispatchEntry(acc, parts, i, part)
  }

  // Convert the map to a sorted array
  return pipe(
    acc.map,
    Record.toEntries,
    Arr.map(([path, status]) => ({ path, status })),
    Arr.sort(gitStatusEntryOrder)
  )
}

export { parseGitStatusV2 }
