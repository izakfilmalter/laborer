import { useSyncExternalStore } from 'react'
import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  subscribeToWsConnectionStatus,
  type WsConnectionStatus,
} from '@/atoms/ws-connection-state'
import type { ServiceState } from '@/lib/sidecar-statuses'

const SERVER_DOWN_MESSAGE = 'Server connection unavailable'

/**
 * Combine process health with the actual RPC transport state. A running
 * sidecar is not healthy from the renderer's perspective until RPC connects.
 */
export function deriveServerConnectionState(
  transport: WsConnectionStatus,
  server: ServiceState
): ServiceState {
  if (server.state === 'crashed' || server.state === 'down') {
    return {
      state: 'down',
      error: server.error,
    }
  }

  const transportState = getWsConnectionUiState(transport)

  if (transportState === 'error' || transportState === 'offline') {
    return {
      state: 'down',
      error: transport.lastError ?? SERVER_DOWN_MESSAGE,
    }
  }

  if (transport.reconnectPhase === 'exhausted') {
    return {
      state: 'down',
      error: transport.lastError ?? SERVER_DOWN_MESSAGE,
    }
  }

  if (
    transportState === 'connected' &&
    (server.state === 'healthy' || server.state === 'unresponsive')
  ) {
    return { state: 'healthy' }
  }

  return { state: 'reconnecting' }
}

export function useServerConnectionState(server: ServiceState): ServiceState {
  const transport = useSyncExternalStore(
    subscribeToWsConnectionStatus,
    getWsConnectionStatus,
    getWsConnectionStatus
  )

  return deriveServerConnectionState(transport, server)
}
