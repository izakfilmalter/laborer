/**
 * Terminal RPC Handlers
 *
 * Implements handler logic for the TerminalRpcs group defined in
 * `@laborer/shared/rpc`. Each handler delegates to the TerminalManager
 * Effect service for the actual terminal operations.
 *
 * The handler layer (`TerminalRpcsLive`) is wired into the terminal
 * service's `main.ts` via `RpcServer.layer(TerminalRpcs)` at `POST /rpc`.
 *
 * Pattern follows the server's `LaborerRpcsLive` in
 * `packages/server/src/rpc/handlers.ts`:
 * - Destructure payload from each RPC call
 * - `yield* ServiceTag` to access Effect services
 * - Delegate to service methods
 * - Return shaped responses matching the success schema
 *
 * @see PRD-terminal-extraction.md
 * @see Issue #139: Terminal RPC handlers
 */

import { TerminalRpcs } from "@laborer/shared/rpc";
import { Effect } from "effect";
import { TerminalManager } from "../services/terminal-manager.js";

/**
 * Converts a TerminalRecord (from TerminalManager) to the TerminalInfo
 * shape expected by the RPC response schema. The two types have the same
 * fields, but we spread explicitly for type safety — if the schemas
 * diverge in the future, this function will catch the mismatch at
 * compile time.
 */
const toTerminalInfo = (record: {
	readonly args: readonly string[];
	readonly command: string;
	readonly cwd: string;
	readonly id: string;
	readonly status: "running" | "stopped";
	readonly workspaceId: string;
}) => ({
	id: record.id,
	workspaceId: record.workspaceId,
	command: record.command,
	args: [...record.args],
	cwd: record.cwd,
	status: record.status,
});

/**
 * RPC handler layer for the TerminalRpcs group.
 *
 * All 7 terminal RPC endpoints are implemented:
 * - terminal.spawn: creates a new PTY with command, cwd, env, dimensions
 * - terminal.write: sends input data to a terminal's PTY stdin
 * - terminal.resize: resizes a terminal's PTY dimensions
 * - terminal.kill: stops the PTY process (terminal retained in memory)
 * - terminal.remove: kills (if running) and fully removes from memory
 * - terminal.restart: kills and respawns with same command/config
 * - terminal.list: returns all terminals (running and stopped)
 */
export const TerminalRpcsLive = TerminalRpcs.toLayer(
	TerminalRpcs.of({
		// -------------------------------------------------------------------
		// terminal.spawn — create a new terminal
		// -------------------------------------------------------------------
		"terminal.spawn": ({ command, args, cwd, env, cols, rows, workspaceId }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				const record = yield* tm.spawn({
					command,
					args: args ?? [],
					cwd,
					env: env ?? undefined,
					cols,
					rows,
					workspaceId,
				});
				return toTerminalInfo(record);
			}),

		// -------------------------------------------------------------------
		// terminal.write — send input to a terminal
		// -------------------------------------------------------------------
		"terminal.write": ({ id, data }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.write(id, data);
			}),

		// -------------------------------------------------------------------
		// terminal.resize — resize a terminal's PTY
		// -------------------------------------------------------------------
		"terminal.resize": ({ id, cols, rows }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.resize(id, cols, rows);
			}),

		// -------------------------------------------------------------------
		// terminal.kill — stop the PTY (terminal retained in memory)
		// -------------------------------------------------------------------
		"terminal.kill": ({ id }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(id);
			}),

		// -------------------------------------------------------------------
		// terminal.remove — kill (if running) and fully remove from memory
		// -------------------------------------------------------------------
		"terminal.remove": ({ id }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.remove(id);
			}),

		// -------------------------------------------------------------------
		// terminal.restart — kill and respawn with same command/config
		// -------------------------------------------------------------------
		"terminal.restart": ({ id }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				const record = yield* tm.restart(id);
				return toTerminalInfo(record);
			}),

		// -------------------------------------------------------------------
		// terminal.list — return all terminals (running + stopped)
		// -------------------------------------------------------------------
		"terminal.list": () =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				const records = yield* tm.listTerminals();
				return records.map(toTerminalInfo);
			}),
	})
);
