/**
 * PTY Host integration tests.
 *
 * These tests spawn the PTY Host as a real subprocess and communicate
 * with it via stdin/stdout using the newline-delimited JSON IPC protocol.
 * Real shell processes are spawned since that is the behavior under test.
 *
 * Both vitest and the PTY Host run under Node.js. The PTY Host uses
 * Node.js because Bun's tty.ReadStream does not fire data events for
 * PTY master file descriptors, preventing node-pty's onData from working.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// IPC Protocol Types (subset needed for tests)
// ---------------------------------------------------------------------------

interface ReadyEvent {
	readonly type: "ready";
}

interface DataEvent {
	readonly data: string; // raw UTF-8
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

type PtyEvent = ReadyEvent | DataEvent | ExitEvent | ErrorEvent;

// ---------------------------------------------------------------------------
// Push-based event queue
// ---------------------------------------------------------------------------

/**
 * A push-based event queue that receives events from child process stdout
 * via callbacks and allows tests to pull events via `next()`.
 *
 * This avoids the async generator `.return()` issue where `for await`
 * terminates the generator when breaking out of the loop.
 */
class EventQueue {
	private readonly queue: PtyEvent[] = [];
	private readonly waiters: Array<(event: PtyEvent) => void> = [];
	private ended = false;

	/** Push an event into the queue, resolving any waiting consumer. */
	push(event: PtyEvent): void {
		const waiter = this.waiters.shift();
		if (waiter !== undefined) {
			waiter(event);
		} else {
			this.queue.push(event);
		}
	}

	/** Mark the queue as ended (no more events will arrive). */
	end(): void {
		this.ended = true;
		// Resolve all waiting consumers with undefined to signal end-of-stream
		for (const resolve of this.waiters) {
			resolve(undefined as unknown as PtyEvent);
		}
		this.waiters.length = 0;
	}

	/** Pull the next event, waiting if none are available. Returns undefined if ended. */
	next(): Promise<PtyEvent | undefined> {
		const queued = this.queue.shift();
		if (queued !== undefined) {
			return Promise.resolve(queued);
		}
		if (this.ended) {
			return Promise.resolve(undefined);
		}
		return new Promise<PtyEvent | undefined>((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PTY_HOST_PATH = join(import.meta.dirname, "..", "src", "pty-host.ts");

interface PtyHostHandle {
	readonly child: ChildProcess;
	readonly cleanup: () => void;
	readonly events: EventQueue;
	readonly sendCommand: (command: Record<string, unknown>) => void;
	readonly sendRaw: (data: string) => void;
}

/** Spawn a PTY Host child process and return helpers for communication. */
function spawnPtyHost(): PtyHostHandle {
	const child = spawn("node", [PTY_HOST_PATH], {
		stdio: ["pipe", "pipe", "pipe"],
	});

	const events = new EventQueue();
	let buffer = "";

	// Parse newline-delimited JSON from stdout and push events into the queue
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf-8");
		let idx = buffer.indexOf("\n");
		while (idx !== -1) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line !== "") {
				try {
					events.push(JSON.parse(line) as PtyEvent);
				} catch {
					// Ignore unparseable lines in tests
				}
			}
			idx = buffer.indexOf("\n");
		}
	});

	child.stdout?.on("end", () => {
		// Process any remaining data in the buffer
		if (buffer.trim() !== "") {
			try {
				events.push(JSON.parse(buffer.trim()) as PtyEvent);
			} catch {
				// Ignore
			}
		}
		events.end();
	});

	const sendCommand = (command: Record<string, unknown>): void => {
		child.stdin?.write(`${JSON.stringify(command)}\n`);
	};

	const sendRaw = (data: string): void => {
		child.stdin?.write(data);
	};

	const cleanup = (): void => {
		try {
			child.kill("SIGKILL");
		} catch {
			// already exited
		}
	};

	return { child, sendCommand, sendRaw, events, cleanup };
}

/**
 * Wait for the next event matching a predicate from the event queue.
 * Non-matching events are discarded.
 */
async function waitForEvent(
	queue: EventQueue,
	predicate: (event: PtyEvent) => boolean,
	timeoutMs = 10_000
): Promise<PtyEvent> {
	const deadline = Date.now() + timeoutMs;

	while (true) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error("Timeout waiting for matching event");
		}

		const result = await Promise.race([
			queue.next(),
			new Promise<"timeout">((resolve) =>
				setTimeout(() => resolve("timeout"), remaining)
			),
		]);

		if (result === "timeout") {
			throw new Error("Timeout waiting for matching event");
		}
		if (result === undefined) {
			throw new Error("Event stream ended without matching event");
		}
		if (predicate(result)) {
			return result;
		}
	}
}

