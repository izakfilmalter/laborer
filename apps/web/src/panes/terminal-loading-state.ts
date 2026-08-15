type ReplayStatus = 'idle' | 'replaying' | 'complete'

/**
 * Replay owns reconnect loading; parsed output remains received afterward.
 *
 * `replayStatus` reaches `complete` only once the backend has finished sending
 * replay frames *and* xterm has parsed them, so `hasReceivedData` — which stays
 * true across a reconnect from the previous session's output — can never lift
 * the overlay off a screen that still shows stale content.
 *
 * A stopped terminal replays its final screen like any other, so restoring
 * covers it too. Only the startup message is exclusive to a running terminal:
 * a dead process will never produce the first output it promises.
 *
 * @see apps/web/src/hooks/use-terminal-rpc.ts — createReplayCoordinator
 */
export const terminalLoadingMessage = ({
  hasReceivedData,
  isRunning,
  replayStatus,
}: {
  readonly hasReceivedData: boolean
  readonly isRunning: boolean
  readonly replayStatus: ReplayStatus
}): 'Restoring terminal...' | 'Starting terminal...' | undefined => {
  if (replayStatus === 'replaying') {
    return 'Restoring terminal...'
  }
  if (isRunning && !hasReceivedData) {
    return 'Starting terminal...'
  }
  return undefined
}

/**
 * The revival marker labels history the operator can see. It waits for the
 * restored buffer to be parsed onto the screen, otherwise it narrates output
 * that has not been rendered yet.
 */
export const showTerminalRevivalMarker = ({
  replayStatus,
  wasRevived,
}: {
  readonly replayStatus: ReplayStatus
  readonly wasRevived: boolean
}): boolean => wasRevived && replayStatus === 'complete'
