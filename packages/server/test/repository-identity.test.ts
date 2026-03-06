import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { tables } from "@laborer/shared/schema";
import { Effect, Layer } from "effect";
import { afterAll } from "vitest";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
import { ProjectRegistry } from "../src/services/project-registry.js";
import { RepositoryIdentity } from "../src/services/repository-identity.js";
import { WorktreeDetector } from "../src/services/worktree-detector.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";
import { WorktreeWatcher } from "../src/services/worktree-watcher.js";
import { createTempDir, git, initRepo } from "./helpers/git-helpers.js";
import { TestLaborerStore } from "./helpers/test-store.js";

const tempRoots: string[] = [];

const IdentityTestLayer = RepositoryIdentity.layer;

const RegistryTestLayer = ProjectRegistry.layer.pipe(
	Layer.provide(RepositoryIdentity.layer),
	Layer.provide(WorktreeWatcher.layer),
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
	Layer.provide(PortAllocator.make(4400, 4410)),
	Layer.provideMerge(TestLaborerStore)
);

// Merge RepositoryIdentity into the registry test layer so tests can
// use both ProjectRegistry and RepositoryIdentity in the same effect.
const RegistryWithIdentityTestLayer = RegistryTestLayer.pipe(
	Layer.provideMerge(RepositoryIdentity.layer)
);

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

// ---------------------------------------------------------------------------
// RepositoryIdentity service tests
// ---------------------------------------------------------------------------

describe("RepositoryIdentity", () => {
	it.effect("resolves canonical identity for a repo root", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("identity-root", tempRoots);
			const identity = yield* RepositoryIdentity;
			const result = yield* identity.resolve(repoPath);

			assert.isString(result.canonicalRoot);
			assert.isString(result.canonicalGitCommonDir);
			assert.isString(result.repoId);
			assert.isTrue(result.isMainWorktree);
			assert.strictEqual(result.repoId.length, 16);
		}).pipe(Effect.provide(IdentityTestLayer))
	);

	it.effect("resolves a nested directory to the same repo root", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("identity-nested", tempRoots);
			const nestedDir = join(repoPath, "src");
			mkdirSync(nestedDir, { recursive: true });

			const identity = yield* RepositoryIdentity;
			const rootResult = yield* identity.resolve(repoPath);
			const nestedResult = yield* identity.resolve(nestedDir);

			assert.strictEqual(rootResult.canonicalRoot, nestedResult.canonicalRoot);
			assert.strictEqual(rootResult.repoId, nestedResult.repoId);
			assert.strictEqual(
				rootResult.canonicalGitCommonDir,
				nestedResult.canonicalGitCommonDir
			);
		}).pipe(Effect.provide(IdentityTestLayer))
	);

	it.effect("resolves a symlinked path to the same repo identity", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("identity-symlink", tempRoots);
			const symlinkDir = createTempDir("identity-symlink-link", tempRoots);
			const symlinkPath = join(symlinkDir, "linked-repo");
			symlinkSync(repoPath, symlinkPath);

			const identity = yield* RepositoryIdentity;
			const directResult = yield* identity.resolve(repoPath);
			const symlinkResult = yield* identity.resolve(symlinkPath);

			assert.strictEqual(
				directResult.canonicalRoot,
				symlinkResult.canonicalRoot
			);
			assert.strictEqual(directResult.repoId, symlinkResult.repoId);
			assert.strictEqual(
				directResult.canonicalGitCommonDir,
				symlinkResult.canonicalGitCommonDir
			);
		}).pipe(Effect.provide(IdentityTestLayer))
	);

	it.effect(
		"resolves a linked worktree to the same repo with isMainWorktree = false",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("identity-worktree", tempRoots);
				const linkedPath = join(repoPath, ".worktrees", "feature-x");
				git(`worktree add -b feature/x ${linkedPath}`, repoPath);

				const identity = yield* RepositoryIdentity;
				const mainResult = yield* identity.resolve(repoPath);
				const worktreeResult = yield* identity.resolve(linkedPath);

				assert.isTrue(mainResult.isMainWorktree);
				assert.isFalse(worktreeResult.isMainWorktree);
				assert.strictEqual(mainResult.repoId, worktreeResult.repoId);
				assert.strictEqual(
					mainResult.canonicalGitCommonDir,
					worktreeResult.canonicalGitCommonDir
				);
				// The linked worktree has a different checkout root
				assert.notStrictEqual(
					mainResult.canonicalRoot,
					worktreeResult.canonicalRoot
				);
			}).pipe(Effect.provide(IdentityTestLayer))
	);

	it.effect("fails for a non-existent path", () =>
		Effect.gen(function* () {
			const identity = yield* RepositoryIdentity;
			const result = yield* identity
				.resolve("/nonexistent/path/that/does/not/exist")
				.pipe(Effect.flip);

			assert.include(result.message, "does not exist");
		}).pipe(Effect.provide(IdentityTestLayer))
	);

	it.effect("fails for a non-git directory", () =>
		Effect.gen(function* () {
			const nonGitDir = createTempDir("identity-nongit", tempRoots);
			const identity = yield* RepositoryIdentity;
			const result = yield* identity.resolve(nonGitDir).pipe(Effect.flip);

			assert.isString(result.message);
		}).pipe(Effect.provide(IdentityTestLayer))
	);

	it.effect(
		"resolves repos with shared git dir consistently across worktrees",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("identity-shared-git", tempRoots);
				const wt1Path = join(repoPath, ".worktrees", "wt1");
				const wt2Path = join(repoPath, ".worktrees", "wt2");
				git(`worktree add -b wt1 ${wt1Path}`, repoPath);
				git(`worktree add -b wt2 ${wt2Path}`, repoPath);

				const identity = yield* RepositoryIdentity;
				const mainResult = yield* identity.resolve(repoPath);
				const wt1Result = yield* identity.resolve(wt1Path);
				const wt2Result = yield* identity.resolve(wt2Path);

				// All three should share the same repoId and git common dir
				assert.strictEqual(mainResult.repoId, wt1Result.repoId);
				assert.strictEqual(mainResult.repoId, wt2Result.repoId);
				assert.strictEqual(
					mainResult.canonicalGitCommonDir,
					wt1Result.canonicalGitCommonDir
				);
				assert.strictEqual(
					mainResult.canonicalGitCommonDir,
					wt2Result.canonicalGitCommonDir
				);
			}).pipe(Effect.provide(IdentityTestLayer))
	);
});

