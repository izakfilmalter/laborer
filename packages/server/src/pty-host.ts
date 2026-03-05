/**
 * PTY Host — Isolated child process for managing node-pty instances.
 *
 * This script runs as a standalone Node.js subprocess, completely isolated
 * from the main Bun HTTP server process. It communicates via newline-delimited
 * JSON over stdin (commands) and stdout (events). stderr is used for debug
 * logging.
 *
 * Why Node.js instead of Bun: node-pty creates tty.ReadStream on PTY master
 * file descriptors. Bun's tty.ReadStream implementation does not fire data
 * events for these streams, so `onData` never fires — even in an isolated
 * subprocess. Node.js handles tty.ReadStream correctly, so the PTY Host runs
 * under Node.js while the main server continues to run under Bun.
 *
 * Architecture rationale: Running node-pty inside the main HTTP server process
 * causes SIGHUP to kill interactive shells within milliseconds due to event
 * loop and signal handling interference. Process isolation eliminates this.
 *
 * See PRD-pty-host.md for full design details.
 *
 * IPC Protocol:
 *
 * Commands (stdin, server -> PTY Host):
 *   { type: "spawn", id, shell, args, cwd, env, cols, rows }
 *   { type: "write", id, data }
 *   { type: "resize", id, cols, rows }
 *   { type: "kill", id }
 *
 * Events (stdout, PTY Host -> server):
 *   { type: "ready" }
 *   { type: "data", id, data }  — data is raw UTF-8
 *   { type: "exit", id, exitCode, signal }
 *   { type: "error", id?, message }
 */

import { createRequire } from "node:module";
import type { IPty } from "node-pty";

// createRequire is needed because this script runs under Node.js as ESM
// (the package has "type": "module"), where bare `require()` is unavailable.
const require_ = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpawnCommand {
	readonly args: readonly string[];
	readonly cols: number;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly id: string;
	readonly rows: number;
	readonly shell: string;
	readonly type: "spawn";
}

interface WriteCommand {
	readonly data: string;
	readonly id: string;
	readonly type: "write";
}

interface ResizeCommand {
	readonly cols: number;
	readonly id: string;
	readonly rows: number;
	readonly type: "resize";
}

interface KillCommand {
	readonly id: string;
	readonly type: "kill";
}

type Command = SpawnCommand | WriteCommand | ResizeCommand | KillCommand;

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
// State
// ---------------------------------------------------------------------------

