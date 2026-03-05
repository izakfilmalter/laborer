/**
 * TerminalManager — Effect Service
 *
 * Manages terminal instances scoped to workspaces. Delegates PTY operations
 * to the PtyHostClient service, which communicates with an isolated PTY Host
 * child process. This architecture avoids SIGHUP issues that occur when
 * node-pty runs inside the Bun HTTP server process.
 *
 * Responsibilities:
 * - Terminal spawning via PtyHostClient in workspace directories
 * - I/O streaming: stdout → LiveStore events, stdin ← RPC writes
 * - Terminal resize (cols, rows) with SIGWINCH propagation
 * - Terminal kill + resource cleanup
 * - Terminal removal (kill if running + delete from LiveStore)
 * - Multiple terminals per workspace, each tracked by unique ID
 * - Workspace env var injection (PORT, LABORER_* vars)
 * - Graceful shutdown: kills all terminals on layer teardown (Issue #128)
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
 * Issue #128: graceful shutdown — kills all terminals on SIGINT/SIGTERM
 * Issue #132: terminal.remove — kill (if running) + delete from LiveStore
 * Issue #133: terminal.restart — kill (if running) + respawn with same command, preserving terminal ID
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

/** Logger tag used for structured Effect.log output in this module. */
const logPrefix = "TerminalManager";

import { LaborerStore } from "./laborer-store.js";
import { PtyHostClient } from "./pty-host-client.js";
import { WorkspaceProvider } from "./workspace-provider.js";

/**
 * Internal representation of a managed terminal.
 * Tracks metadata for the terminal — the actual PTY instance lives
 * in the PTY Host child process, accessed via PtyHostClient by ID.
 */
interface ManagedTerminal {
	readonly command: string;
	readonly id: string;
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
		 * 3. Spawns a PTY via PtyHostClient in the worktree directory
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
		 * Remove a terminal completely — kills PTY if running, removes from
		 * in-memory map, and deletes the terminal row from LiveStore.
		 *
		 * If the terminal is still running, it is killed first. If the terminal
		 * is already stopped (not in in-memory map), the LiveStore row is
		 * deleted directly.
		 *
		 * @param terminalId - ID of the terminal to remove
		 */
		readonly remove: (terminalId: string) => Effect.Effect<void, RpcError>;

