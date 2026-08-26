/**
 * What the diff pane measures the worktree against, as data.
 *
 * A worktree tells two stories at once: what the agent has not committed
 * yet, and everything the branch has done since it forked. `file.diff`
 * takes a {@link DiffTarget} saying which one to answer, so the pane needs
 * a vocabulary for the choice, a key it can cache and persist by, and
 * words for the ways a repository declines to answer.
 *
 * Everything here is pure. The menu, the atom key, the stored preference
 * and the failure copy all route through these functions so they can be
 * tested without a DOM, a server, or localStorage.
 *
 * The choice vocabulary is modelled on t3code's `buildBaseRefChoices`,
 * narrowed to what this app can actually offer: t3code builds its list
 * from live local and remote refs, and Laborer has no ref-listing RPC. So
 * the branch target — which resolves the workspace's recorded base branch
 * on the server — carries the common case, a short list of conventional
 * base refs covers the rest, and anything else is typed in.
 */

import type { DiffTarget } from '@laborer/shared/rpc'

// ---------------------------------------------------------------------------
// The target itself
// ---------------------------------------------------------------------------

/** What the pane shows until someone chooses otherwise. */
export const DEFAULT_DIFF_TARGET: DiffTarget = { _tag: 'working' }

/**
 * Refs worth offering without being asked.
 *
 * Deliberately short. A repository that has none of these still reaches
 * every ref through "Another ref…", and a request for a ref this
 * repository lacks comes back as `REF_NOT_FOUND` with words that say so.
 */
export const DIFF_TARGET_REF_SUGGESTIONS: readonly string[] = [
  'origin/main',
  'origin/master',
  'main',
  'master',
]

/**
 * A stable string for one target: the menu's radio value, the cache key
 * the query atom is keyed by, and the value written to local storage.
 */
export const diffTargetKey = (target: DiffTarget): string =>
  target._tag === 'ref' ? `ref:${target.ref}` : target._tag

/**
 * The inverse. Returns `null` rather than throwing, because the callers
 * are a stored preference and a cache key — both of which can be stale or
 * hand-edited, and both of which would rather fall back to the default
 * than take the pane down.
 */
export const parseDiffTargetKey = (key: string): DiffTarget | null => {
  if (key === 'working' || key === 'branch') {
    return { _tag: key }
  }
  if (key.startsWith('ref:')) {
    const ref = key.slice('ref:'.length)
    return ref.length > 0 ? { _tag: 'ref', ref } : null
  }
  return null
}

/** The full sentence naming a target, for menus and accessible names. */
export const diffTargetLabel = (target: DiffTarget): string => {
  if (target._tag === 'working') {
    return 'Uncommitted changes'
  }
  if (target._tag === 'branch') {
    return 'Everything on this branch'
  }
  return `Everything since ${target.ref}`
}

/** One line under the label explaining what the target actually measures. */
export const diffTargetDescription = (target: DiffTarget): string => {
  if (target._tag === 'working') {
    return 'The worktree against HEAD — what has not been committed yet.'
  }
  if (target._tag === 'branch') {
    return 'From where this branch forked, including work already committed.'
  }
  return `From where this branch forked off ${target.ref}, committed work included.`
}

export interface DiffTargetChoice {
  readonly description: string
  readonly key: string
  readonly label: string
  readonly target: DiffTarget
}

const refChoice = (ref: string): DiffTargetChoice => {
  const target: DiffTarget = { _tag: 'ref', ref }
  return {
    description: diffTargetDescription(target),
    key: diffTargetKey(target),
    label: ref,
    target,
  }
}

/**
 * The menu's items, in order.
 *
 * The current selection is always one of them: a ref typed in by hand is
 * appended to the suggestions so the checked item is never off the list,
 * which is what keeps the menu readable as "here is where you are".
 */
