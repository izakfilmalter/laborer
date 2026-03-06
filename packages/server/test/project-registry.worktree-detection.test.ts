import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { tables } from "@laborer/shared/schema";
import { Effect, Layer } from "effect";
import { afterAll } from "vitest";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
import { ProjectRegistry } from "../src/services/project-registry.js";
import { WorktreeDetector } from "../src/services/worktree-detector.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";
import { WorktreeWatcher } from "../src/services/worktree-watcher.js";
import { git, initRepo } from "./helpers/git-helpers.js";
import { TestLaborerStore } from "./helpers/test-store.js";

const tempRoots: string[] = [];

const TestLayer = ProjectRegistry.layer.pipe(
	Layer.provide(WorktreeWatcher.layer),
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
	Layer.provide(PortAllocator.make(4200, 4210)),
	Layer.provideMerge(TestLaborerStore)
);

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("ProjectRegistry integration with WorktreeReconciler", () => {
	it.scoped(
		"addProject creates workspace records for main and linked worktrees",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("project-registry-detect", tempRoots);
				const linkedPath = join(repoPath, ".worktrees", "feature-d");
				git(`worktree add -b feature/d ${linkedPath}`, repoPath);

				const registry = yield* ProjectRegistry;
				const project = yield* registry.addProject(repoPath);

				const { store } = yield* LaborerStore;
				const rows = store.query(
					tables.workspaces.where("projectId", project.id)
				);

				assert.strictEqual(rows.length, 2);
				assert.isTrue(rows.every((row) => row.origin === "external"));
				assert.isTrue(rows.every((row) => row.status === "stopped"));
			}).pipe(Effect.provide(TestLayer))
	);
});
