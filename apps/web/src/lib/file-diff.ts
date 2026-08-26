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
 * What the pane can render for one changed file.
 *
 * The three outcomes used to collapse into `null`, which made a patch
 * that arrived but failed to parse indistinguishable from one the
 * server never sent — the pane labelled both "exceeds the size budget".
 * Ported from t3code's `getRenderablePatch`, which draws the same line.
 */
export type RenderableFilePatch =
  /** Parsed into the metadata the viewer renders. */
  | {
      readonly kind: 'parsed'
      /**
       * The content-derived key this patch was parsed under. Kept because
       * the viewer overwrites `fileDiff.cacheKey` once hunk expansion
       * hydrates the file, and the hunk-context loader needs the key that
       * still tracks the patch — see `@/lib/diff-contents`.
       */
      readonly cacheKey: string
      readonly fileDiff: FileDiffMetadata
    }
  /**
   * The patch arrived but the parser could not turn it into files, so
   * the raw unified diff is shown verbatim rather than dropped.
   */
  | { readonly kind: 'raw'; readonly patch: string; readonly reason: string }
  /**
   * No patch at all: either the server omitted it (`entry.truncated`) or
   * the file is binary. The entry's own flag tells those two apart.
   */
  | { readonly kind: 'absent' }

const UNSUPPORTED_REASON = 'Unsupported diff format. Showing the raw patch.'
const PARSE_FAILED_REASON = 'Failed to parse this patch. Showing it raw.'

/**
 * Convert a `file.diff` entry into something renderable.
 *
 * The server returns a unified diff patch per changed file (including
 * untracked files, which are diffed against `/dev/null`).
 */
export const parseFileDiffEntry = (
  entry: FileDiffEntry
): RenderableFilePatch => {
  const patch = entry.patch?.trim()
  if (!patch) {
    return { kind: 'absent' }
  }

  const cacheKey = buildPatchCacheKey(patch)
  try {
    const parsed = parsePatchFiles(patch, cacheKey)
    const fileDiff = parsed.flatMap((patchEntry) => patchEntry.files)[0]
    return fileDiff
      ? { cacheKey, fileDiff, kind: 'parsed' }
      : { kind: 'raw', patch, reason: UNSUPPORTED_REASON }
  } catch {
    return { kind: 'raw', patch, reason: PARSE_FAILED_REASON }
  }
}
