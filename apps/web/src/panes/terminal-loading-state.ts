type ReplayStatus = 'idle' | 'replaying' | 'complete'

/**
 * Replay owns the loading overlay outright.
 *
 * Ghostty parses synchronously, so the daemon's `ReplayComplete` is the whole
 * truth: by the time it arrives every replayed frame is already on screen.
 * `idle` is a replay that has opened over nothing the operator has seen — a
 * fresh pane — so it shows startup rather than claiming to restore.
 *
 * A stopped terminal replays its final screen like any other, so restoring
 * covers it too. Only the startup message is exclusive to a running terminal:
 * a dead process will never produce the first output it promises.
 *
 * @see apps/web/src/lib/terminal-attach-loop.ts — where the status comes from
 */
export const terminalLoadingMessage = ({
  isRunning,
  replayStatus,
}: {
  readonly isRunning: boolean
  readonly replayStatus: ReplayStatus
}): 'Restoring terminal...' | 'Starting terminal...' | undefined => {
  if (replayStatus === 'replaying') {
    return 'Restoring terminal...'
  }
  if (isRunning && replayStatus === 'idle') {
    return 'Starting terminal...'
  }
  return undefined
}

/**
 * The revival marker labels history the operator can see. It waits for the
 * restored buffer to reach the screen, otherwise it narrates output that has
 * not been rendered yet.
 */
export const showTerminalRevivalMarker = ({
  replayStatus,
  wasRevived,
}: {
  readonly replayStatus: ReplayStatus
  readonly wasRevived: boolean
}): boolean => wasRevived && replayStatus === 'complete'
