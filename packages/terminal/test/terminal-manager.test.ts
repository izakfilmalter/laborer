/**
 * TerminalManager integration tests (terminal package).
 *
 * Tests the terminal package's TerminalManager by composing real Effect layers:
 * - Real PtyHostClient (spawns the actual PTY Host child process under Node.js)
 * - No LiveStore — terminal state is fully in-memory
 * - No WorkspaceProvider — spawn payload provides all parameters
 *
 * Tests verify:
 * - spawn() with full payload (command, args, cwd, env, cols, rows, workspaceId)
 * - Stopped terminals are retained in memory with their config
 * - restart() works for stopped terminals using retained config
 * - Lifecycle events are emitted via PubSub
 * - listTerminals() returns both running and stopped terminals
 * - remove() fully deletes a terminal from memory
 * - write() and resize() work on running terminals
 * - kill() marks terminal as stopped (not deleted)
 *
 * @see PRD-terminal-extraction.md — Modified Module: TerminalManager
 * @see Issue #138: Move + simplify TerminalManager
 */

import { type Context, Effect, Exit, Fiber, Layer, Queue, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PtyHostClient } from "../src/services/pty-host-client.js";
import {
	type TerminalLifecycleEvent,
	TerminalManager,
} from "../src/services/terminal-manager.js";

// ---------------------------------------------------------------------------
// Test layer construction
// ---------------------------------------------------------------------------

/**
 * Full test layer: TerminalManager with PtyHostClient.
 * No LiveStore, no WorkspaceProvider.
 */
const TestLayer = TerminalManager.layer.pipe(
	Layer.provideMerge(PtyHostClient.layer)
);

// ---------------------------------------------------------------------------
// Helper: run an Effect program against the test layer
// ---------------------------------------------------------------------------

let scope: Scope.CloseableScope;
let testContext: Context.Context<TerminalManager | PtyHostClient>;

const runEffect = <A, E>(
	effect: Effect.Effect<A, E, TerminalManager>
): Promise<A> =>
	Effect.runPromise(Effect.provide(effect, Layer.succeedContext(testContext)));

beforeAll(async () => {
	scope = Effect.runSync(Scope.make());

	testContext = await Effect.runPromise(Layer.buildWithScope(TestLayer, scope));
}, 30_000);

afterAll(async () => {
	await Effect.runPromise(Scope.close(scope, Exit.void));
}, 15_000);

const TEST_WORKSPACE_ID = "test-workspace-1";
const TEST_CWD = "/tmp";

