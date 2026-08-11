export type WsConnectionUiState =
  | 'connected'
  | 'connecting'
  | 'error'
  | 'offline'
  | 'reconnecting'
export type WsReconnectPhase = 'attempting' | 'exhausted' | 'idle' | 'waiting'

export const WS_RECONNECT_INITIAL_DELAY_MS = 1000
export const WS_RECONNECT_BACKOFF_FACTOR = 2
export const WS_RECONNECT_MAX_DELAY_MS = 64_000
export const WS_RECONNECT_MAX_RETRIES = 7
export const WS_RECONNECT_MAX_ATTEMPTS = WS_RECONNECT_MAX_RETRIES + 1

export interface WsConnectionStatus {
  readonly attemptCount: number
  readonly closeCode: number | null
  readonly closeReason: string | null
  readonly connectedAt: string | null
  readonly disconnectedAt: string | null
  readonly hasConnected: boolean
  readonly lastError: string | null
  readonly lastErrorAt: string | null
  readonly nextRetryAt: string | null
  readonly online: boolean
  readonly phase: 'connected' | 'connecting' | 'disconnected' | 'idle'
  readonly reconnectAttemptCount: number
  readonly reconnectMaxAttempts: number
  readonly reconnectPhase: WsReconnectPhase
  readonly socketUrl: string | null
}

const INITIAL_WS_CONNECTION_STATUS = Object.freeze<WsConnectionStatus>({
  attemptCount: 0,
  closeCode: null,
  closeReason: null,
  connectedAt: null,
  disconnectedAt: null,
  hasConnected: false,
  lastError: null,
  lastErrorAt: null,
  nextRetryAt: null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  phase: 'idle',
  reconnectAttemptCount: 0,
  reconnectMaxAttempts: WS_RECONNECT_MAX_ATTEMPTS,
  reconnectPhase: 'idle',
  socketUrl: null,
})

let wsConnectionStatus = INITIAL_WS_CONNECTION_STATUS
const wsConnectionListeners = new Set<() => void>()

function isoNow(): string {
  return new Date().toISOString()
}

function updateWsConnectionStatus(
  updater: (current: WsConnectionStatus) => WsConnectionStatus
): WsConnectionStatus {
  wsConnectionStatus = updater(wsConnectionStatus)
  for (const listener of wsConnectionListeners) {
    listener()
  }
  return wsConnectionStatus
}

export function getWsConnectionStatus(): WsConnectionStatus {
  return wsConnectionStatus
}

/** Subscribe to transport changes for React's useSyncExternalStore. */
export function subscribeToWsConnectionStatus(
  listener: () => void
): () => void {
  wsConnectionListeners.add(listener)
  return () => {
    wsConnectionListeners.delete(listener)
  }
}

export function getWsConnectionUiState(
  status: WsConnectionStatus
): WsConnectionUiState {
  if (status.phase === 'connected') {
    return 'connected'
  }

  if (
    !status.online &&
    (status.disconnectedAt !== null || status.phase === 'disconnected')
  ) {
    return 'offline'
  }

  if (!status.hasConnected) {
    return status.phase === 'disconnected' ? 'error' : 'connecting'
  }

  return 'reconnecting'
}

export function recordWsConnectionAttempt(
  socketUrl: string
): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    attemptCount: current.attemptCount + 1,
    nextRetryAt: null,
    phase: 'connecting',
    reconnectAttemptCount:
      current.phase === 'connected' ? 1 : current.reconnectAttemptCount + 1,
    reconnectPhase: 'attempting',
    socketUrl,
  }))
}

export function recordWsConnectionOpened(): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    closeCode: null,
    closeReason: null,
    connectedAt: isoNow(),
    disconnectedAt: null,
    hasConnected: true,
    nextRetryAt: null,
    phase: 'connected',
    reconnectAttemptCount: 0,
    reconnectPhase: 'idle',
  }))
}

export function recordWsConnectionErrored(
  message?: null | string
): WsConnectionStatus {
  return updateWsConnectionStatus((current) =>
    applyDisconnectState(current, {
      lastError: message?.trim() ? message : current.lastError,
      lastErrorAt: isoNow(),
    })
  )
}

export function recordWsConnectionClosed(details?: {
  readonly code?: number
  readonly reason?: string
}): WsConnectionStatus {
  return updateWsConnectionStatus((current) =>
    applyDisconnectState(current, {
      closeCode: details?.code ?? current.closeCode,
      closeReason: details?.reason?.trim()
        ? details.reason
        : current.closeReason,
    })
  )
}

export function setBrowserOnlineStatus(online: boolean): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    online,
  }))
}

export function resetWsReconnectBackoff(): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    nextRetryAt: null,
    reconnectAttemptCount: 0,
    reconnectPhase: 'idle',
  }))
}

export function resetWsConnectionStateForTests(): void {
  wsConnectionStatus = INITIAL_WS_CONNECTION_STATUS
  for (const listener of wsConnectionListeners) {
    listener()
  }
}

export function getWsReconnectDelayMsForRetry(
  retryIndex: number
): number | null {
  if (
    !Number.isInteger(retryIndex) ||
    retryIndex < 0 ||
    retryIndex >= WS_RECONNECT_MAX_RETRIES
  ) {
    return null
  }

  return Math.min(
    Math.round(
      WS_RECONNECT_INITIAL_DELAY_MS * WS_RECONNECT_BACKOFF_FACTOR ** retryIndex
    ),
    WS_RECONNECT_MAX_DELAY_MS
  )
}

function applyDisconnectState(
  current: WsConnectionStatus,
  updates: Partial<
    Pick<
      WsConnectionStatus,
      'closeCode' | 'closeReason' | 'lastError' | 'lastErrorAt'
    >
  >
): WsConnectionStatus {
  const disconnectedAt = current.disconnectedAt ?? isoNow()
  const nextRetryDelayMs =
    current.nextRetryAt !== null || current.reconnectPhase === 'exhausted'
      ? null
      : getWsReconnectDelayMsForRetry(
          Math.max(0, current.reconnectAttemptCount - 1)
        )
  let reconnectPhase: WsReconnectPhase = 'waiting'
  if (
    current.reconnectPhase === 'waiting' ||
    current.reconnectPhase === 'exhausted'
  ) {
    reconnectPhase = current.reconnectPhase
  } else if (nextRetryDelayMs === null) {
    reconnectPhase = 'exhausted'
  }

  return {
    ...current,
    ...updates,
    disconnectedAt,
    nextRetryAt:
      nextRetryDelayMs === null
        ? current.nextRetryAt
        : new Date(Date.now() + nextRetryDelayMs).toISOString(),
    phase: 'disconnected',
    reconnectPhase,
  }
}