		/**
		 * Restart a terminal — kills the existing PTY (if running) and respawns
		 * it with the same command in the same workspace directory. The terminal
		 * ID is preserved so any pane displaying the terminal continues seamlessly.
		 *
		 * If the terminal is stopped, it acts as a "start again" operation.
		 *
		 * @param terminalId - ID of the terminal to restart
		 */
		readonly restart: (
			terminalId: string
		) => Effect.Effect<TerminalRecord, RpcError>;

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
	static readonly layer = Layer.scoped(
		TerminalManager,
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;
			const workspaceProvider = yield* WorkspaceProvider;
			const ptyHostClient = yield* PtyHostClient;

			// Extract the runtime so we can run Effects from plain JS callbacks
			// (e.g., PtyHostClient onExit/onData callbacks). This avoids the
			// Effect.runSync-inside-Effect anti-pattern.
			const runtime = yield* Effect.runtime<never>();
			const runSync = Runtime.runSync(runtime);

			// In-memory map of terminal ID → ManagedTerminal.
			// Uses Effect.Ref for fiber-safe concurrent access.
			const terminalsRef = yield* Ref.make(new Map<string, ManagedTerminal>());

			// ---------------------------------------------------------------
			// Stale terminal cleanup on startup (Issue #4)
			// ---------------------------------------------------------------
			// Any terminals with status "running" in LiveStore are orphans from
			// a previous server crash — the PTY processes are long gone. Mark
			// them as "stopped" so the UI doesn't show ghost terminals.
			const staleTerminals = pipe(
				store.query(tables.terminals),
				Arr.filter((t) => t.status === "running")
			);

			if (staleTerminals.length > 0) {
				for (const terminal of staleTerminals) {
					store.commit(
						events.terminalStatusChanged({
							id: terminal.id,
							status: "stopped",
						})
					);
				}
				yield* Effect.log(
					`Cleaned up ${staleTerminals.length} stale terminal(s) from previous session`
				).pipe(Effect.annotateLogs("module", logPrefix));
			}

			// ---------------------------------------------------------------
			// PTY Host crash handler (Issue #4)
			// ---------------------------------------------------------------
			// When the PTY Host process crashes, all PTY instances are lost.
			// Mark every in-memory tracked terminal as stopped in LiveStore.
			ptyHostClient.onCrash(() => {
				runSync(
					Effect.gen(function* () {
						const map = yield* Ref.get(terminalsRef);
						const terminalIds = [...map.keys()];

						if (terminalIds.length === 0) {
							return;
						}

						for (const id of terminalIds) {
							store.commit(
								events.terminalStatusChanged({ id, status: "stopped" })
							);
						}

						// Clear the in-memory map — all terminals are dead
						yield* Ref.set(terminalsRef, new Map<string, ManagedTerminal>());

						yield* Effect.log(
							`PTY Host crashed — marked ${terminalIds.length} terminal(s) as stopped`
						).pipe(Effect.annotateLogs("module", logPrefix));
					})
				);
			});

			/**
			 * Detect the user's default shell.
			 * Falls back to /bin/sh if SHELL env var is not set.
			 */
			const defaultShell = process.env.SHELL ?? "/bin/sh";

			const spawn = Effect.fn("TerminalManager.spawn")(function* (
				workspaceId: string,
				command?: string
			) {
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

				// Parse command into shell + args for PTY Host.
				// If a custom command is provided, run it via the shell with -c
				// so that pipes, redirects, etc. work. If no command is provided,
				// spawn the shell directly (interactive mode).
				const shellPath = command ? defaultShell : resolvedCommand;
				const shellArgs = command ? ["-c", resolvedCommand] : [];

				// 4. Generate terminal ID
				const id = crypto.randomUUID();

				// 5. Store in our in-memory map (before spawning to ensure
				// callbacks can find the terminal)
				const managedTerminal: ManagedTerminal = {
					id,
					workspaceId,
					command: resolvedCommand,
				};

				yield* Ref.update(terminalsRef, (map) => {
					const next = new Map(map);
					next.set(id, managedTerminal);
					return next;
				});

				// 6. Spawn PTY via PtyHostClient with data/exit callbacks
				ptyHostClient.spawn(
					{
						id,
						shell: shellPath,
						args: shellArgs,
						cwd: workspace.worktreePath,
						env: {
							...process.env,
							...workspaceEnv,
							TERM: "xterm-256color",
						} as Record<string, string>,
						cols: 80,
						rows: 24,
					},
					// Data callback: decode base64 and commit to LiveStore
					(base64Data: string) => {
						const data = Buffer.from(base64Data, "base64").toString("utf-8");
						store.commit(events.terminalOutput({ id, data }));
					},
					// Exit callback: update LiveStore status and clean up
					(_exitCode: number, _signal: number) => {
						// Update LiveStore status to "stopped"
						store.commit(
							events.terminalStatusChanged({ id, status: "stopped" })
						);

						// Remove from in-memory map.
						// We use runSync (extracted from the Effect runtime) because
						// this is a plain JS callback from PtyHostClient, not inside an
						// Effect pipeline. Ref.update is synchronous in nature.
						runSync(
							Ref.update(terminalsRef, (map) => {
								const next = new Map(map);
								next.delete(id);
								return next;
							})
						);
					}
				);

				// 7. Commit TerminalSpawned event to LiveStore
				store.commit(
					events.terminalSpawned({
						id,
						workspaceId,
						command: resolvedCommand,
						status: "running",
						ptySessionRef: id,
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

				ptyHostClient.write(terminalId, data);
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

				ptyHostClient.resize(terminalId, cols, rows);
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

				// Send kill command to PTY Host
				ptyHostClient.kill(terminalId);

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

			const remove = Effect.fn("TerminalManager.remove")(function* (
				terminalId: string
			) {
				// 1. Check if the terminal exists in LiveStore
				const allTerminals = store.query(tables.terminals);
				const terminalOpt = pipe(
					allTerminals,
					Arr.findFirst((t) => t.id === terminalId)
				);

				if (terminalOpt._tag === "None") {
					return yield* new RpcError({
						message: `Terminal not found: ${terminalId}`,
						code: "NOT_FOUND",
					});
				}

				// 2. If the terminal is still running (in-memory map), kill it first
				const map = yield* Ref.get(terminalsRef);
				if (map.has(terminalId)) {
					ptyHostClient.kill(terminalId);

					yield* Ref.update(terminalsRef, (m) => {
						const next = new Map(m);
						next.delete(terminalId);
						return next;
					});
				}

				// 3. Delete the terminal row from LiveStore
				store.commit(events.terminalRemoved({ id: terminalId }));

				yield* Effect.log(`Removed terminal ${terminalId}`).pipe(
					Effect.annotateLogs("module", logPrefix)
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

			const restart = Effect.fn("TerminalManager.restart")(function* (
				terminalId: string
			) {
				// 1. Look up the terminal in LiveStore to get its metadata
				const allTerminals = store.query(tables.terminals);
				const terminalOpt = pipe(
					allTerminals,
					Arr.findFirst((t) => t.id === terminalId)
				);

				if (terminalOpt._tag === "None") {
					return yield* new RpcError({
						message: `Terminal not found: ${terminalId}`,
						code: "NOT_FOUND",
					});
				}

				const terminalRow = terminalOpt.value;

				// 2. Validate workspace still exists
				const allWorkspaces = store.query(tables.workspaces);
				const workspaceOpt = pipe(
					allWorkspaces,
					Arr.findFirst((w) => w.id === terminalRow.workspaceId)
				);

				if (workspaceOpt._tag === "None") {
					return yield* new RpcError({
						message: `Workspace not found: ${terminalRow.workspaceId} — cannot restart terminal`,
						code: "NOT_FOUND",
					});
				}

				const workspace = workspaceOpt.value;

				// 3. If the terminal is still running (in-memory map), kill it
				const map = yield* Ref.get(terminalsRef);
				if (map.has(terminalId)) {
					ptyHostClient.kill(terminalId);

					yield* Ref.update(terminalsRef, (m) => {
						const next = new Map(m);
						next.delete(terminalId);
						return next;
					});
				}

				// 4. Get workspace environment variables
				const workspaceEnv = yield* workspaceProvider.getWorkspaceEnv(
					terminalRow.workspaceId
				);

				// 5. Determine shell + args (same logic as spawn)
				const resolvedCommand = terminalRow.command;
				const shellPath =
					resolvedCommand !== defaultShell ? defaultShell : resolvedCommand;
				const shellArgs =
					resolvedCommand !== defaultShell ? ["-c", resolvedCommand] : [];

				// 6. Re-add to in-memory map before spawning
				const managedTerminal: ManagedTerminal = {
					id: terminalId,
					workspaceId: terminalRow.workspaceId,
					command: resolvedCommand,
				};

				yield* Ref.update(terminalsRef, (m) => {
					const next = new Map(m);
					next.set(terminalId, managedTerminal);
					return next;
				});

				// 7. Respawn PTY via PtyHostClient with same ID
				ptyHostClient.spawn(
					{
						id: terminalId,
						shell: shellPath,
						args: shellArgs,
						cwd: workspace.worktreePath,
						env: {
							...process.env,
							...workspaceEnv,
							TERM: "xterm-256color",
						} as Record<string, string>,
						cols: 80,
						rows: 24,
					},
					// Data callback
					(base64Data: string) => {
						const data = Buffer.from(base64Data, "base64").toString("utf-8");
						store.commit(events.terminalOutput({ id: terminalId, data }));
					},
					// Exit callback
					(_exitCode: number, _signal: number) => {
						store.commit(
							events.terminalStatusChanged({
								id: terminalId,
								status: "stopped",
							})
						);

						runSync(
							Ref.update(terminalsRef, (m) => {
								const next = new Map(m);
								next.delete(terminalId);
								return next;
							})
						);
					}
				);

				// 8. Commit TerminalRestarted event (resets status to "running")
				store.commit(events.terminalRestarted({ id: terminalId }));

				yield* Effect.log(`Restarted terminal ${terminalId}`).pipe(
					Effect.annotateLogs("module", logPrefix)
				);

				return {
					id: terminalId,
					workspaceId: terminalRow.workspaceId,
					command: resolvedCommand,
					status: "running" as const,
				};
			});

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

				// 3. Kill each terminal via PtyHostClient, catching individual
				//    errors to ensure best-effort cleanup
				let killedCount = 0;
				yield* Effect.forEach(
					workspaceTerminals,
					(terminal) =>
						pipe(
							Effect.sync(() => ptyHostClient.kill(terminal.id)),
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
									`Failed to kill terminal ${terminal.id} during workspace cleanup: ${String(err)}`
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

			// ---------------------------------------------------------------
			// Graceful shutdown finalizer (Issue #128)
			// ---------------------------------------------------------------
			// When the server shuts down (SIGINT/SIGTERM), Effect tears down
			// all layer scopes. This finalizer iterates all in-memory terminals,
			// kills each PTY via PtyHostClient, and updates LiveStore status to
			// "stopped". This ensures:
			// 1. No orphan PTY processes remain after shutdown
			// 2. LiveStore state is consistent (no ghost "running" terminals)
			// 3. The stale terminal cleanup on next startup (above) handles
			//    any edge cases where the finalizer didn't complete
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					const map = yield* Ref.get(terminalsRef);
					const allTerminals = [...map.values()];

					if (allTerminals.length === 0) {
						yield* Effect.log("Shutdown: no active terminals to clean up").pipe(
							Effect.annotateLogs("module", logPrefix)
						);
						return;
					}

					yield* Effect.log(
						`Shutdown: killing ${allTerminals.length} active terminal(s)...`
					).pipe(Effect.annotateLogs("module", logPrefix));

					let killedCount = 0;
					yield* Effect.forEach(
						allTerminals,
						(terminal) =>
							pipe(
								Effect.sync(() => ptyHostClient.kill(terminal.id)),
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
										`Shutdown: failed to kill terminal ${terminal.id}: ${String(err)}`
									).pipe(Effect.annotateLogs("module", logPrefix))
								)
							),
						{ discard: true }
					);

					// Clear the in-memory map
					yield* Ref.set(terminalsRef, new Map<string, ManagedTerminal>());

					yield* Effect.log(
						`Shutdown: killed ${killedCount}/${allTerminals.length} terminal(s)`
					).pipe(Effect.annotateLogs("module", logPrefix));
				})
			);

			return TerminalManager.of({
				spawn,
				write,
				resize,
				kill,
				remove,
				restart,
				listTerminals,
				killAllForWorkspace,
			});
		})
	);
}

export { TerminalManager };
