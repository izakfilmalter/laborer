const LIVESTORE_PERSISTENCE_RESET_FLAG =
  'laborer:livestore-reset-persistence-on-next-boot'
const LIVESTORE_PERSISTENCE_RESET_ATTEMPT =
  'laborer:livestore-reset-persistence-attempted'
const LIVESTORE_RUNTIME_RECOVERY_INSTALLED =
  '__laborerLiveStoreRuntimeRecoveryInstalled'

const MAX_FORMAT_DEPTH = 4

const RECOVERABLE_PERSISTENCE_ERROR_SNIPPETS = [
  'During boot the backend head',
  'Encountered empty or corrupted database',
  'Failed calling makeChangeset.apply',
  'function signature mismatch',
] as const

export const LIVESTORE_FATAL_ERROR_MESSAGE = 'laborer:livestore-fatal-error'

export const isRecoverablePersistenceError = (cause: string): boolean =>
  RECOVERABLE_PERSISTENCE_ERROR_SNIPPETS.some((snippet) =>
    cause.includes(snippet)
  )

const formatRecoverableErrorValue = (
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): string => {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Error) {
    if (seen.has(value)) {
      return '[Circular Error]'
    }

    seen.add(value)

    if (depth >= MAX_FORMAT_DEPTH) {
      return `${value.name}: ${value.message}`
    }

    const cause =
      value.cause === undefined
        ? ''
        : `\ncause: ${formatRecoverableErrorValue(value.cause, seen, depth + 1)}`
    return `${value.name}: ${value.message}\n${value.stack ?? ''}${cause}`
  }

  if (value === null || typeof value !== 'object') {
    return String(value)
  }

  if (seen.has(value)) {
    return '[Circular]'
  }

  if (depth >= MAX_FORMAT_DEPTH) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  seen.add(value)

  if (Array.isArray(value)) {
    return value
      .map((item) => formatRecoverableErrorValue(item, seen, depth + 1))
      .join(' ')
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return String(value)
  }

  return entries
    .map(
      ([key, entryValue]) =>
        `${key}: ${formatRecoverableErrorValue(entryValue, seen, depth + 1)}`
    )
    .join(' ')
}

export const formatRecoverableErrorCause = (
  values: readonly unknown[]
): string =>
  values
    .map((value) => formatRecoverableErrorValue(value, new WeakSet(), 0))
    .join(' ')

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

export const recoverFromPersistenceError = (
  cause: string,
  reload: () => void = () => globalThis.location.reload()
): boolean => {
  if (!isRecoverablePersistenceError(cause)) {
    return false
  }

  if (!schedulePersistenceResetRecovery()) {
    return false
  }

  console.warn(
    '[LiveStore] Recoverable persisted-state error detected — reloading once with a cleared local cache'
  )
  reload()
  return true
}

type RuntimeRecoveryWindow = Window & {
  [LIVESTORE_RUNTIME_RECOVERY_INSTALLED]?: boolean
}

export const installLiveStoreRuntimeRecovery = (
  target: Window = window,
  reload?: () => void
): (() => void) => {
  const runtimeTarget = target as RuntimeRecoveryWindow
  if (runtimeTarget[LIVESTORE_RUNTIME_RECOVERY_INSTALLED] === true) {
    return () => undefined
  }

  const recover = (values: readonly unknown[], event: Event) => {
    if (
      recoverFromPersistenceError(formatRecoverableErrorCause(values), reload)
    ) {
      event.preventDefault()
    }
  }

  const handleError = (event: ErrorEvent) => {
    recover([event.error, event.message], event)
  }

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    recover([event.reason], event)
  }

  runtimeTarget[LIVESTORE_RUNTIME_RECOVERY_INSTALLED] = true
  target.addEventListener('error', handleError)
  target.addEventListener('unhandledrejection', handleUnhandledRejection)

  return () => {
    target.removeEventListener('error', handleError)
    target.removeEventListener('unhandledrejection', handleUnhandledRejection)
    runtimeTarget[LIVESTORE_RUNTIME_RECOVERY_INSTALLED] = false
  }
}
