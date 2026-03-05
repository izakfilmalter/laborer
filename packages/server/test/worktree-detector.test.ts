import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
	parsePorcelainOutput,
	WorktreeDetector,
} from "../src/services/worktree-detector.js";

const tempRoots: string[] = [];

const createTempDir = (prefix: string): string => {
	const dir = join(
		tmpdir(),
		`laborer-test-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	tempRoots.push(dir);
	return dir;
};

const git = (args: string, cwd: string): string =>
	execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();

const normalizePath = (value: string): string => {
	try {
		return realpathSync(value);
	} catch {
		return value;
	}
};

const initRepo = (prefix: string): string => {
	const repoPath = createTempDir(prefix);
	git("init", repoPath);
	git("config user.email test@example.com", repoPath);
	git("config user.name Test User", repoPath);
	writeFileSync(join(repoPath, "README.md"), "# test\n");
	git("add README.md", repoPath);
	git('commit -m "initial"', repoPath);
	return repoPath;
};

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("WorktreeDetector", () => {
	it("detects main worktree when no linked worktrees exist", async () => {
		const repoPath = initRepo("detector-main-only");

		const detected = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorktreeDetector;
				return yield* service.detect(repoPath);
			}).pipe(Effect.provide(WorktreeDetector.layer))
		);

		expect(detected.length).toBe(1);
		expect(detected[0]?.isMain).toBe(true);
		expect(normalizePath(detected[0]?.path ?? "")).toBe(
			normalizePath(repoPath)
		);
		expect(detected[0]?.head.length).toBeGreaterThan(0);
	});

	it("detects linked worktrees and detached HEAD", async () => {
		const repoPath = initRepo("detector-linked");
		const linkedPath = join(repoPath, ".worktrees", "feature-a");
		git(`worktree add -b feature/a ${linkedPath}`, repoPath);
		git("checkout --detach", linkedPath);

		const detected = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorktreeDetector;
				return yield* service.detect(repoPath);
			}).pipe(Effect.provide(WorktreeDetector.layer))
		);

		expect(detected.length).toBe(2);
		const linked = detected.find(
			(entry) => normalizePath(entry.path) === normalizePath(linkedPath)
		);
		expect(linked).toBeDefined();
		expect(linked?.branch).toBeNull();
		expect(linked?.isMain).toBe(false);
	});

	it("excludes prunable worktrees", async () => {
		const repoPath = initRepo("detector-prunable");
		const linkedPath = join(repoPath, ".worktrees", "feature-b");
		git(`worktree add -b feature/b ${linkedPath}`, repoPath);
		rmSync(linkedPath, { recursive: true, force: true });

		const detected = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorktreeDetector;
				return yield* service.detect(repoPath);
			}).pipe(Effect.provide(WorktreeDetector.layer))
		);

		expect(detected.some((entry) => entry.path === linkedPath)).toBe(false);
	});
});

describe("parsePorcelainOutput", () => {
	it("parses branch refs and prunable marker", () => {
		const parsed = parsePorcelainOutput(
			"worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/.worktrees/old\nHEAD def456\nprunable gitdir file points to non-existent location\n"
		);

		expect(parsed.length).toBe(2);
		expect(parsed[0]?.branch).toBe("main");
		expect(parsed[1]?.prunable).toBe(true);
	});
});