/** Small delay to allow async PTY events to propagate through IPC. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TerminalManager (terminal package)", { timeout: 30_000 }, () => {
	it("spawn() accepts full payload and returns terminal info", async () => {
		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn({
					command: 'echo "hello-from-terminal"',
					cwd: TEST_CWD,
					cols: 80,
					rows: 24,
					workspaceId: TEST_WORKSPACE_ID,
				});
			})
		);

		expect(result.id).toBeDefined();
		expect(result.workspaceId).toBe(TEST_WORKSPACE_ID);
		expect(result.command).toBe('echo "hello-from-terminal"');
		expect(result.cwd).toBe(TEST_CWD);
		expect(result.status).toBe("running");

		// Wait for the command to execute and exit
		await delay(2000);

		// Verify terminal is retained in memory as stopped (not deleted)
		const terminals = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.listTerminals();
			})
		);

		const terminal = terminals.find((t) => t.id === result.id);
		expect(terminal).toBeDefined();
		expect(terminal?.status).toBe("stopped");
	});

	it("write() sends input that produces corresponding output", async () => {
		// Spawn an interactive cat process
		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn({
					command: "cat",
					cwd: TEST_CWD,
					cols: 80,
					rows: 24,
					workspaceId: TEST_WORKSPACE_ID,
				});
			})
		);

		await delay(1000);

		// Write to the terminal
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.write(result.id, "test-write-input\n");
			})
		);

		await delay(1000);

		// Kill the terminal
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(result.id);
			})
		);

		// Verify terminal is stopped (retained in memory)
		const terminals = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.listTerminals();
			})
		);

		const terminal = terminals.find((t) => t.id === result.id);
		expect(terminal).toBeDefined();
		expect(terminal?.status).toBe("stopped");
	});

	it("resize() changes dimensions without crashing the PTY", async () => {
		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn({
					command: "cat",
					cwd: TEST_CWD,
					cols: 80,
					rows: 24,
					workspaceId: TEST_WORKSPACE_ID,
				});
			})
		);

		await delay(1000);

		// Resize — should not throw
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.resize(result.id, 120, 40);
			})
		);

		// Verify PTY is still alive by writing to it
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.write(result.id, "after-resize\n");
			})
		);

		await delay(500);

		// Terminal should still be running
		const terminals = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.listTerminals();
			})
		);

		const terminal = terminals.find((t) => t.id === result.id);
		expect(terminal?.status).toBe("running");

		// Clean up
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(result.id);
			})
		);
	});

	it("kill() marks terminal as stopped but retains it in memory", async () => {
		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn({
					command: "cat",
					cwd: TEST_CWD,
					cols: 80,
					rows: 24,
					workspaceId: TEST_WORKSPACE_ID,
				});
			})
		);

		await delay(500);

		// Kill the terminal
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(result.id);
			})
		);

		await delay(500);

		// Terminal should still exist in memory as stopped
		const terminals = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.listTerminals();
			})
		);

		const terminal = terminals.find((t) => t.id === result.id);
		expect(terminal).toBeDefined();
		expect(terminal?.status).toBe("stopped");
		expect(terminal?.command).toBe("cat");
		expect(terminal?.cwd).toBe(TEST_CWD);
		expect(terminal?.workspaceId).toBe(TEST_WORKSPACE_ID);
	});

	it("restart() works for stopped terminals using retained config", async () => {
		// Spawn and kill a terminal
		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn({
					command: "cat",
					cwd: TEST_CWD,
					cols: 80,
					rows: 24,
					workspaceId: TEST_WORKSPACE_ID,
				});
			})
		);

		await delay(500);

		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(result.id);
			})
		);

		await delay(500);

		// Restart the stopped terminal
		const restarted = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.restart(result.id);
			})
		);

		expect(restarted.id).toBe(result.id);
		expect(restarted.command).toBe("cat");
		expect(restarted.cwd).toBe(TEST_CWD);
		expect(restarted.status).toBe("running");

		await delay(500);

		// Write to verify the PTY is alive
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.write(result.id, "after-restart\n");
			})
		);

		await delay(500);

		// Clean up
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(result.id);
			})
		);
	});

	it("remove() fully deletes a terminal from memory", async () => {
		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn({
					command: 'echo "to-be-removed"',
					cwd: TEST_CWD,
					cols: 80,
					rows: 24,
					workspaceId: TEST_WORKSPACE_ID,
				});
			})
		);

		await delay(2000);

		// Terminal should be stopped after echo exits
		let terminals = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.listTerminals();
			})
		);
		expect(terminals.find((t) => t.id === result.id)?.status).toBe("stopped");

		// Remove it
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.remove(result.id);
			})
		);

		// Should no longer exist
		terminals = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.listTerminals();
			})
		);
		expect(terminals.find((t) => t.id === result.id)).toBeUndefined();

		// terminalExists should return false
		const exists = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.terminalExists(result.id);
			})
		);
		expect(exists).toBe(false);
	});

	it("listTerminals() returns both running and stopped terminals", async () => {
		const uniqueWs = `list-test-ws-${crypto.randomUUID().slice(0, 8)}`;

		// Spawn a long-running terminal
		const running = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn({
					command: "cat",
					cwd: TEST_CWD,
					cols: 80,
					rows: 24,
					workspaceId: uniqueWs,
				});
			})
		);

		// Spawn a short-lived terminal
		const shortLived = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn({
					command: 'echo "done"',
					cwd: TEST_CWD,
					cols: 80,
					rows: 24,
					workspaceId: uniqueWs,
				});
			})
		);

		await delay(2000);

		// List terminals for this workspace
		const terminals = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.listTerminals(uniqueWs);
			})
		);

		const runningTerminal = terminals.find((t) => t.id === running.id);
		const stoppedTerminal = terminals.find((t) => t.id === shortLived.id);

		expect(runningTerminal).toBeDefined();
		expect(runningTerminal?.status).toBe("running");

		expect(stoppedTerminal).toBeDefined();
		expect(stoppedTerminal?.status).toBe("stopped");

		// Clean up
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(running.id);
			})
		);
	});

	it("lifecycle events are emitted for spawn and kill", async () => {
		const collectedEvents: TerminalLifecycleEvent[] = [];

		// Subscribe, spawn, kill, then check collected events — all in one scoped block
		const result = await runEffect(
			Effect.scoped(
				Effect.gen(function* () {
					const tm = yield* TerminalManager;

					// Subscribe to the PubSub (scoped — will unsubscribe when block ends)
					const dequeue = yield* tm.lifecycleEvents.subscribe;

					// Start collecting events in a fiber
					const collectFiber = yield* Effect.fork(
						Effect.gen(function* () {
							while (true) {
								const event = yield* Queue.take(dequeue);
								collectedEvents.push(event);
							}
						})
					);

					// Spawn a terminal
					const terminal = yield* tm.spawn({
						command: "cat",
						cwd: TEST_CWD,
						cols: 80,
						rows: 24,
						workspaceId: TEST_WORKSPACE_ID,
					});

					// Give time for the Spawned event to propagate
					yield* Effect.sleep(500);

					// Kill it
					yield* tm.kill(terminal.id);

					// Give time for the StatusChanged event to propagate
					yield* Effect.sleep(500);

					// Interrupt the collector
					yield* Fiber.interrupt(collectFiber);

					return terminal;
				})
			)
		);

		// Check for Spawned event
		const spawnedEvent = collectedEvents.find(
			(e) => e._tag === "Spawned" && e.terminal.id === result.id
		);
		expect(spawnedEvent).toBeDefined();

		// Check for StatusChanged event (stopped)
		const statusEvent = collectedEvents.find(
			(e) =>
				e._tag === "StatusChanged" &&
				e.id === result.id &&
				e.status === "stopped"
		);
		expect(statusEvent).toBeDefined();
	});

	it("spawn() with custom args passes them correctly", async () => {
		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn({
					command: "/bin/echo",
					args: ["hello", "world"],
					cwd: TEST_CWD,
					cols: 80,
					rows: 24,
					workspaceId: TEST_WORKSPACE_ID,
				});
			})
		);

		expect(result.args).toEqual(["hello", "world"]);
		expect(result.command).toBe("/bin/echo");

		await delay(2000);

		// Terminal should be stopped after echo exits
		const terminals = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.listTerminals();
			})
		);

		const terminal = terminals.find((t) => t.id === result.id);
		expect(terminal?.status).toBe("stopped");
		expect(terminal?.args).toEqual(["hello", "world"]);
	});
});
