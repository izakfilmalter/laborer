/**
 * The keyboard commit for inline comment composers.
 *
 * A comment body is multi-line prose, so plain Enter has to stay a newline;
 * Command/Ctrl+Enter is the send. Ported from t3code's
 * `isCommentSubmitShortcut`.
 *
 * The guard also covers the two states the button is disabled in — an empty
 * body and a write already in flight — so the shortcut and the button can
 * never disagree about whether a submit is allowed.
 */

interface CommentSubmitShortcutEvent {
  readonly ctrlKey: boolean
  readonly key: string
  readonly metaKey: boolean
}

export const isCommentSubmitShortcut = (
  event: CommentSubmitShortcutEvent,
  value: string,
  pending: boolean
): boolean =>
  !pending &&
  (event.metaKey || event.ctrlKey) &&
  event.key === 'Enter' &&
  value.trim().length > 0
