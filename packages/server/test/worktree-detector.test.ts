import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll } from "vitest";
import {
	parsePorcelainOutput,
	WorktreeDetector,
} from "../src/services/worktree-detector.js";
import { createTempDir, git, initRepo } from "./helpers/git-helpers.js";

const tempRoots: string[] = [];

const normalizePath = (value: string): string => {
	try {
		return realpathSync(value);
	} catch {
		return value;
	}
};

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("WorktreeDetector", () => {
	it.effect("detects main worktree when no linked worktrees exist", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("detector-main-only", tempRoots);

			const service = yield* WorktreeDetector;
			const detected = yield* service.detect(repoPath);

			assert.strictEqual(detected.length, 1);
			assert.strictEqual(detected[0]?.isMain, true);
			assert.strictEqual(
				normalizePath(detected[0]?.path ?? ""),
				normalizePath(repoPath)
			);
			assert.isTrue((detected[0]?.head.length ?? 0) > 0);
		}).pipe(Effect.provide(WorktreeDetector.layer))
	);

	it.effect("detects one linked worktree with its branch name", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("detector-one-linked", tempRoots);
			const linkedPath = join(repoPath, ".worktrees", "feature-one");
			git(`worktree add -b feature/one ${linkedPath}`, repoPath);

			const service = yield* WorktreeDetector;
			const detected = yield* service.detect(repoPath);

			assert.strictEqual(detected.length, 2);
			const linked = detected.find(
				(entry) => normalizePath(entry.path) === normalizePath(linkedPath)
			);
			assert.strictEqual(linked?.branch, "feature/one");
			assert.strictEqual(linked?.isMain, false);
		}).pipe(Effect.provide(WorktreeDetector.layer))
	);

	it.effect("detects multiple linked worktrees", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("detector-multiple-linked", tempRoots);
			const linkedPathA = join(repoPath, ".worktrees", "feature-multi-a");
			const linkedPathB = join(repoPath, ".worktrees", "feature-multi-b");
			git(`worktree add -b feature/multi-a ${linkedPathA}`, repoPath);
			git(`worktree add -b feature/multi-b ${linkedPathB}`, repoPath);

			const service = yield* WorktreeDetector;
			const detected = yield* service.detect(repoPath);

			assert.strictEqual(detected.length, 3);
			assert.isTrue(
				detected.some(
					(entry) => normalizePath(entry.path) === normalizePath(linkedPathA)
				)
			);
			assert.isTrue(
				detected.some(
					(entry) => normalizePath(entry.path) === normalizePath(linkedPathB)
				)
			);
		}).pipe(Effect.provide(WorktreeDetector.layer))
	);

	it.effect("detects linked worktrees and detached HEAD", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("detector-linked", tempRoots);
			const linkedPath = join(repoPath, ".worktrees", "feature-a");
			git(`worktree add -b feature/a ${linkedPath}`, repoPath);
			git("checkout --detach", linkedPath);

			const service = yield* WorktreeDetector;
			const detected = yield* service.detect(repoPath);

			assert.strictEqual(detected.length, 2);
			const linked = detected.find(
				(entry) => normalizePath(entry.path) === normalizePath(linkedPath)
			);
			assert.isDefined(linked);
			assert.strictEqual(linked?.branch, null);
			assert.strictEqual(linked?.isMain, false);
		}).pipe(Effect.provide(WorktreeDetector.layer))
	);

	it.effect("marks only one entry as main worktree", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("detector-single-main", tempRoots);
			const linkedPath = join(repoPath, ".worktrees", "feature-main-check");
			git(`worktree add -b feature/main-check ${linkedPath}`, repoPath);

			const service = yield* WorktreeDetector;
			const detected = yield* service.detect(repoPath);

			const mainEntries = detected.filter((entry) => entry.isMain);
			assert.strictEqual(mainEntries.length, 1);
			assert.strictEqual(
				normalizePath(mainEntries[0]?.path ?? ""),
				normalizePath(repoPath)
			);
		}).pipe(Effect.provide(WorktreeDetector.layer))
	);

	it.effect("detects linked worktrees outside the repository directory", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("detector-external-path", tempRoots);
			const linkedPath = join(
				createTempDir("detector-external-worktree", tempRoots),
				"external"
			);
			git(`worktree add -b feature/external ${linkedPath}`, repoPath);

			const service = yield* WorktreeDetector;
			const detected = yield* service.detect(repoPath);

			assert.isTrue(
				detected.some(
					(entry) => normalizePath(entry.path) === normalizePath(linkedPath)
				)
			);
		}).pipe(Effect.provide(WorktreeDetector.layer))
	);

	it.effect("excludes prunable worktrees", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("detector-prunable", tempRoots);
			const linkedPath = join(repoPath, ".worktrees", "feature-b");
			git(`worktree add -b feature/b ${linkedPath}`, repoPath);
			rmSync(linkedPath, { recursive: true, force: true });

			const service = yield* WorktreeDetector;
			const detected = yield* service.detect(repoPath);

			assert.isFalse(detected.some((entry) => entry.path === linkedPath));
		}).pipe(Effect.provide(WorktreeDetector.layer))
	);

	it.effect("returns a typed error for non-git directories", () =>
		Effect.gen(function* () {
			const nonRepoPath = createTempDir("detector-non-repo", tempRoots);

			const service = yield* WorktreeDetector;
			const error = yield* service.detect(nonRepoPath).pipe(Effect.flip);

			assert.strictEqual(error.code, "WORKTREE_DETECT_FAILED");
		}).pipe(Effect.provide(WorktreeDetector.layer))
	);
});

describe("parsePorcelainOutput", () => {
	it("parses branch refs and prunable marker", () => {
		const parsed = parsePorcelainOutput(
			"worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/.worktrees/old\nHEAD def456\nprunable gitdir file points to non-existent location\n"
		);

		assert.strictEqual(parsed.length, 2);
		assert.strictEqual(parsed[0]?.branch, "main");
		assert.strictEqual(parsed[1]?.prunable, true);
	});
});
