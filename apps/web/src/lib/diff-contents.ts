/**
 * Fetching both sides of a file in full, so the viewer can expand the
 * unchanged context a patch left out.
 *
 * `@pierre/diffs` takes a `loadDiffFiles` loader and gates the whole
 * expansion affordance on it: without one, `canHydrateCollapsedContext` is
 * false, the separator paints no expand control, and the collapsed lines
 * between hunks stay unreachable. With one, pressing that control hydrates
 * the parsed patch in place with the real file contents.
 *
 * Everything here is pure. The pane owns the RPC call, the cache, and the
 * per-file status; this module owns the shapes and the words.
 *
 * ## What the request has to carry
 *
 * The patch was cut under a {@link DiffTarget} — the worktree against `HEAD`,
 * or everything since the branch forked — and the old side only means
 * something relative to that same target. Sending the wrong one serves a
 * different revision's file and hydrates the diff with lines that were never
 * on the other side of it, so `target` is required rather than defaulted.
 *
 * `new` and `deleted` files are refused by the RPC's own schema and never get
 * here: their patch already carries the whole of the side that exists, so
 * there is no context to expand into. {@link diffContentsPayload} returns
 * `null` for them, which is also the answer for anything the viewer parsed
 * into a change type this app does not recognise.
 *
 * ## What can come back instead
 *
 * Every {@link DiffContentsUnavailable} reason means the same thing to the
 * viewer — do not hydrate, keep rendering the partial patch — but they mean
 * very different things to a reader, so each gets its own sentence. A
 * truncated side is the same kind of answer: the server admitting it cut the
 * file off at its byte cap, which would hydrate the diff with fewer lines
 * than the file has and leave the tail of it silently missing.
 */

import type {
  DiffContentsChangeType,
  DiffTarget,
  FileDiffContents,
} from '@laborer/shared/rpc'
import { DiffContentsUnavailable } from '@laborer/shared/rpc'
import type { FileDiffLoadedFiles, FileDiffMetadata } from '@pierre/diffs'
import { Option, Schema } from 'effect'

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** The `file.diffContents` payload, as this app builds it. */
export interface DiffContentsPayload {
  readonly changeType: DiffContentsChangeType
  readonly newPath: string
  readonly oldPath: string
  readonly target: DiffTarget
  readonly workspaceId: string
}

const SERVED_CHANGE_TYPES: readonly string[] = [
  'change',
  'rename-changed',
  'rename-pure',
]

/**
 * The request for one parsed file, or `null` when there is nothing to ask.
 *
 * The viewer's own metadata is the source for both paths: `name` is the path
 * in the worktree and `prevName` is the path at the base revision, present
 * only on a rename. An unrenamed file has the same path on both sides, which
 * is what the RPC expects.
 */
export const diffContentsPayload = (
  fileDiff: FileDiffMetadata,
  request: { readonly target: DiffTarget; readonly workspaceId: string }
): DiffContentsPayload | null => {
  if (!SERVED_CHANGE_TYPES.includes(fileDiff.type)) {
    return null
  }
  return {
    changeType: fileDiff.type as DiffContentsChangeType,
    newPath: fileDiff.name,
    oldPath: fileDiff.prevName ?? fileDiff.name,
    target: request.target,
    workspaceId: request.workspaceId,
  }
}

// ---------------------------------------------------------------------------
// The cache key
// ---------------------------------------------------------------------------

/**
 * One fetched pair of file contents, keyed so it invalidates exactly when
 * the answer would differ.
 *
 * Two things decide that. The request — workspace, target, whitespace flag —
 * because a different target reads the old side at a different revision. And
 * the patch's own content hash from {@link buildPatchCacheKey}, because the
 * pane refetches the whole workspace diff every time the watcher fires: an
 * identical redelivery has to hit, and a file that actually changed has to
 * miss. Pierre's `FileContents.cacheKey` is given the same string so its
 * highlight cache turns over on the same event.
 */
