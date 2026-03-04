/**
 * PtyHostClient — Effect Service
 *
 * Manages communication with the PTY Host child process. The PTY Host is
 * a standalone Bun script (pty-host.ts) that runs node-pty in an isolated
 * process to avoid SIGHUP issues in the main HTTP server.
 *
 * Responsibilities:
 * - Spawning the PTY Host as a Bun child process during layer construction
 * - Waiting for the `ready` event before accepting commands
 * - Sending JSON commands to the PTY Host via stdin
 * - Parsing JSON events from the PTY Host via stdout (line-based)
 * - Routing `data` and `exit` events to per-terminal callbacks
 * - Notifying crash callbacks when the PTY Host process exits
 * - Killing the PTY Host and all PTY children on layer teardown
 *
 * IPC Protocol: Newline-delimited JSON over stdin (commands) and stdout (events).
 * See pty-host.ts for the full protocol specification.
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const client = yield* PtyHostClient
 *   client.spawn({ id, shell, args, cwd, env, cols, rows }, onData, onExit)
 *   client.write(id, "echo hello\n")
 *   client.resize(id, 120, 40)
 *   client.kill(id)
 * })
 * ```
 */

import { join } from "node:path";
import { Context, Deferred, Effect, Layer, Runtime } from "effect";

// ---------------------------------------------------------------------------
// IPC Protocol Types (mirrored from pty-host.ts)
// ---------------------------------------------------------------------------

interface SpawnParams {
	readonly args: readonly string[];
	readonly cols: number;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly id: string;
	readonly rows: number;
	readonly shell: string;
}

interface DataEvent {
	readonly data: string; // base64-encoded
	readonly id: string;
	readonly type: "data";
}

interface ExitEvent {
	readonly exitCode: number;
	readonly id: string;
	readonly signal: number;
	readonly type: "exit";
}

interface ErrorEvent {
	readonly id?: string;
	readonly message: string;
	readonly type: "error";
}

interface ReadyEvent {
	readonly type: "ready";
}

type PtyEvent = ReadyEvent | DataEvent | ExitEvent | ErrorEvent;

/** Callback invoked when a PTY produces output (base64-encoded). */
type DataCallback = (data: string) => void;

/** Callback invoked when a PTY process exits. */
type ExitCallback = (exitCode: number, signal: number) => void;

/** Callback invoked when the PTY Host process crashes. */
type CrashCallback = () => void;

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

class PtyHostClient extends Context.Tag("@laborer/PtyHostClient")<
	PtyHostClient,
	{
		/**
		 * Spawn a new PTY in the PTY Host.
		 * Sends a `spawn` command and registers data/exit callbacks.
		 */
		readonly spawn: (
			params: SpawnParams,
			onData: DataCallback,
			onExit: ExitCallback
		) => void;

		/** Write data to a PTY's stdin. */
		readonly write: (id: string, data: string) => void;

		/** Resize a PTY's dimensions. */
		readonly resize: (id: string, cols: number, rows: number) => void;

		/** Kill a PTY process. */
		readonly kill: (id: string) => void;

		/**
		 * Register a callback that is invoked when the PTY Host process
		 * crashes or exits unexpectedly.
		 */
		readonly onCrash: (callback: CrashCallback) => void;
	}
