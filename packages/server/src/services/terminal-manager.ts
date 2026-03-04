/**
 * TerminalManager — Effect Service
 *
 * Manages PTY (pseudo-terminal) instances scoped to workspaces. Spawns
 * processes via node-pty, streams I/O, handles resize, and tracks terminal
 * lifecycle. The fundamental primitive — an "agent" is just a terminal
 * running `opencode` or `rlph`.
 *
 * Responsibilities:
 * - PTY spawning via node-pty in workspace directories
 * - I/O streaming: stdout → LiveStore events, stdin ← RPC writes
 * - Terminal resize (cols, rows) with SIGWINCH propagation
 * - Terminal kill + resource cleanup
 * - Multiple terminals per workspace, each tracked by unique ID
 * - Workspace env var injection (PORT, LABORER_* vars)
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const tm = yield* TerminalManager
 *   const terminal = yield* tm.spawn("workspace-id", "bash")
 *   yield* tm.write(terminal.id, "echo hello\n")
 *   yield* tm.resize(terminal.id, 120, 40)
 *   yield* tm.kill(terminal.id)
 * })
 * ```
 *
 * Issue #44: kill all workspace processes on destroy (killAllForWorkspace method)
 * Issue #50: spawn PTY
 * Issue #51: stream stdout to LiveStore (included — output events emitted on data)
 * Issue #52: write to stdin (included — write method sends data to PTY)
 * Issue #53: resize PTY (included — resize method updates PTY dimensions)
 * Issue #54: kill PTY (included — kill method terminates process and cleans up)
 * Issue #55: multiple terminals per workspace (included — Map tracks all terminals)
 */

import { RpcError } from "@laborer/shared/rpc";
import { events, tables } from "@laborer/shared/schema";
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	pipe,
	Ref,
	Runtime,
} from "effect";
import type { IPty } from "node-pty";
import { LaborerStore } from "./laborer-store.js";
import { WorkspaceProvider } from "./workspace-provider.js";

/**
 * Internal representation of a managed terminal.
 * Tracks the PTY instance and associated metadata.
 */
interface ManagedTerminal {
	readonly command: string;
	readonly id: string;
	readonly pty: IPty;
	readonly workspaceId: string;
}

/**
 * Shape of a terminal record returned by the manager.
 * Matches the fields needed for the TerminalResponse RPC schema.
 */
interface TerminalRecord {
	readonly command: string;
	readonly id: string;
	readonly status: "running" | "stopped";
	readonly workspaceId: string;
}

class TerminalManager extends Context.Tag("@laborer/TerminalManager")<
	TerminalManager,
	{
		/**
		 * Spawn a new PTY in a workspace directory.
		 *
		 * 1. Validates the workspace exists in LiveStore
		 * 2. Gets workspace env vars (PORT, LABORER_*)
		 * 3. Spawns a PTY via node-pty in the worktree directory
		 * 4. Wires stdout to LiveStore TerminalOutput events
		 * 5. Commits TerminalSpawned event to LiveStore
		 *
		 * @param workspaceId - ID of the workspace to spawn the terminal in
		 * @param command - Optional shell command (defaults to user's shell)
		 */
		readonly spawn: (
			workspaceId: string,
			command?: string
		) => Effect.Effect<TerminalRecord, RpcError>;

		/**
		 * Write data to a terminal's stdin.
		 *
		 * @param terminalId - ID of the terminal to write to
		 * @param data - Data to send to the PTY stdin
		 */
		readonly write: (
			terminalId: string,
			data: string
		) => Effect.Effect<void, RpcError>;

		/**
		 * Resize a terminal's PTY dimensions.
		 * Sends SIGWINCH to the process so it can reflow output.
		 *
		 * @param terminalId - ID of the terminal to resize
		 * @param cols - New column count
		 * @param rows - New row count
		 */
		readonly resize: (
			terminalId: string,
			cols: number,
			rows: number
		) => Effect.Effect<void, RpcError>;

		/**
		 * Kill a terminal's PTY process and clean up resources.
		 * Updates LiveStore terminal status to "stopped".
		 *
		 * @param terminalId - ID of the terminal to kill
		 */
		readonly kill: (terminalId: string) => Effect.Effect<void, RpcError>;

		/**
		 * List all terminals for a given workspace.
		 *
		 * @param workspaceId - ID of the workspace
		 */
		readonly listTerminals: (
			workspaceId: string
		) => Effect.Effect<readonly TerminalRecord[], RpcError>;

		/**
		 * Kill all terminals belonging to a workspace.
		 *
		 * Iterates all in-memory terminals, finds those belonging to the given
		 * workspace, and kills each PTY process. Used during workspace destruction
		 * to ensure no orphan processes remain after the worktree is removed.
		 *
		 * Errors from individual terminal kills are logged as warnings but do not
		 * abort the operation — best-effort cleanup ensures maximum resource recovery.
		 *
		 * @param workspaceId - ID of the workspace whose terminals should be killed
		 * @returns The number of terminals that were killed
		 */
		readonly killAllForWorkspace: (
			workspaceId: string
		) => Effect.Effect<number, never>;
	}
