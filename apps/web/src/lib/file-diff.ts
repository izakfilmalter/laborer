import type { FileDiffEntry } from '@laborer/shared/rpc'
import type { FileDiffMetadata } from '@pierre/diffs'
import { parsePatchFiles } from '@pierre/diffs'
import { fnv1a32 } from '@/lib/fnv1a32'

/**
 * A cache key derived from the patch itself, so the renderer reuses its
 * parsed and highlighted result across the watcher-driven refetches that
 * re-deliver an unchanged file, and misses as soon as the file changes.
 */
export const buildPatchCacheKey = (patch: string): string =>
  `file-diff:${patch.length}:${fnv1a32(patch).toString(36)}`

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
  const parsed = parsePatchFiles(entry.patch, buildPatchCacheKey(entry.patch))
  return parsed.flatMap((patchEntry) => patchEntry.files)[0] ?? null
}