export const diffContentsCacheKey = (
  requestKey: string,
  patchCacheKey: string
): string => `${requestKey}\u0000${patchCacheKey}`

// ---------------------------------------------------------------------------
// What the pane can be in the middle of
// ---------------------------------------------------------------------------

/**
 * Where one file's expansion has got to, as the reader would describe it.
 *
 * `unavailable` is not a fault — it is the honest end of the round trip, and
 * it carries the sentence rather than a code so the pane can print it
 * wherever it has room.
 */
export type DiffExpansionStatus =
  | { readonly _tag: 'loading' }
  | { readonly _tag: 'ready' }
  | { readonly _tag: 'unavailable'; readonly message: string }

const decodeUnavailable = Schema.decodeUnknownOption(DiffContentsUnavailable)

const UNAVAILABLE_SENTENCES: Record<
  DiffContentsUnavailable['reason'],
  (path: string) => string
> = {
  BINARY_FILE: (path) =>
    `${path} is not a text file, so there are no surrounding lines to show.`,
  NEW_PATH_ABSENT: (path) =>
    `${path} is no longer in the worktree, so its surrounding lines cannot be read.`,
  OLD_PATH_ABSENT: (path) =>
    `${path} is not in the revision this diff compares against, so its surrounding lines cannot be read.`,
}

/** The generic sentence for anything that is not a recognised refusal. */
const GENERIC_FAILURE =
  'Could not load the rest of this file, so the unchanged lines around this change stay hidden.'

/**
 * Turn whatever the round trip rejected with into one sentence a reader can
 * act on. A recognised {@link DiffContentsUnavailable} names the file and the
 * reason; anything else — a dropped socket, a timeout, an unresolvable target
 * — falls back to saying what the reader lost rather than what broke.
 */
export const describeDiffContentsFailure = (error: unknown): string => {
  const decoded = decodeUnavailable(error)
  if (Option.isNone(decoded)) {
    return GENERIC_FAILURE
  }
  const { path, reason } = decoded.value
  return UNAVAILABLE_SENTENCES[reason](path)
}

/**
 * The sentence for a side the server cut off at its byte cap, or `null` when
 * both sides arrived whole.
 *
 * Hydrating from a truncated side would give the viewer a file shorter than
 * the real one: every line past the cut would be missing from the expansion
 * and from every line count derived from it, with nothing on screen saying
 * so. Declining is the only reading that does not lie.
 */
export const truncatedSideMessage = (
  contents: Pick<FileDiffContents, 'newTruncated' | 'oldTruncated'>,
  path: string
): string | null => {
  if (!(contents.oldTruncated || contents.newTruncated)) {
    return null
  }
  return `${path} is too large to load in full, so the unchanged lines around this change stay hidden.`
}

// ---------------------------------------------------------------------------
// Handing the contents to the viewer
// ---------------------------------------------------------------------------

/**
 * The two sides in the shape `loadDiffFiles` has to resolve with.
 *
 * A pure rename has no old side to fetch — the contents are the same file
 * under a different name — and the library's own hydration insists on
 * `oldFile: null` there, while throwing for a `change` or `rename-changed`
 * given the same. The change type decides, not the contents.
 *
 * Both sides carry the cache key of the fetch they came from, which is what
 * lets the highlighter reuse a full-file result across the pane's refetches.
 */
export const toLoadedDiffFiles = (
  payload: DiffContentsPayload,
  contents: Pick<FileDiffContents, 'newContents' | 'oldContents'>,
  cacheKey: string
): FileDiffLoadedFiles => {
  const newFile = {
    cacheKey: `${cacheKey}\u0000new`,
    contents: contents.newContents,
    name: payload.newPath,
  }
  if (payload.changeType === 'rename-pure') {
    return { newFile, oldFile: null }
  }
  return {
    newFile,
    oldFile: {
      cacheKey: `${cacheKey}\u0000old`,
      contents: contents.oldContents,
      name: payload.oldPath,
    },
  }
}