>() {
	static readonly layer = Layer.effect(
		TerminalManager,
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;
			const workspaceProvider = yield* WorkspaceProvider;

			// Extract the runtime so we can run Effects from plain JS callbacks
			// (e.g., node-pty onExit/onData handlers). This avoids the
			// Effect.runSync-inside-Effect anti-pattern.
			const runtime = yield* Effect.runtime<never>();
			const runSync = Runtime.runSync(runtime);

			// In-memory map of terminal ID → ManagedTerminal.
			// Uses Effect.Ref for fiber-safe concurrent access.
			const terminalsRef = yield* Ref.make(new Map<string, ManagedTerminal>());

			// Lazily import node-pty to avoid native module load at import time.
			// node-pty includes native bindings that should only load when the
			// layer is actually constructed (not during module evaluation).
			const nodePty = yield* Effect.promise(
				() => import("node-pty") as Promise<typeof import("node-pty")>
			);

			/**
			 * Detect the user's default shell.
			 * Falls back to /bin/sh if SHELL env var is not set.
			 */
			const defaultShell = process.env.SHELL ?? "/bin/sh";

			const spawn = Effect.fn("TerminalManager.spawn")(function* (
				workspaceId: string,
				command?: string
			) {
				console.log("[TM.spawn] START ws=%s cmd=%s", workspaceId, command);
				// 1. Validate workspace exists and get its info
				const allWorkspaces = store.query(tables.workspaces);
				const workspaceOpt = pipe(
					allWorkspaces,
					Arr.findFirst((w) => w.id === workspaceId)
				);

				if (workspaceOpt._tag === "None") {
					return yield* new RpcError({
						message: `Workspace not found: ${workspaceId}`,
						code: "NOT_FOUND",
					});
				}

				const workspace = workspaceOpt.value;
				console.log(
					"[TM.spawn] ws.status=%s cwd=%s",
					workspace.status,
					workspace.worktreePath
				);

				// Ensure workspace is in a valid state for spawning terminals
				if (workspace.status !== "running" && workspace.status !== "creating") {
					return yield* new RpcError({
						message: `Workspace ${workspaceId} is in status "${workspace.status}" — cannot spawn terminal`,
						code: "INVALID_STATE",
					});
				}

				// 2. Get workspace environment variables
				const workspaceEnv =
					yield* workspaceProvider.getWorkspaceEnv(workspaceId);

				// 3. Determine the command to run
				const resolvedCommand = command ?? defaultShell;

				// Parse command into shell + args for node-pty.
				// If a custom command is provided, run it via the shell with -c
				// so that pipes, redirects, etc. work. If no command is provided,
				// spawn the shell directly (interactive mode).
				const shellPath = command ? defaultShell : resolvedCommand;
				const shellArgs = command ? ["-c", resolvedCommand] : [];

				// 4. Generate terminal ID
				const id = crypto.randomUUID();

				const spawnTime = Date.now();

				// 5. Spawn PTY via node-pty
				//
				// IMPORTANT: We use Effect.sync instead of Effect.try here because
				// Bun has a runtime bug where wrapping node-pty's spawn in a
				// try/catch block causes the child process to receive SIGHUP
				// immediately, killing the PTY before it can start. Effect.try
				// uses try/catch internally, which triggers this bug. Effect.sync
				// does not wrap in try/catch, so the PTY stays alive.
				const pty = yield* Effect.sync(() =>
					nodePty.spawn(shellPath, shellArgs, {
						name: "xterm-256color",
						cols: 80,
						rows: 24,
						cwd: workspace.worktreePath,
						env: {
							...process.env,
							...workspaceEnv,
							TERM: "xterm-256color",
						} as Record<string, string>,
					})
				);
				console.log("[TM.spawn] pty pid=%d", pty.pid);

				// DEBUG: Also spawn via require to compare behavior
				// biome-ignore lint/style/noNonNullAssertion: debug
				const directNodePty = require("node-pty") as typeof import("node-pty");
				const debugPty = directNodePty.spawn(shellPath, shellArgs, {
					name: "xterm-256color",
					cols: 80,
					rows: 24,
					cwd: workspace.worktreePath,
					env: {
						...process.env,
						...workspaceEnv,
						TERM: "xterm-256color",
					} as Record<string, string>,
				});
				console.log("[TM.spawn] DEBUG require() pty pid=%d", debugPty.pid);
				debugPty.onData(() => {});
				debugPty.onExit(({ exitCode, signal }) => {
					console.log(
						"[TM.DEBUG] require() pty EXIT code=%d signal=%d elapsed=%dms",
						exitCode,
						signal,
						Date.now() - spawnTime
					);
				});
				// Kill debug PTY after 10 seconds
				setTimeout(() => {
					console.log("[TM.DEBUG] killing debug pty after 10s");
					debugPty.kill();
				}, 10_000);

				// 6. Wire stdout to LiveStore TerminalOutput events
				pty.onData((data: string) => {
					console.log("[TM.onData] id=%s len=%d", id, data.length);
					store.commit(events.terminalOutput({ id, data }));
				});

				// 7. Handle PTY exit — update status in LiveStore and clean up
				pty.onExit(({ exitCode, signal }) => {
					console.log(
						"[TM.onExit] id=%s pid=%d code=%d signal=%d elapsed=%dms",
						id,
						pty.pid,
						exitCode,
						signal,
						Date.now() - spawnTime
					);
					// Update LiveStore status to "stopped"
					store.commit(events.terminalStatusChanged({ id, status: "stopped" }));

					// Remove from in-memory map.
					// We use runSync (extracted from the Effect runtime) because
					// this is a plain JS callback from node-pty, not inside an
					// Effect pipeline. Ref.update is synchronous in nature.
					runSync(
						Ref.update(terminalsRef, (map) => {
							const next = new Map(map);
							next.delete(id);
							return next;
						})
					);
				});

				// 8. Store in our in-memory map
				const managedTerminal: ManagedTerminal = {
					id,
					workspaceId,
					command: resolvedCommand,
					pty,
				};

				yield* Ref.update(terminalsRef, (map) => {
					const next = new Map(map);
					next.set(id, managedTerminal);
					return next;
				});

				// 9. Commit TerminalSpawned event to LiveStore
				store.commit(
					events.terminalSpawned({
						id,
						workspaceId,
						command: resolvedCommand,
						status: "running",
						ptySessionRef: String(pty.pid),
					})
				);

				return {
					id,
					workspaceId,
					command: resolvedCommand,
					status: "running" as const,
				};
			});

			const write = Effect.fn("TerminalManager.write")(function* (
				terminalId: string,
				data: string
			) {
				const map = yield* Ref.get(terminalsRef);
				const terminal = map.get(terminalId);

				if (terminal === undefined) {
					return yield* new RpcError({
						message: `Terminal not found: ${terminalId}`,
						code: "NOT_FOUND",
					});
				}

				yield* Effect.try({
					try: () => terminal.pty.write(data),
					catch: (error) =>
						new RpcError({
							message: `Failed to write to terminal ${terminalId}: ${String(error)}`,
							code: "PTY_WRITE_FAILED",
						}),
				});
			});

			const resize = Effect.fn("TerminalManager.resize")(function* (
				terminalId: string,
				cols: number,
				rows: number
			) {
				const map = yield* Ref.get(terminalsRef);
				const terminal = map.get(terminalId);

				if (terminal === undefined) {
					return yield* new RpcError({
						message: `Terminal not found: ${terminalId}`,
						code: "NOT_FOUND",
					});
				}

				yield* Effect.try({
					try: () => terminal.pty.resize(cols, rows),
					catch: (error) =>
						new RpcError({
							message: `Failed to resize terminal ${terminalId}: ${String(error)}`,
							code: "PTY_RESIZE_FAILED",
						}),
				});
			});

			const kill = Effect.fn("TerminalManager.kill")(function* (
				terminalId: string
			) {
				const map = yield* Ref.get(terminalsRef);
				const terminal = map.get(terminalId);

				if (terminal === undefined) {
					return yield* new RpcError({
						message: `Terminal not found: ${terminalId}`,
						code: "NOT_FOUND",
					});
				}

				// Kill the PTY process
				yield* Effect.try({
					try: () => terminal.pty.kill(),
					catch: (error) =>
						new RpcError({
							message: `Failed to kill terminal ${terminalId}: ${String(error)}`,
							code: "PTY_KILL_FAILED",
						}),
				});

				// Remove from in-memory map
				yield* Ref.update(terminalsRef, (m) => {
					const next = new Map(m);
					next.delete(terminalId);
					return next;
				});

				// Update LiveStore status to "stopped"
				store.commit(
					events.terminalStatusChanged({
						id: terminalId,
						status: "stopped",
					})
				);
			});

			const listTerminals = Effect.fn("TerminalManager.listTerminals")(
				function* (workspaceId: string) {
					const allTerminals = store.query(tables.terminals);
					return pipe(
						allTerminals,
						Arr.filter((t) => t.workspaceId === workspaceId),
						Arr.map(
							(t): TerminalRecord => ({
								id: t.id,
								workspaceId: t.workspaceId,
								command: t.command,
								status: t.status as "running" | "stopped",
							})
						)
					);
				}
			);

			const killAllForWorkspace = Effect.fn(
				"TerminalManager.killAllForWorkspace"
			)(function* (workspaceId: string) {
				// 1. Get a snapshot of the current terminals map
				const map = yield* Ref.get(terminalsRef);

				// 2. Find all terminals belonging to this workspace
				const workspaceTerminals = pipe(
					[...map.values()],
					Arr.filter((t) => t.workspaceId === workspaceId)
				);

				if (workspaceTerminals.length === 0) {
					return 0;
				}

				// 3. Kill each terminal, catching individual errors to ensure
				//    best-effort cleanup (one failure doesn't stop the rest)
				let killedCount = 0;
				yield* Effect.forEach(
					workspaceTerminals,
					(terminal) =>
						pipe(
							Effect.try({
								try: () => terminal.pty.kill(),
								catch: (error) =>
									new RpcError({
										message: `Failed to kill terminal ${terminal.id}: ${String(error)}`,
										code: "PTY_KILL_FAILED",
									}),
							}),
							Effect.tap(() =>
								Ref.update(terminalsRef, (m) => {
									const next = new Map(m);
									next.delete(terminal.id);
									return next;
								})
							),
							Effect.tap(() =>
								Effect.sync(() => {
									store.commit(
										events.terminalStatusChanged({
											id: terminal.id,
											status: "stopped",
										})
									);
									killedCount += 1;
								})
							),
							Effect.catchAll((err) =>
								Effect.logWarning(
									`Failed to kill terminal ${terminal.id} during workspace cleanup: ${err.message}`
								)
							)
						),
					{ discard: true }
				);

				yield* Effect.log(
					`Killed ${killedCount}/${workspaceTerminals.length} terminals for workspace ${workspaceId}`
				);

				return killedCount;
			});

			return TerminalManager.of({
				spawn,
				write,
				resize,
				kill,
				listTerminals,
				killAllForWorkspace,
			});
		})
	);
}

export { TerminalManager };
