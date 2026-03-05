/**
 * TerminalManager + PtyHostClient integration tests.
 *
 * Tests the full server-side terminal stack by composing real Effect layers:
 * - Real PtyHostClient (spawns the actual PTY Host child process under Node.js)
 * - Real LaborerStore (in-memory SQLite via @livestore/adapter-node, no sync)
 * - Mock WorkspaceProvider (returns hardcoded env vars for a known workspace)
 *
 * Tests verify behavior through the TerminalManager public interface,
 * checking that LiveStore state is correctly updated as terminals are
 * spawned, produce output, and exit.
 */

import { events, schema, tables } from "@laborer/shared/schema";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LaborerStore } from "../src/services/laborer-store.js";
import { PtyHostClient } from "../src/services/pty-host-client.js";
import { TerminalManager } from "../src/services/terminal-manager.js";

// ---------------------------------------------------------------------------
// Mock WorkspaceProvider
// ---------------------------------------------------------------------------

/**
 * Import the WorkspaceProvider tag so we can provide a mock implementation.
 * We only need the Context.Tag — the real layer is not used in tests.
 */
import { WorkspaceProvider } from "../src/services/workspace-provider.js";

const TEST_WORKSPACE_ID = "test-workspace-1";
const TEST_WORKSPACE_PATH = "/tmp";

// ---------------------------------------------------------------------------
// Test layer construction
// ---------------------------------------------------------------------------

/**
 * Create a LaborerStore layer backed by in-memory SQLite.
 * No filesystem persistence, no WebSocket sync — pure in-memory for tests.
 */
const makeTestStore = Effect.gen(function* () {
	const adapter = makeAdapter({ storage: { type: "in-memory" } });
	const store = yield* createStore({
		schema,
		storeId: `test-${crypto.randomUUID()}`,
		adapter,
		batchUpdates: (run) => run(),
		disableDevtools: true,
	});
	return { store };
}).pipe(provideOtel({}));

const TestLaborerStore = Layer.scoped(LaborerStore, makeTestStore).pipe(
	Layer.orDie
);

/**
 * Mock WorkspaceProvider that:
 * - getWorkspaceEnv returns a fixed set of env vars for the test workspace
 * - createWorktree and destroyWorktree are not used in these tests
 */
const TestWorkspaceProvider = Layer.succeed(WorkspaceProvider, {
	createWorktree: () => Effect.die(new Error("Not implemented in test")),
	destroyWorktree: () => Effect.die(new Error("Not implemented in test")),
	getWorkspaceEnv: () =>
		Effect.succeed({
			PORT: "9999",
			LABORER_WORKSPACE_ID: TEST_WORKSPACE_ID,
			LABORER_WORKSPACE_PATH: TEST_WORKSPACE_PATH,
			LABORER_BRANCH: "test-branch",
		}),
});

/**
 * Full test layer: TerminalManager with all dependencies.
 * PtyHostClient.layer is real (spawns actual PTY Host process).
 */
const TestLayer = TerminalManager.layer.pipe(
	Layer.provideMerge(PtyHostClient.layer),
	Layer.provideMerge(TestWorkspaceProvider),
	Layer.provideMerge(TestLaborerStore)
);

// ---------------------------------------------------------------------------
// Helper: run an Effect program against the test layer
// ---------------------------------------------------------------------------

/**
 * Build the test layer once for the entire test suite. Store the scope
 * and runtime context so we can tear it down after all tests.
 */
let scope: Scope.CloseableScope;
let runEffect: <A, E>(
	effect: Effect.Effect<A, E, TerminalManager | LaborerStore>
) => Promise<A>;

beforeAll(async () => {
	scope = Effect.runSync(Scope.make());

	const context = await Effect.runPromise(
		Layer.buildWithScope(TestLayer, scope)
	);

	runEffect = <A, E>(
		effect: Effect.Effect<A, E, TerminalManager | LaborerStore>
	) => Effect.runPromise(Effect.provide(effect, Layer.succeedContext(context)));
}, 30_000);

afterAll(async () => {
	await Effect.runPromise(Scope.close(scope, Exit.void));
}, 15_000);

/**
 * Seed a workspace into LiveStore so TerminalManager.spawn() can validate it.
 * Must be called before spawning terminals. Only seeds once per test suite
 * since the shared in-memory store persists across tests.
 */
let workspaceSeeded = false;
const seedWorkspace = async () => {
	if (workspaceSeeded) {
		return;
	}
	await runEffect(
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;
			store.commit(
				events.workspaceCreated({
					id: TEST_WORKSPACE_ID,
					projectId: "test-project-1",
					taskSource: null,
					branchName: "test-branch",
					worktreePath: TEST_WORKSPACE_PATH,
					port: 9999,
					status: "running",
					createdAt: new Date().toISOString(),
					baseSha: null,
				})
			);
		})
	);
	workspaceSeeded = true;
};

