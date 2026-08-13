import type { FileDiffEntry } from '@laborer/shared/rpc'
import type { FileDiffMetadata } from '@pierre/diffs'
import { parsePatchFiles } from '@pierre/diffs'

/**
 * Convert a `file.diff` entry into Pierre's metadata format.
 *
 * The server returns a unified diff patch per changed file (including
 * untracked files, which are diffed against `/dev/null`). Entries
 * without a patch (binary files, truncated patches) return `null` and
 * are skipped by the diff viewer.
 */
export const parseFileDiffEntry = (
  entry: FileDiffEntry
): FileDiffMetadata | null => {
  if (!entry.patch) {
    return null
  }
  const parsed = parsePatchFiles(entry.patch)
  return parsed.flatMap((patchEntry) => patchEntry.files)[0] ?? null
}
