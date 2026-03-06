/**
 * Playwright Global Setup
 *
 * Runs once before all E2E tests:
 * 1. Creates a temp git repository with an initial commit (for project tests)
 * 2. Checks if services are already running (developer has turbo dev open)
 * 3. If not, starts `turbo dev` with DATA_DIR pointing to a temp directory
 * 4. Polls health endpoints until all 3 services are healthy
 *
 * Stores process references and temp paths in a state file for teardown.
 *
 * @see PRD-e2e-test-coverage.md — Global Setup / Teardown
 */

import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FullConfig } from "@playwright/test";

/** Path to the state file shared between setup and teardown. */
const STATE_FILE = join(tmpdir(), "laborer-e2e-state.json");

/** Maximum time to wait for all services to become healthy (ms). */
const HEALTH_CHECK_TIMEOUT = 120_000;

/** Interval between health check polls (ms). */
const HEALTH_CHECK_INTERVAL = 2000;

/**
 * Check if a service is already running by attempting a single fetch.
 */
async function isServiceRunning(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(3000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Poll a URL until it returns a 200 response or timeout is reached.
 * Returns true if healthy, false if timed out.
 */
async function pollEndpoint(
	url: string,
	timeoutMs: number,
	intervalMs: number
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) {
				return true;
			}
		} catch {
			// Service not ready yet — retry
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return false;
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
	// 1. Create a temp git repository with an initial commit
	const tempRepoDir = mkdtempSync(join(tmpdir(), "laborer-e2e-repo-"));
	execSync("git init", { cwd: tempRepoDir, stdio: "pipe" });
	execSync("git config user.email 'e2e@test.local'", {
		cwd: tempRepoDir,
		stdio: "pipe",
	});
	execSync("git config user.name 'E2E Test'", {
		cwd: tempRepoDir,
		stdio: "pipe",
	});
	writeFileSync(join(tempRepoDir, "README.md"), "# E2E Test Repo\n");
	execSync("git add .", { cwd: tempRepoDir, stdio: "pipe" });
	execSync('git commit -m "Initial commit"', {
		cwd: tempRepoDir,
		stdio: "pipe",
	});

	// 2. Check if services are already running
	const [webRunning, serverRunning, terminalRunning] = await Promise.all([
		isServiceRunning("http://localhost:3001"),
		isServiceRunning("http://localhost:3000"),
		isServiceRunning("http://localhost:3002"),
	]);

	const allRunning = webRunning && serverRunning && terminalRunning;
	let turboPid: number | null = null;
	let dataDirBase: string | null = null;

	if (allRunning) {
		// Services already running — skip starting turbo dev.
		// This is the common developer workflow where turbo dev is already open.
		process.stdout.write(
			"[e2e] All services already running, skipping turbo dev startup\n"
		);
	} else {
		// 3. Start turbo dev with isolated DATA_DIR
		dataDirBase = mkdtempSync(join(tmpdir(), "laborer-e2e-data-"));
		mkdirSync(join(dataDirBase, "data"), { recursive: true });

		const monorepoRoot = resolve(import.meta.dirname, "../../..");
		const turboProcess = spawn("turbo", ["dev"], {
			cwd: monorepoRoot,
			stdio: "pipe",
			env: {
				...process.env,
				DATA_DIR: dataDirBase,
			},
			detached: true,
		});

		turboPid = turboProcess.pid ?? null;

		// Log turbo output for debugging
		turboProcess.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			if (
				text.includes("error") ||
				text.includes("Error") ||
				text.includes("listening") ||
				text.includes("ready") ||
				text.includes("started")
			) {
				process.stdout.write(`[turbo] ${text}`);
			}
		});

		turboProcess.stderr?.on("data", (chunk: Buffer) => {
			process.stderr.write(`[turbo:err] ${chunk.toString()}`);
		});

		// Give turbo a moment to start spawning child processes
		await new Promise((r) => setTimeout(r, 3000));

		// 4. Poll health endpoints until all 3 services are healthy
		interface ServiceStatus {
			server: boolean;
			terminal: boolean;
			web: boolean;
		}

		const status: ServiceStatus = {
			web: false,
			server: false,
			terminal: false,
		};

		const checks = await Promise.all([
			pollEndpoint(
				"http://localhost:3001",
				HEALTH_CHECK_TIMEOUT,
				HEALTH_CHECK_INTERVAL
			).then((ok) => {
				status.web = ok;
				return ok;
			}),
			pollEndpoint(
				"http://localhost:3000",
				HEALTH_CHECK_TIMEOUT,
				HEALTH_CHECK_INTERVAL
			).then((ok) => {
				status.server = ok;
				return ok;
			}),
			pollEndpoint(
				"http://localhost:3002",
				HEALTH_CHECK_TIMEOUT,
				HEALTH_CHECK_INTERVAL
			).then((ok) => {
				status.terminal = ok;
				return ok;
			}),
		]);

		if (!checks.every(Boolean)) {
			const failed = Object.entries(status)
				.filter(([, ok]) => !ok)
				.map(([name]) => name);
			turboProcess.kill("SIGTERM");
			throw new Error(
				`E2E setup: Services failed to start: ${failed.join(", ")}. ` +
					"Check that turbo dev can start all services."
			);
		}
	}

	// 5. Save state for teardown and test access
	const state = {
		turboPid,
		dataDirBase,
		tempRepoDir,
		servicesWereAlreadyRunning: allRunning,
	};
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

	// Set env vars so tests can access the temp repo path
	process.env.E2E_TEMP_REPO_DIR = tempRepoDir;
	process.env.E2E_DATA_DIR = dataDirBase ?? "";
}
