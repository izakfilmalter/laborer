/**
 * LaborerClient — AtomRpc client for the server's LaborerRpcs.
 *
 * Communicates with the mission-control backend through the renderer protocol
 * boundary: the daemon's same-origin WebSocket in browsers and Electron.
 *
 * Uses `AtomRpc.Service` to provide typed `query` and `mutation` atoms that
 * integrate with React components via `@effect/atom-react`.
 *
 * @see packages/server/src/daemon-main.ts — unified RPC server entry
 */

import { BrowserDaemonClient } from './browser-daemon-client'

/**
 * LaborerClient — typed AtomRpc client for React components.
 *
 * Uses WS RPC in a plain browser and the existing desktop transport in Electron.
 * Provides `mutation` and `query` helpers for all LaborerRpcs endpoints.
 */
export const ConfigReactivityKeys = ['config'] as const

/**
 * Reactivity keys for one workspace's git sync status, so a push or pull
 * refreshes every view of that workspace's ahead/behind counts.
 */
export const workspaceSyncReactivityKeys = (
  workspaceId: string
): Record<string, readonly string[]> => ({
  'workspace-sync': [workspaceId],
})

export const LaborerClient = BrowserDaemonClient
