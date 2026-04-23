const LIVESTORE_PERSISTENCE_RESET_FLAG =
  'laborer:livestore-reset-persistence-on-next-boot'
const LIVESTORE_PERSISTENCE_RESET_ATTEMPT =
  'laborer:livestore-reset-persistence-attempted'

const RECOVERABLE_PERSISTENCE_ERROR_SNIPPETS = [
  'During boot the backend head',
  'Encountered empty or corrupted database',
] as const

export const LIVESTORE_FATAL_ERROR_MESSAGE = 'laborer:livestore-fatal-error'

export const isRecoverablePersistenceError = (cause: string): boolean =>
  RECOVERABLE_PERSISTENCE_ERROR_SNIPPETS.some((snippet) =>
    cause.includes(snippet)
  )

/**
 * Consume a one-shot flag instructing the next LiveStore boot to clear the
 * local OPFS cache before starting. This only affects the renderer cache;
 * the server-side store remains the source of truth.
 */
export const consumePendingPersistenceReset = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    const shouldReset =
      window.localStorage.getItem(LIVESTORE_PERSISTENCE_RESET_FLAG) === '1'

    if (!shouldReset) {
      return false
    }

    window.localStorage.removeItem(LIVESTORE_PERSISTENCE_RESET_FLAG)
    return true
  } catch {
    return false
  }
}

/**
 * Schedule a one-time cache reset for the next page load. The session-scoped
 * guard prevents infinite reload loops if the reset does not resolve the
 * underlying failure.
 */
export const schedulePersistenceResetRecovery = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    if (
      window.sessionStorage.getItem(LIVESTORE_PERSISTENCE_RESET_ATTEMPT) === '1'
    ) {
      return false
    }

    window.sessionStorage.setItem(LIVESTORE_PERSISTENCE_RESET_ATTEMPT, '1')
    window.localStorage.setItem(LIVESTORE_PERSISTENCE_RESET_FLAG, '1')
    return true
  } catch {
    return false
  }
}
