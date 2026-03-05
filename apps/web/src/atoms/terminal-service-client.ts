/**
 * TerminalServiceClient — AtomRpc client for the standalone terminal service.
 *
 * Connects to the terminal service's RPC endpoint at /terminal-rpc
 * (proxied by Vite to the terminal service's /rpc at TERMINAL_PORT).
 * Uses the TerminalRpcs group from @laborer/shared/rpc.
 *
 * This is separate from LaborerClient (which talks to the main server).
 * The terminal service manages PTY processes, terminal lifecycle, and
 * terminal state independently.
 *
 * @see Issue #144: Web app LiveStore terminal query replacement
 * @see packages/terminal/src/main.ts — Terminal service entry point
 */

import { FetchHttpClient } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { AtomRpc } from "@effect-atom/atom";
import { TerminalRpcs } from "@laborer/shared/rpc";
import { Layer } from "effect";

/**
 * Terminal service RPC URL.
 *
 * In development, Vite proxies /terminal-rpc to the terminal service's
 * /rpc endpoint at TERMINAL_PORT (default 3002).
 */
const TERMINAL_RPC_URL = "/terminal-rpc";

/**
 * TerminalServiceClient — typed AtomRpc client for the terminal service.
 *
 * Provides `mutation` and `query` helpers for all TerminalRpcs endpoints:
 * - terminal.spawn, terminal.write, terminal.resize, terminal.kill
 * - terminal.remove, terminal.restart, terminal.list
 */
export class TerminalServiceClient extends AtomRpc.Tag<TerminalServiceClient>()(
	"TerminalServiceClient",
	{
		group: TerminalRpcs,
		protocol: RpcClient.layerProtocolHttp({ url: TERMINAL_RPC_URL }).pipe(
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(RpcSerialization.layerJson)
		),
	}
) {}
