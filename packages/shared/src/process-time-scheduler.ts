/**
 * Process-time (awake-time) scheduler.
 *
 * A `setTimeout` scheduled with wall-clock time fires immediately after the
 * machine wakes from sleep — for a destructive timer (killing a terminal,
 * declaring a port dead) that turns OS sleep into a false positive.
 *
 * This scheduler counts elapsed time with a coarse 1-second `setInterval`
 * countdown instead. Interval callbacks do not run while the OS sleeps, so
 * a 60s timeout followed by an 8-hour sleep fires 60 seconds of *awake*
 * time after scheduling — never "at wake".
 *
 * Per ADR 0003, every timer whose expiry destroys state or triggers
 * recovery must use this scheduler. Wall-clock timers remain fine for
 * non-destructive work (backoff delays, UI debounce).
 *
 * > **NOTE**: Resolution is 1 second.
 *
 * @see .reference/vscode/src/vs/base/common/async.ts — `ProcessTimeRunOnceScheduler`
 * @see docs/adr/0003-advisory-liveness-explicit-terminal-lifecycle.md
 */

/** Countdown tick resolution (ms). */
export const PROCESS_TIME_TICK_MS = 1000

/** Handle for a scheduled process-time timeout. */
export interface ProcessTimeTimeout {
  /** Cancel the timeout. Safe to call multiple times. */
  readonly cancel: () => void
  /** Whether the timeout is still pending. */
  readonly isScheduled: () => boolean
}

export interface ProcessTimeTimeoutOptions {
  /**
   * Unref the underlying interval so it does not keep the Node.js
   * process alive. No-op in browser environments.
   */
  readonly unref?: boolean
}

/**
 * Schedule `runner` to fire after `delayMs` of process-alive time.
 *
 * Delays that are not a multiple of 1000ms are rounded up to the next
 * whole second (the countdown only has 1s resolution).
 */
export function scheduleProcessTimeTimeout(
  runner: () => void,
  delayMs: number,
  options?: ProcessTimeTimeoutOptions
): ProcessTimeTimeout {
  let remainingTicks = Math.max(1, Math.ceil(delayMs / PROCESS_TIME_TICK_MS))

  let intervalId: ReturnType<typeof setInterval> | null = setInterval(() => {
    remainingTicks -= 1
    if (remainingTicks > 0) {
      return
    }
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
    runner()
  }, PROCESS_TIME_TICK_MS)

  if (options?.unref === true) {
    // Node.js timers expose unref(); browser intervals do not.
    const maybeUnref = intervalId as unknown as { unref?: () => void }
    maybeUnref.unref?.()
  }

  return {
    cancel: () => {
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
    },
    isScheduled: () => intervalId !== null,
  }
}
