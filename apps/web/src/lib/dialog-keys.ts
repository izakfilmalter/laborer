/**
 * Pure keyboard event helpers for destructive confirmation dialogs.
 *
 * Confirmation dialogs (delete workspace, close terminal) require Cmd+Enter
 * to confirm the destructive action. Plain Enter is blocked to prevent
 * accidental confirmation.
 *
 * @see apps/web/test/dialog-keys.test.ts
 */

/**
 * Returns true when the event is a plain Enter with no modifier keys.
 * Used to block accidental confirmation in destructive dialogs.
 */
function isExactEnter(
  event: Pick<
    KeyboardEvent,
    'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
  >
): boolean {
  return (
    event.key === 'Enter' &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

/**
 * Returns true when the event is Cmd+Enter with no other modifier keys.
 * Used to confirm the destructive action in confirmation dialogs.
 */
function isMetaEnter(
  event: Pick<
    KeyboardEvent,
    'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
  >
): boolean {
  return (
    event.key === 'Enter' &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

export { isExactEnter, isMetaEnter }
