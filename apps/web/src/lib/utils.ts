import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Unwrap an Effect Cause wrapper to get the inner error.
 *
 * Query atoms return `Result.Failure` whose `cause` is an Effect `Cause<E>`,
 * not a bare error. A `Cause.Fail<E>` has shape `{ _tag: "Fail", error: E }`.
 * This helper recurses through the wrapper so extract helpers work uniformly
 * for both query results and mutation catch blocks (which already receive the
 * unwrapped error).
 */
function unwrapCause(error: unknown): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    (error as Record<string, unknown>)._tag === 'Fail' &&
    'error' in error
  ) {
    return unwrapCause((error as Record<string, unknown>).error)
  }
  return error
}

/**
 * Extract a human-readable error message from an unknown error.
 * Handles Error instances, plain objects with a `message` property,
 * and Effect Cause wrappers (e.g. `Cause.Fail<RpcError>`).
 */
export function extractErrorMessage(error: unknown): string {
  const unwrapped = unwrapCause(error)
  if (unwrapped instanceof Error) {
    return unwrapped.message
  }
  if (
    typeof unwrapped === 'object' &&
    unwrapped !== null &&
    'message' in unwrapped &&
    typeof (unwrapped as Record<string, unknown>).message === 'string'
  ) {
    return String((unwrapped as Record<string, unknown>).message)
  }
  return 'An unexpected error occurred'
}

/**
 * Extract the error code from an RPC error.
 * Returns undefined if the error doesn't have a code property.
 * Handles Effect Cause wrappers (e.g. `Cause.Fail<RpcError>`).
 *
 * @see Issue #49: Workspace creation error display
 */
export function extractErrorCode(error: unknown): string | undefined {
  const unwrapped = unwrapCause(error)
  if (
    typeof unwrapped === 'object' &&
    unwrapped !== null &&
    'code' in unwrapped &&
    typeof (unwrapped as Record<string, unknown>).code === 'string'
  ) {
    return String((unwrapped as Record<string, unknown>).code)
  }
  return undefined
}