>() {
	static readonly layer = Layer.scoped(
		PtyHostClient,
		Effect.gen(function* () {
			// Resolve the PTY Host script path relative to this file.
			// This file: packages/server/src/services/pty-host-client.ts
			// PTY Host:  packages/server/src/pty-host.ts
			const ptyHostPath = join(import.meta.dir, "..", "pty-host.ts");

			// Per-terminal callbacks
			const dataCallbacks = new Map<string, DataCallback>();
			const exitCallbacks = new Map<string, ExitCallback>();
			const crashCallbacks: CrashCallback[] = [];

			// Deferred that resolves when the PTY Host sends the `ready` event
			const readyDeferred = yield* Deferred.make<void, Error>();

			// Extract the runtime so we can run Effects from plain JS callbacks
			// (async readers and process monitors). This avoids Effect.runFork
			// which uses the default runtime instead of our scoped runtime.
			const runtime = yield* Effect.runtime<never>();
			const runFork = Runtime.runFork(runtime);

			// Spawn the PTY Host child process
			const child = Bun.spawn(["bun", "run", ptyHostPath], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "inherit", // PTY Host debug logs go to our stderr
			});

			/** Send a JSON command to the PTY Host via stdin. */
			const sendCommand = (command: Record<string, unknown>): void => {
				const line = `${JSON.stringify(command)}\n`;
				child.stdin.write(line);
			};

			/** Route a `data` event to the registered callback. */
			const handleDataEvent = (event: DataEvent): void => {
				const cb = dataCallbacks.get(event.id);
				if (cb !== undefined) {
					cb(event.data);
				}
			};

			/** Route an `exit` event to the registered callback and clean up. */
			const handleExitEvent = (event: ExitEvent): void => {
				const exitCb = exitCallbacks.get(event.id);
				if (exitCb !== undefined) {
					exitCb(event.exitCode, event.signal);
				}
				dataCallbacks.delete(event.id);
				exitCallbacks.delete(event.id);
			};

			/** Log an error event from the PTY Host. */
			const handleErrorEvent = (event: ErrorEvent): void => {
				const prefix =
					event.id !== undefined ? `PTY error id=${event.id}` : "Host error";
				console.error(`[PtyHostClient] ${prefix}: ${event.message}`);
			};

			/** Route an incoming event to the appropriate handler. */
			const routeEvent = (event: PtyEvent): void => {
				switch (event.type) {
					case "ready":
						break;
					case "data":
						handleDataEvent(event);
						break;
					case "exit":
						handleExitEvent(event);
						break;
					case "error":
						handleErrorEvent(event);
						break;
					default:
						console.error(
							`[PtyHostClient] Unknown event type: ${(event as Record<string, unknown>).type}`
						);
						break;
				}
			};

			/** Parse a single line of JSON into a PtyEvent and route it. */
			const processLine = (line: string): void => {
				const trimmed = line.trim();
				if (trimmed === "") {
					return;
				}
				try {
					const event = JSON.parse(trimmed) as PtyEvent;
					if (event.type === "ready") {
						// Resolve the ready deferred from outside Effect context
						runFork(Deferred.succeed(readyDeferred, undefined));
						return;
					}
					routeEvent(event);
				} catch {
					console.error(
						`[PtyHostClient] Failed to parse event: ${trimmed.slice(0, 200)}`
					);
				}
			};

			/**
			 * Read stdout from the PTY Host as newline-delimited text.
			 * Runs as a background async loop for the lifetime of the service.
			 */
			const readStdout = async (): Promise<void> => {
				const reader = child.stdout.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							break;
						}

						buffer += decoder.decode(value, { stream: true });
						buffer = drainLines(buffer);
					}
				} catch (error) {
					console.error(
						`[PtyHostClient] stdout reader error: ${String(error)}`
					);
				}

				// Process any remaining data
				if (buffer.trim() !== "") {
					processLine(buffer);
				}
			};

			/** Extract and process complete lines from the buffer, return the remainder. */
			const drainLines = (buffer: string): string => {
				let remaining = buffer;
				let idx = remaining.indexOf("\n");
				while (idx !== -1) {
					const line = remaining.slice(0, idx);
					remaining = remaining.slice(idx + 1);
					processLine(line);
					idx = remaining.indexOf("\n");
				}
				return remaining;
			};

			// Start the background stdout reader (fire and forget)
			readStdout();

			// Monitor PTY Host process for crashes
			const monitorProcess = async (): Promise<void> => {
				const exitCode = await child.exited;
				console.error(
					`[PtyHostClient] PTY Host process exited with code ${exitCode}`
				);
				// Signal ready failure if the process dies before becoming ready
				runFork(
					Deferred.fail(
						readyDeferred,
						new Error(`PTY Host exited with code ${exitCode} before ready`)
					)
				);
				for (const cb of crashCallbacks) {
					try {
						cb();
					} catch (error) {
						console.error(
							`[PtyHostClient] Crash callback error: ${String(error)}`
						);
					}
				}
			};
			monitorProcess();

			// Wait for the PTY Host to emit the `ready` event
			yield* Deferred.await(readyDeferred).pipe(
				Effect.catchAll((error) =>
					Effect.die(
						new Error(`PtyHostClient failed to start: ${error.message}`)
					)
				)
			);

			// Register teardown: kill the PTY Host when the layer is destroyed
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					try {
						child.kill();
					} catch {
						// Best effort — process may have already exited
					}
				})
			);

			return PtyHostClient.of({
				spawn: (params, onData, onExit) => {
					// Register callbacks before sending the command to avoid races
					dataCallbacks.set(params.id, onData);
					exitCallbacks.set(params.id, onExit);

					sendCommand({
						type: "spawn",
						id: params.id,
						shell: params.shell,
						args: params.args,
						cwd: params.cwd,
						env: params.env,
						cols: params.cols,
						rows: params.rows,
					});
				},

				write: (id, data) => {
					sendCommand({ type: "write", id, data });
				},

				resize: (id, cols, rows) => {
					sendCommand({ type: "resize", id, cols, rows });
				},

				kill: (id) => {
					sendCommand({ type: "kill", id });
				},

				onCrash: (callback) => {
					crashCallbacks.push(callback);
				},
			});
		})
	);
}

export { PtyHostClient };
export type { CrashCallback, DataCallback, ExitCallback, SpawnParams };