export const diffTargetChoices = (
  selected: DiffTarget
): readonly DiffTargetChoice[] => {
  const refs = [...DIFF_TARGET_REF_SUGGESTIONS]
  if (selected._tag === 'ref' && !refs.includes(selected.ref)) {
    refs.push(selected.ref)
  }

  return [
    {
      description: diffTargetDescription({ _tag: 'working' }),
      key: 'working',
      label: 'Uncommitted changes',
      target: { _tag: 'working' },
    },
    {
      description: diffTargetDescription({ _tag: 'branch' }),
      key: 'branch',
      label: 'Everything on this branch',
      target: { _tag: 'branch' },
    },
    ...refs.map(refChoice),
  ]
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface FileDiffRequest {
  /** Adds `-w`, so a reindent stops drowning the change that matters. */
  readonly ignoreWhitespace: boolean
  readonly target: DiffTarget
  readonly workspaceId: string
}

/**
 * `Atom.family` keys by identity, so the key has to be a primitive: two
 * panes asking the same question must land on the same atom, and a pane
 * that changes target must land on a different one. This separator cannot
 * occur in a workspace id, a git ref, or a target tag.
 */
const KEY_SEPARATOR = '\u0000'

/**
 * Reduce a request to its cache key. `workspaceId` goes last so it is the
 * only field that has to survive a rejoin, which keeps the parse total.
 */
export const fileDiffRequestKey = (request: FileDiffRequest): string =>
  [
    request.ignoreWhitespace ? 'w' : '-',
    diffTargetKey(request.target),
    request.workspaceId,
  ].join(KEY_SEPARATOR)

/** The inverse, `null` for anything this module did not write. */
export const parseFileDiffRequestKey = (
  key: string
): FileDiffRequest | null => {
  const [whitespaceFlag, targetKey, ...workspaceParts] =
    key.split(KEY_SEPARATOR)
  if (whitespaceFlag === undefined || targetKey === undefined) {
    return null
  }
  const target = parseDiffTargetKey(targetKey)
  const workspaceId = workspaceParts.join(KEY_SEPARATOR)
  if (target === null || workspaceId.length === 0) {
    return null
  }
  return {
    ignoreWhitespace: whitespaceFlag === 'w',
    target,
    workspaceId,
  }
}

/**
 * The `file.diff` payload for a request.
 *
 * Both optional fields are sent explicitly rather than omitted at their
 * defaults, so the wire says what the pane is showing instead of leaving
 * the reader of a trace to remember what the default was.
 */
export const fileDiffPayload = (request: FileDiffRequest) => ({
  ignoreWhitespace: request.ignoreWhitespace,
  target: request.target,
  workspaceId: request.workspaceId,
})

// ---------------------------------------------------------------------------
// The ways a repository declines to answer
// ---------------------------------------------------------------------------

export type DiffTargetUnresolvedReason =
  | 'MERGE_BASE_FAILED'
  | 'NO_BASE_BRANCH'
  | 'REF_NOT_FOUND'

export interface DiffTargetFailure {
  /** The server's own sentence, renderable as-is. */
  readonly message: string
  readonly reason: DiffTargetUnresolvedReason
  readonly ref: string | null
}

const UNRESOLVED_REASONS: readonly string[] = [
  'MERGE_BASE_FAILED',
  'NO_BASE_BRANCH',
  'REF_NOT_FOUND',
]

/**
 * Recognise `DiffTargetUnresolved` in a failed result.
 *
 * These are the ordinary ways a repository says no — a worktree with no
 * recorded base branch, a ref that is not fetched, a grafted history —
 * so the pane treats them as a state it can render and offer a way out
 * of, not as the generic "failed to compute diff" banner.
 */
export const asDiffTargetFailure = (
  error: unknown
): DiffTargetFailure | null => {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const candidate = error as Record<string, unknown>
  if (candidate._tag !== 'DiffTargetUnresolved') {
    return null
  }
  const { message, reason, ref } = candidate
  if (typeof reason !== 'string' || !UNRESOLVED_REASONS.includes(reason)) {
    return null
  }
  return {
    message: typeof message === 'string' ? message : '',
    reason: reason as DiffTargetUnresolvedReason,
    ref: typeof ref === 'string' ? ref : null,
  }
}

export interface DiffTargetFailureCopy {
  /** What to do about it, in one sentence. */
  readonly guidance: string
  readonly title: string
}

/**
 * A heading and a sentence a person can act on, for each reason.
 *
 * The server's `message` is rendered between the two and carries the
 * specifics — which ref, which repository state — so the title stays a
 * short categorical heading rather than repeating it, and the guidance
 * says what to do next, which is the part a diff pane with a target menu
 * in its header can actually offer.
 */
export const describeDiffTargetFailure = (
  failure: DiffTargetFailure
): DiffTargetFailureCopy => {
  const named = failure.ref === null ? 'that ref' : failure.ref

  if (failure.reason === 'NO_BASE_BRANCH') {
    return {
      guidance:
        'Nothing records where this branch forked from, so there is no fork point to measure. Name a base ref yourself, or go back to uncommitted changes.',
      title: 'No base branch to compare against',
    }
  }

  if (failure.reason === 'REF_NOT_FOUND') {
    return {
      guidance: `Fetch ${named} into this repository, or pick a ref it already has.`,
      title: 'No such ref in this repository',
    }
  }

  return {
    guidance: `This branch and ${named} have no common ancestor, so git cannot say where they diverged. Pick a ref from the same history.`,
    title: 'No shared history to fork from',
  }
}