/**
 * Collect events from the queue until a predicate is satisfied or timeout.
 * Returns all collected events (including the one that satisfied the predicate).
 */
async function collectEventsUntil(
	queue: EventQueue,
	predicate: (event: PtyEvent) => boolean,
	timeoutMs = 10_000
): Promise<PtyEvent[]> {
	const collected: PtyEvent[] = [];
	const deadline = Date.now() + timeoutMs;

	while (true) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`Timeout waiting for event. Collected so far: ${JSON.stringify(collected)}`
			);
		}

		const result = await Promise.race([
			queue.next(),
			new Promise<"timeout">((resolve) =>
				setTimeout(() => resolve("timeout"), remaining)
			),
		]);

		if (result === "timeout") {
			throw new Error(
				`Timeout waiting for event. Collected so far: ${JSON.stringify(collected)}`
			);
		}
		if (result === undefined) {
			// Stream ended — return what we have
			return collected;
		}

		collected.push(result);
		if (predicate(result)) {
			return collected;
		}
	}
}

/** Wait for the ready event from the PTY Host. */
async function waitForReady(queue: EventQueue): Promise<void> {
	await waitForEvent(queue, (e) => e.type === "ready");
}

/** Extract the raw UTF-8 data string from a DataEvent. */
function decodeData(event: DataEvent): string {
	return event.data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PTY Host", { timeout: 30_000 }, () => {
	let currentHost: PtyHostHandle | undefined;

	afterEach(() => {
		if (currentHost !== undefined) {
			currentHost.cleanup();
			currentHost = undefined;
		}
	});

	it("emits ready event on startup", async () => {
		const host = spawnPtyHost();
		currentHost = host;

		const readyEvent = await waitForEvent(
			host.events,
			(e) => e.type === "ready",
			10_000
		);

		expect(readyEvent).toEqual({ type: "ready" });
	});

	it("spawn command creates a PTY that produces data events", async () => {
		const host = spawnPtyHost();
		currentHost = host;

		await waitForReady(host.events);

		const testId = "test-spawn-1";
		host.sendCommand({
			type: "spawn",
			id: testId,
			shell: "/bin/sh",
			args: ["-c", "echo hello-from-pty"],
			cwd: "/tmp",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			cols: 80,
			rows: 24,
		});

		// Wait for data events containing our expected output
		const collected = await collectEventsUntil(host.events, (e) => {
			if (e.type === "data" && e.id === testId) {
				const decoded = decodeData(e as DataEvent);
				if (decoded.includes("hello-from-pty")) {
					return true;
				}
			}
			// Also stop if the process exits
			return e.type === "exit" && e.id === testId;
		});

		const dataEvents = collected.filter(
			(e) => e.type === "data" && e.id === testId
		) as DataEvent[];
		const allOutput = dataEvents.map(decodeData).join("");
		expect(allOutput).toContain("hello-from-pty");
	});

	it("write command sends input that the PTY process receives", async () => {
		const host = spawnPtyHost();
		currentHost = host;

		await waitForReady(host.events);

		const testId = "test-write-1";
		host.sendCommand({
			type: "spawn",
			id: testId,
			shell: "/bin/cat",
			args: [],
			cwd: "/tmp",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			cols: 80,
			rows: 24,
		});

		// Give the PTY a moment to start
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Write data to the PTY — cat should echo it back
		host.sendCommand({
			type: "write",
			id: testId,
			data: "test-input-echo\n",
		});

		// Wait for data events containing our input echoed back
		const collected = await collectEventsUntil(host.events, (e) => {
			if (e.type === "data" && e.id === testId) {
				const decoded = decodeData(e as DataEvent);
				if (decoded.includes("test-input-echo")) {
					return true;
				}
			}
			return false;
		});

		const dataEvents = collected.filter(
			(e) => e.type === "data" && e.id === testId
		) as DataEvent[];
		const allOutput = dataEvents.map(decodeData).join("");
		expect(allOutput).toContain("test-input-echo");

		// Clean up the cat process
		host.sendCommand({ type: "kill", id: testId });
	});

	it("resize command changes PTY dimensions without crashing", async () => {
		const host = spawnPtyHost();
		currentHost = host;

		await waitForReady(host.events);

		const testId = "test-resize-1";
		host.sendCommand({
			type: "spawn",
			id: testId,
			shell: "/bin/sh",
			args: [],
			cwd: "/tmp",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			cols: 80,
			rows: 24,
		});

		// Give the PTY a moment to start
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Resize should not crash
		host.sendCommand({
			type: "resize",
			id: testId,
			cols: 120,
			rows: 40,
		});

		// Verify the PTY is still alive by writing to it
		host.sendCommand({
			type: "write",
			id: testId,
			data: "echo resize-ok\n",
		});

		const collected = await collectEventsUntil(host.events, (e) => {
			if (e.type === "data" && e.id === testId) {
				const decoded = decodeData(e as DataEvent);
				if (decoded.includes("resize-ok")) {
					return true;
				}
			}
			return false;
		});

		const dataEvents = collected.filter(
			(e) => e.type === "data" && e.id === testId
		) as DataEvent[];
		const allOutput = dataEvents.map(decodeData).join("");
		expect(allOutput).toContain("resize-ok");

		host.sendCommand({ type: "kill", id: testId });
	});

	it("kill command terminates the PTY and produces an exit event", async () => {
		const host = spawnPtyHost();
		currentHost = host;

		await waitForReady(host.events);

		const testId = "test-kill-1";
		host.sendCommand({
			type: "spawn",
			id: testId,
			shell: "/bin/sh",
			args: [],
			cwd: "/tmp",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			cols: 80,
			rows: 24,
		});

		// Give the PTY a moment to start
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Kill the PTY
		host.sendCommand({ type: "kill", id: testId });

		// Wait for the exit event
		const exitEvent = await waitForEvent(
			host.events,
			(e) => e.type === "exit" && e.id === testId
		);

		expect(exitEvent.type).toBe("exit");
		expect((exitEvent as ExitEvent).id).toBe(testId);
		expect(typeof (exitEvent as ExitEvent).exitCode).toBe("number");
		expect(typeof (exitEvent as ExitEvent).signal).toBe("number");
	});

	it("multiple concurrent PTYs work independently", async () => {
		const host = spawnPtyHost();
		currentHost = host;

		await waitForReady(host.events);

		const id1 = "test-multi-1";
		const id2 = "test-multi-2";

		// Spawn two PTYs
		host.sendCommand({
			type: "spawn",
			id: id1,
			shell: "/bin/sh",
			args: ["-c", "echo output-from-pty-1"],
			cwd: "/tmp",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			cols: 80,
			rows: 24,
		});

		host.sendCommand({
			type: "spawn",
			id: id2,
			shell: "/bin/sh",
			args: ["-c", "echo output-from-pty-2"],
			cwd: "/tmp",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			cols: 80,
			rows: 24,
		});

		// Collect events until we've seen exit events for both PTYs
		let exitCount = 0;
		const collected = await collectEventsUntil(host.events, (e) => {
			if (e.type === "exit" && (e.id === id1 || e.id === id2)) {
				exitCount++;
			}
			return exitCount >= 2;
		});

		// Verify both PTYs produced data
		const pty1Data = collected
			.filter((e) => e.type === "data" && e.id === id1)
			.map((e) => decodeData(e as DataEvent))
			.join("");
		const pty2Data = collected
			.filter((e) => e.type === "data" && e.id === id2)
			.map((e) => decodeData(e as DataEvent))
			.join("");

		expect(pty1Data).toContain("output-from-pty-1");
		expect(pty2Data).toContain("output-from-pty-2");

		// Verify both exited
		const exitEvents = collected.filter(
			(e) => e.type === "exit" && (e.id === id1 || e.id === id2)
		);
		expect(exitEvents).toHaveLength(2);
	});

	it("invalid JSON produces error event, not a crash", async () => {
		const host = spawnPtyHost();
		currentHost = host;

		await waitForReady(host.events);

		// Send invalid JSON directly via stdin
		host.sendRaw("this is not json\n");

		// Should get an error event
		const errorEvent = await waitForEvent(
			host.events,
			(e) => e.type === "error"
		);

		expect(errorEvent.type).toBe("error");
		expect((errorEvent as ErrorEvent).message).toContain("Invalid JSON");

		// Verify the host is still alive by spawning a valid PTY
		const testId = "test-after-error";
		host.sendCommand({
			type: "spawn",
			id: testId,
			shell: "/bin/sh",
			args: ["-c", "echo still-alive"],
			cwd: "/tmp",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			cols: 80,
			rows: 24,
		});

		const collected = await collectEventsUntil(host.events, (e) => {
			if (e.type === "data" && e.id === testId) {
				const decoded = decodeData(e as DataEvent);
				if (decoded.includes("still-alive")) {
					return true;
				}
			}
			return e.type === "exit" && e.id === testId;
		});

		const allOutput = collected
			.filter((e) => e.type === "data" && e.id === testId)
			.map((e) => decodeData(e as DataEvent))
			.join("");
		expect(allOutput).toContain("still-alive");
	});

	it("malformed command produces error event, not a crash", async () => {
		const host = spawnPtyHost();
		currentHost = host;

		await waitForReady(host.events);

		// Send valid JSON but invalid command (missing required fields)
		host.sendCommand({ type: "spawn", id: "bad" });

		const errorEvent = await waitForEvent(
			host.events,
			(e) => e.type === "error"
		);

		expect(errorEvent.type).toBe("error");
		expect((errorEvent as ErrorEvent).message).toContain("Invalid command");

		// Send a command with an unknown type
		host.sendCommand({ type: "unknown-type", id: "bad2" });

		const errorEvent2 = await waitForEvent(
			host.events,
			(e) => e.type === "error"
		);

		expect(errorEvent2.type).toBe("error");
		expect((errorEvent2 as ErrorEvent).message).toContain("Invalid command");
	});

	it("coalesces rapid output into fewer data events (Issue #137)", async () => {
		const host = spawnPtyHost();
		currentHost = host;

		await waitForReady(host.events);

		const testId = "test-coalesce-1";
		// Use `seq 1 1000` which produces 1000 lines of output very rapidly.
		// Without coalescing, this would produce ~1000 individual data events.
		// With 5ms coalescing, the output should be batched into significantly
		// fewer events.
		host.sendCommand({
			type: "spawn",
			id: testId,
			shell: "/bin/sh",
			args: ["-c", "seq 1 1000"],
			cwd: "/tmp",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			cols: 80,
			rows: 24,
		});

		// Collect all events until exit
		const collected = await collectEventsUntil(
			host.events,
			(e) => e.type === "exit" && e.id === testId
		);

		const dataEvents = collected.filter(
			(e) => e.type === "data" && e.id === testId
		) as DataEvent[];

		// Verify all output arrived correctly
		const allOutput = dataEvents.map(decodeData).join("");
		expect(allOutput).toContain("1");
		expect(allOutput).toContain("1000");

		// Key assertion: coalescing should produce significantly fewer data
		// events than the 1000 lines of output. Without coalescing, we'd see
		// ~1000 events (one per onData call). With 5ms coalescing, we expect
		// dramatically fewer — typically under 50 for this fast-completing
		// command. We use a generous threshold of 200 to avoid flakiness
		// across different machines and load conditions.
		expect(dataEvents.length).toBeLessThan(200);

		// Sanity check: we should have at least 1 event (the output wasn't lost)
		expect(dataEvents.length).toBeGreaterThanOrEqual(1);
	});

	it("resize flushes pending coalesced data before applying resize", async () => {
		const host = spawnPtyHost();
		currentHost = host;

		await waitForReady(host.events);

		const testId = "test-resize-flush-1";
		host.sendCommand({
			type: "spawn",
			id: testId,
			shell: "/bin/cat",
			args: [],
			cwd: "/tmp",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			cols: 80,
			rows: 24,
		});

		// Give the PTY a moment to start
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Write data to cat (which echoes it back)
		host.sendCommand({
			type: "write",
			id: testId,
			data: "pre-resize-data\n",
		});

		// Immediately send a resize — this should flush any pending coalesced
		// data from the write/echo before the resize takes effect.
		// We don't wait, to test that resize triggers an immediate flush.
		host.sendCommand({
			type: "resize",
			id: testId,
			cols: 120,
			rows: 40,
		});

		// Now write some more data after the resize
		host.sendCommand({
			type: "write",
			id: testId,
			data: "post-resize-data\n",
		});

		// Collect data until we see post-resize output
		const collected = await collectEventsUntil(host.events, (e) => {
			if (e.type === "data" && e.id === testId) {
				const decoded = decodeData(e as DataEvent);
				if (decoded.includes("post-resize-data")) {
					return true;
				}
			}
			return false;
		});

		const dataEvents = collected.filter(
			(e) => e.type === "data" && e.id === testId
		) as DataEvent[];
		const allOutput = dataEvents.map(decodeData).join("");

		// Both pre- and post-resize data should have arrived
		expect(allOutput).toContain("pre-resize-data");
		expect(allOutput).toContain("post-resize-data");

		// Clean up
		host.sendCommand({ type: "kill", id: testId });
	});
});
