/**
 * TerminalServiceClient — AtomRpc client for the standalone terminal service.
 *
 * Communicates through the renderer protocol boundary. In a plain browser all
 * terminal lifecycle RPCs share the daemon's same-origin `/ws`.
 *
 * This is separate from LaborerClient (which talks to the main server).
 * The terminal service manages PTY processes, terminal lifecycle, and
 * terminal state independently.
 *
 * @see packages/server/src/daemon-main.ts — unified RPC server entry
 */

import { BrowserDaemonClient } from './browser-daemon-client'

/**
 * TerminalServiceClient — typed AtomRpc client for the terminal service.
 *
 * Provides `mutation` and `query` helpers for all TerminalRpcs endpoints:
 * - terminal.spawn, terminal.write, terminal.resize, terminal.kill
 * - terminal.remove, terminal.restart, terminal.list
 */
/** Terminal calls share the exact daemon client/runtime with all other RPCs. */
export const TerminalServiceClient = BrowserDaemonClient
