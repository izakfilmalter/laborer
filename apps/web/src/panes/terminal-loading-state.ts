type ReplayStatus = 'idle' | 'replaying' | 'complete'

/** Replay owns reconnect loading; parsed output remains received afterward. */
export const terminalLoadingMessage = ({
  hasReceivedData,
  isRunning,
  replayStatus,
}: {
  readonly hasReceivedData: boolean
  readonly isRunning: boolean
  readonly replayStatus: ReplayStatus
}): 'Restoring terminal...' | 'Starting terminal...' | undefined => {
  if (!isRunning || (hasReceivedData && replayStatus !== 'replaying')) {
    return undefined
  }
  return replayStatus === 'replaying'
    ? 'Restoring terminal...'
    : 'Starting terminal...'
}
