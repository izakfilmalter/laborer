/**
 * LaborerClient — AtomRpc client for the server's LaborerRpcs.
 *
 * Communicates with the mission-control backend through the renderer protocol
 * boundary: same-origin daemon WebSocket in a browser, legacy MessagePort in
 * Electron until the desktop migration lands.
 *
 * Uses `AtomRpc.Service` to provide typed `query` and `mutation` atoms that
 * integrate with React components via `@effect/atom-react`.
 *
 * @see Issue #4: Renderer RPC client wired to MessagePort
 * @see packages/server/src/utility-main.ts — Server utility process entry
 */

import { LaborerRpcs } from '@laborer/shared/rpc'
import { AtomRpc } from 'effect/unstable/reactivity'
import { rendererRpcProtocol } from './renderer-rpc-protocol'

const serverProtocol = rendererRpcProtocol('server')

/**
 * LaborerClient — typed AtomRpc client for React components.
 *
 * Uses WS RPC in a plain browser and the existing desktop transport in Electron.
 * Provides `mutation` and `query` helpers for all LaborerRpcs endpoints.
 */
export const ConfigReactivityKeys = ['config'] as const

export class LaborerClient extends AtomRpc.Service<LaborerClient>()(
  'LaborerClient',
  {
    group: LaborerRpcs,
    protocol: serverProtocol,
  }
) {}
