/**
 * TerminalServiceClient — AtomRpc client for the standalone terminal service.
 *
 * Communicates through the renderer protocol boundary. In a plain browser all
 * terminal lifecycle RPCs share the daemon's same-origin `/ws`; Electron keeps
 * its direct MessagePort connection until the desktop migration lands.
 *
 * This is separate from LaborerClient (which talks to the main server).
 * The terminal service manages PTY processes, terminal lifecycle, and
 * terminal state independently.
 *
 * @see Issue #9: Renderer terminal UI wired to MessagePort
 * @see packages/terminal/src/utility-main.ts — Terminal utility process entry
 */

import { TerminalRpcs } from '@laborer/shared/rpc'
import { AtomRpc } from 'effect/unstable/reactivity'
import { isElectron } from '@/lib/desktop'
import { BrowserDaemonClient } from './browser-daemon-client'
import { rendererRpcProtocol } from './renderer-rpc-protocol'

const terminalProtocol = rendererRpcProtocol('terminal')

/**
 * TerminalServiceClient — typed AtomRpc client for the terminal service.
 *
 * Provides `mutation` and `query` helpers for all TerminalRpcs endpoints:
 * - terminal.spawn, terminal.write, terminal.resize, terminal.kill
 * - terminal.remove, terminal.restart, terminal.list
 */
class LegacyTerminalServiceClient extends AtomRpc.Service<LegacyTerminalServiceClient>()(
  'LegacyTerminalServiceClient',
  {
    group: TerminalRpcs,
    protocol: terminalProtocol,
  }
) {}

/** Browser terminal calls share the exact daemon client/runtime with all other RPCs. */
export const TerminalServiceClient: typeof LegacyTerminalServiceClient =
  isElectron()
    ? LegacyTerminalServiceClient
    : (BrowserDaemonClient as unknown as typeof LegacyTerminalServiceClient)