const ptys = new Map<string, IPty>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a JSON event to stdout (one line per event). */
function emit(event: PtyEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Log to stderr for debugging (not part of IPC protocol). */
function debug(message: string, ...args: unknown[]): void {
	console.error(`[pty-host] ${message}`, ...args);
}

// ---------------------------------------------------------------------------
// Spawn-helper permission check
// ---------------------------------------------------------------------------

/**
 * Ensure spawn-helper binaries have execute permissions.
 *
 * After `bun install`, the spawn-helper files in node-pty prebuilds may
 * lose their execute bit. This function finds and fixes them on startup,
 * replacing the need for a postinstall script.
 */
async function fixSpawnHelperPermissions(): Promise<void> {
	const { readdir, chmod, stat } = await import("node:fs/promises");
	const { join, dirname } = await import("node:path");

	// Resolve the node-pty package directory using the top-level require_
	let nodePtyDir: string;
	try {
		const nodePtyMain = require_.resolve("node-pty");
		nodePtyDir = dirname(nodePtyMain);
		// Walk up to the package root (node-pty/lib/index.js -> node-pty/)
		while (nodePtyDir !== "/" && !nodePtyDir.endsWith("node-pty")) {
			nodePtyDir = dirname(nodePtyDir);
		}
	} catch {
		debug("Could not resolve node-pty package path, skipping permission fix");
		return;
	}

	const prebuildsDir = join(nodePtyDir, "prebuilds");

	try {
		const platforms = await readdir(prebuildsDir);
		for (const platform of platforms) {
			const helperPath = join(prebuildsDir, platform, "spawn-helper");
			try {
				const st = await stat(helperPath);
				// Check if execute bit is missing for owner
				const isExecutable = Boolean(
					// biome-ignore lint/suspicious/noBitwiseOperators: bitwise check for file permissions
					(st.mode ?? 0) & 0o100
				);
				if (!isExecutable) {
					await chmod(helperPath, 0o755);
					debug("Fixed execute permission on %s", helperPath);
				}
			} catch {
				// spawn-helper doesn't exist for this platform, skip
			}
		}
	} catch {
		debug("No prebuilds directory found at %s, skipping", prebuildsDir);
	}
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function handleSpawn(cmd: SpawnCommand): void {
	if (ptys.has(cmd.id)) {
		emit({
			type: "error",
			id: cmd.id,
			message: `PTY with id "${cmd.id}" already exists`,
		});
		return;
	}

	try {
		// Import node-pty synchronously via createRequire (this script runs as
		// ESM under Node.js, so bare require() is not available)
		const nodePty = require_("node-pty") as typeof import("node-pty");

		const pty = nodePty.spawn(cmd.shell, cmd.args as string[], {
			name: "xterm-256color",
			cols: cmd.cols,
			rows: cmd.rows,
			cwd: cmd.cwd,
			env: cmd.env,
		});

		ptys.set(cmd.id, pty);

		// Forward PTY output as raw UTF-8 data events.
		// node-pty's onData produces UTF-8 strings, and JSON natively supports
		// UTF-8 with proper escaping via JSON.stringify, so no base64 encoding
		// is needed. This avoids the 33% data inflation of base64.
		pty.onData((data: string) => {
			emit({ type: "data", id: cmd.id, data });
		});

		// Forward PTY exit
		pty.onExit(({ exitCode, signal }) => {
			const code = exitCode ?? -1;
			const sig = signal ?? -1;
			debug("PTY exited id=%s code=%d signal=%d", cmd.id, code, sig);
			ptys.delete(cmd.id);
			emit({ type: "exit", id: cmd.id, exitCode: code, signal: sig });
		});

		debug("Spawned PTY id=%s pid=%d shell=%s", cmd.id, pty.pid, cmd.shell);
	} catch (error) {
		emit({
			type: "error",
			id: cmd.id,
			message: `Failed to spawn PTY: ${String(error)}`,
		});
	}
}

function handleWrite(cmd: WriteCommand): void {
	const pty = ptys.get(cmd.id);
	if (pty === undefined) {
		emit({
			type: "error",
			id: cmd.id,
			message: `PTY not found: ${cmd.id}`,
		});
		return;
	}

	try {
		pty.write(cmd.data);
	} catch (error) {
		emit({
			type: "error",
			id: cmd.id,
			message: `Failed to write to PTY: ${String(error)}`,
		});
	}
}

function handleResize(cmd: ResizeCommand): void {
	const pty = ptys.get(cmd.id);
	if (pty === undefined) {
		emit({
			type: "error",
			id: cmd.id,
			message: `PTY not found: ${cmd.id}`,
		});
		return;
	}

	try {
		pty.resize(cmd.cols, cmd.rows);
		debug("Resized PTY id=%s cols=%d rows=%d", cmd.id, cmd.cols, cmd.rows);
	} catch (error) {
		emit({
			type: "error",
			id: cmd.id,
			message: `Failed to resize PTY: ${String(error)}`,
		});
	}
}

function handleKill(cmd: KillCommand): void {
	const pty = ptys.get(cmd.id);
	if (pty === undefined) {
		emit({
			type: "error",
			id: cmd.id,
			message: `PTY not found: ${cmd.id}`,
		});
		return;
	}

	try {
		pty.kill();
		debug("Killed PTY id=%s", cmd.id);
		// Note: the onExit handler will emit the exit event and clean up the map
	} catch (error) {
		emit({
			type: "error",
			id: cmd.id,
			message: `Failed to kill PTY: ${String(error)}`,
		});
	}
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

function isValidCommand(parsed: unknown): parsed is Command {
	if (typeof parsed !== "object" || parsed === null) {
		return false;
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.type !== "string") {
		return false;
	}

	switch (obj.type) {
		case "spawn":
			return (
				typeof obj.id === "string" &&
				typeof obj.shell === "string" &&
				Array.isArray(obj.args) &&
				typeof obj.cwd === "string" &&
				typeof obj.env === "object" &&
				obj.env !== null &&
				typeof obj.cols === "number" &&
				typeof obj.rows === "number"
			);
		case "write":
			return typeof obj.id === "string" && typeof obj.data === "string";
		case "resize":
			return (
				typeof obj.id === "string" &&
				typeof obj.cols === "number" &&
				typeof obj.rows === "number"
			);
		case "kill":
			return typeof obj.id === "string";
		default:
			return false;
	}
}

function processLine(line: string): void {
	const trimmed = line.trim();
	if (trimmed === "") {
		return;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		emit({
			type: "error",
			message: `Invalid JSON: ${trimmed.slice(0, 100)}`,
		});
		return;
	}

	if (!isValidCommand(parsed)) {
		emit({
			type: "error",
			message: `Invalid command: ${trimmed.slice(0, 100)}`,
		});
		return;
	}

	switch (parsed.type) {
		case "spawn":
			handleSpawn(parsed);
			break;
		case "write":
			handleWrite(parsed);
			break;
		case "resize":
			handleResize(parsed);
			break;
		case "kill":
			handleKill(parsed);
			break;
		default:
			// isValidCommand already filters to known types, but satisfy exhaustiveness
			emit({
				type: "error",
				message: `Unknown command type: ${(parsed as Record<string, unknown>).type}`,
			});
			break;
	}
}

// ---------------------------------------------------------------------------
// Stdin line reader
// ---------------------------------------------------------------------------

/**
 * Read stdin as newline-delimited text and process each line as a command.
 * Uses Node.js process.stdin stream (compatible with Node.js runtime).
 */
async function readStdin(): Promise<void> {
	let buffer = "";

	for await (const chunk of process.stdin) {
		buffer +=
			typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8");

		let newlineIdx = buffer.indexOf("\n");
		while (newlineIdx !== -1) {
			const line = buffer.slice(0, newlineIdx);
			buffer = buffer.slice(newlineIdx + 1);
			processLine(line);
			newlineIdx = buffer.indexOf("\n");
		}
	}

	// Process any remaining data after stdin closes
	if (buffer.trim() !== "") {
		processLine(buffer);
	}

	debug("stdin closed, shutting down");
	// Kill all remaining PTYs on shutdown
	for (const [id, pty] of ptys) {
		debug("Cleaning up PTY id=%s on shutdown", id);
		try {
			pty.kill();
		} catch {
			// Best effort cleanup
		}
	}
	ptys.clear();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	debug("Starting PTY Host (pid=%d)", process.pid);

	// Fix spawn-helper permissions before anything else
	await fixSpawnHelperPermissions();

	// Signal readiness to the parent process
	emit({ type: "ready" });
	debug("Ready");

	// Start reading commands from stdin
	await readStdin();
}

main().catch((error) => {
	debug("Fatal error: %s", String(error));
	emit({
		type: "error",
		message: `PTY Host fatal error: ${String(error)}`,
	});
	process.exit(1);
});