// ---------------------------------------------------------------------------
// ProjectRegistry canonical deduplication tests
// ---------------------------------------------------------------------------

describe("ProjectRegistry canonical deduplication", () => {
	it.scoped("adding a repo root registers a project using canonical path", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("registry-canonical", tempRoots);
			const registry = yield* ProjectRegistry;
			const project = yield* registry.addProject(repoPath);

			const identity = yield* RepositoryIdentity;
			const repoIdentity = yield* identity.resolve(repoPath);

			// The stored repoPath should be the canonical root
			assert.strictEqual(project.repoPath, repoIdentity.canonicalRoot);
		}).pipe(Effect.provide(RegistryWithIdentityTestLayer))
	);

	it.scoped(
		"adding a nested directory does not create a duplicate project",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("registry-nested-dedup", tempRoots);
				const nestedDir = join(repoPath, "src");
				mkdirSync(nestedDir, { recursive: true });

				const registry = yield* ProjectRegistry;

				// Register via repo root
				const project = yield* registry.addProject(repoPath);

				// Attempt to register via nested path — should fail as duplicate
				const result = yield* registry.addProject(nestedDir).pipe(Effect.flip);

				assert.include(result.message, "already registered");

				// Confirm only one project exists
				const { store } = yield* LaborerStore;
				const projects = store.query(tables.projects);
				const matchingProjects = projects.filter(
					(p) => p.repoPath === project.repoPath
				);
				assert.strictEqual(matchingProjects.length, 1);
			}).pipe(Effect.provide(RegistryTestLayer))
	);

	it.scoped("adding a symlinked path does not create a duplicate project", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("registry-symlink-dedup", tempRoots);
			const symlinkDir = createTempDir(
				"registry-symlink-dedup-link",
				tempRoots
			);
			const symlinkPath = join(symlinkDir, "linked-repo");
			symlinkSync(repoPath, symlinkPath);

			const registry = yield* ProjectRegistry;

			// Register via real path
			const project = yield* registry.addProject(repoPath);

			// Attempt to register via symlink — should fail as duplicate
			const result = yield* registry.addProject(symlinkPath).pipe(Effect.flip);

			assert.include(result.message, "already registered");

			// Confirm only one project exists
			const { store } = yield* LaborerStore;
			const projects = store.query(tables.projects);
			const matchingProjects = projects.filter(
				(p) => p.repoPath === project.repoPath
			);
			assert.strictEqual(matchingProjects.length, 1);
		}).pipe(Effect.provide(RegistryTestLayer))
	);
});