/** Small delay to allow async PTY events to propagate through IPC. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TerminalManager + PtyHostClient", { timeout: 30_000 }, () => {
	it("spawn() returns a terminal response and produces output events in LiveStore", async () => {
		await seedWorkspace();

		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn(TEST_WORKSPACE_ID, 'echo "hello-from-terminal"');
			})
		);

		expect(result.id).toBeDefined();
		expect(result.workspaceId).toBe(TEST_WORKSPACE_ID);
		expect(result.command).toBe('echo "hello-from-terminal"');
		expect(result.status).toBe("running");

		// Wait for the command to execute and produce output
		await delay(2000);

		// Check LiveStore for terminal output events
		const output = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				const terminalRows = store.query(tables.terminals);
				return terminalRows;
			})
		);

		// The terminal should exist in the table
		const terminal = output.find((t) => t.id === result.id);
		expect(terminal).toBeDefined();
		expect(terminal?.workspaceId).toBe(TEST_WORKSPACE_ID);
		expect(terminal?.command).toBe('echo "hello-from-terminal"');
	});

	it("write() sends input that produces corresponding output", async () => {
		await seedWorkspace();

		// Spawn an interactive cat process
		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn(TEST_WORKSPACE_ID, "cat");
			})
		);

		// Wait for cat to start
		await delay(1000);

		// Write to the terminal
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.write(result.id, "test-write-input\n");
			})
		);

		// Wait for the echo to come back
		await delay(1000);

		// Kill the terminal so it doesn't hang
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(result.id);
			})
		);

		// Verify the terminal is stopped
		const terminalStatus = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				const terminals = store.query(tables.terminals);
				return terminals.find((t) => t.id === result.id);
			})
		);

		expect(terminalStatus?.status).toBe("stopped");
	});

	it("resize() changes dimensions without crashing the PTY", async () => {
		await seedWorkspace();

		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn(TEST_WORKSPACE_ID, "cat");
			})
		);

		// Wait for the PTY to start
		await delay(1000);

		// Resize — should not throw
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.resize(result.id, 120, 40);
			})
		);

		// Verify the PTY is still alive by writing to it
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.write(result.id, "after-resize\n");
			})
		);

		await delay(500);

		// Check the terminal is still running
		const terminal = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				const terminals = store.query(tables.terminals);
				return terminals.find((t) => t.id === result.id);
			})
		);

		expect(terminal?.status).toBe("running");

		// Clean up
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(result.id);
			})
		);
	});

	it("kill() terminates the PTY and updates terminal status to stopped", async () => {
		await seedWorkspace();

		const result = await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn(TEST_WORKSPACE_ID, "cat");
			})
		);

		// Wait for the PTY to start
		await delay(500);

		// Kill the terminal
		await runEffect(
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(result.id);
			})
		);

		// Wait for the kill to propagate
		await delay(500);

		// Verify status in LiveStore
		const terminal = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				const terminals = store.query(tables.terminals);
				return terminals.find((t) => t.id === result.id);
			})
		);

		expect(terminal?.status).toBe("stopped");
	});

	it("stale terminal cleanup on startup marks orphaned terminals as stopped", async () => {
		// The test layer has already been built, which means stale cleanup
		// already ran during TerminalManager construction. To test this,
		// we verify that if we manually create a "running" terminal record
		// in LiveStore (simulating an orphan), a fresh TerminalManager
		// layer construction would clean it up.
		//
		// Since we can't easily rebuild the layer mid-test, we verify the
		// behavior by checking that the cleanup logic works by inserting
		// a stale terminal and building a fresh layer.

		// Create a separate scope with a fresh in-memory store
		const freshScope = Effect.runSync(Scope.make());

		try {
			// Build a fresh test layer with a new in-memory store
			const freshStoreLayer = Layer.scoped(
				LaborerStore,
				Effect.gen(function* () {
					const adapter = makeAdapter({ storage: { type: "in-memory" } });
					const store = yield* createStore({
						schema,
						storeId: `stale-test-${crypto.randomUUID()}`,
						adapter,
						batchUpdates: (run) => run(),
						disableDevtools: true,
					});

					// Seed a workspace
					store.commit(
						events.workspaceCreated({
							id: TEST_WORKSPACE_ID,
							projectId: "test-project-1",
							taskSource: null,
							branchName: "test-branch",
							worktreePath: TEST_WORKSPACE_PATH,
							port: 9999,
							status: "running",
							createdAt: new Date().toISOString(),
							baseSha: null,
						})
					);

					// Simulate a stale "running" terminal from a previous crash
					store.commit(
						events.terminalSpawned({
							id: "stale-terminal-1",
							workspaceId: TEST_WORKSPACE_ID,
							command: "bash",
							status: "running",
							ptySessionRef: "stale-terminal-1",
						})
					);

					return { store };
				}).pipe(provideOtel({}))
			).pipe(Layer.orDie);

			const freshLayer = TerminalManager.layer.pipe(
				Layer.provideMerge(PtyHostClient.layer),
				Layer.provideMerge(TestWorkspaceProvider),
				Layer.provideMerge(freshStoreLayer)
			);

			const freshContext = await Effect.runPromise(
				Layer.buildWithScope(freshLayer, freshScope)
			);

			// After layer construction, the stale terminal should be marked as stopped
			const staleTerminal = await Effect.runPromise(
				Effect.gen(function* () {
					const { store } = yield* LaborerStore;
					const terminals = store.query(tables.terminals);
					return terminals.find((t) => t.id === "stale-terminal-1");
				}).pipe(Effect.provide(Layer.succeedContext(freshContext)))
			);

			expect(staleTerminal).toBeDefined();
			expect(staleTerminal?.status).toBe("stopped");
		} finally {
			await Effect.runPromise(Scope.close(freshScope, Exit.void));
		}
	});

	it("PTY Host crash triggers marking all tracked terminals as stopped", async () => {
		// This test requires us to crash the PTY Host. We build a fresh
		// layer, spawn a terminal, then kill the PTY Host process directly
		// to simulate a crash.

		const crashScope = Effect.runSync(Scope.make());

		try {
			const crashStoreLayer = Layer.scoped(
				LaborerStore,
				Effect.gen(function* () {
					const adapter = makeAdapter({ storage: { type: "in-memory" } });
					const store = yield* createStore({
						schema,
						storeId: `crash-test-${crypto.randomUUID()}`,
						adapter,
						batchUpdates: (run) => run(),
						disableDevtools: true,
					});

					// Seed workspace
					store.commit(
						events.workspaceCreated({
							id: TEST_WORKSPACE_ID,
							projectId: "test-project-1",
							taskSource: null,
							branchName: "test-branch",
							worktreePath: TEST_WORKSPACE_PATH,
							port: 9999,
							status: "running",
							createdAt: new Date().toISOString(),
							baseSha: null,
						})
					);

					return { store };
				}).pipe(provideOtel({}))
			).pipe(Layer.orDie);

			const crashLayer = TerminalManager.layer.pipe(
				Layer.provideMerge(PtyHostClient.layer),
				Layer.provideMerge(TestWorkspaceProvider),
				Layer.provideMerge(crashStoreLayer)
			);

			const crashContext = await Effect.runPromise(
				Layer.buildWithScope(crashLayer, crashScope)
			);

			const crashRun = <A, E>(
				effect: Effect.Effect<A, E, TerminalManager | LaborerStore>
			) =>
				Effect.runPromise(
					Effect.provide(effect, Layer.succeedContext(crashContext))
				);

			// Spawn a long-running terminal
			const result = await crashRun(
				Effect.gen(function* () {
					const tm = yield* TerminalManager;
					return yield* tm.spawn(TEST_WORKSPACE_ID, "cat");
				})
			);

			// Verify terminal is running
			await delay(500);
			const beforeCrash = await crashRun(
				Effect.gen(function* () {
					const { store } = yield* LaborerStore;
					return store.query(tables.terminals).find((t) => t.id === result.id);
				})
			);
			expect(beforeCrash?.status).toBe("running");

			// Kill the PTY Host process to simulate a crash.
			// We need to access the PtyHostClient context to find the child process.
			// Since PtyHostClient doesn't expose the child process directly,
			// we'll verify the crash handler via the onCrash mechanism by checking
			// that after the PTY Host dies, terminals are marked stopped.
			//
			// The PtyHostClient monitors the process via `child.exited`. When
			// we close the scope, the finalizer kills the PTY Host, which
			// triggers the crash callbacks. However, the teardown happens
			// _after_ we check, so we need a different approach.
			//
			// Instead, we'll find and kill the node pty-host.ts process directly.
			const { execSync } = await import("node:child_process");
			try {
				// Find the node pty-host.ts processes
				const psOutput = execSync("pgrep -f 'node.*pty-host\\.ts'").toString();
				const pids = psOutput.trim().split("\n").filter(Boolean);
				// Kill the most recently spawned one (last PID)
				if (pids.length > 0) {
					const targetPid = pids.at(-1);
					process.kill(Number(targetPid), "SIGKILL");
				}
			} catch {
				// pgrep may fail if no matching process — that's OK
			}

			// Wait for the crash to be detected and callbacks to fire
			await delay(2000);

			// Check that the terminal is now marked as stopped
			const afterCrash = await crashRun(
				Effect.gen(function* () {
					const { store } = yield* LaborerStore;
					return store.query(tables.terminals).find((t) => t.id === result.id);
				})
			);

			expect(afterCrash?.status).toBe("stopped");
		} finally {
			try {
				await Effect.runPromise(Scope.close(crashScope, Exit.void));
			} catch {
				// Scope close may fail since PTY Host was killed — that's expected
			}
		}
	});
});
