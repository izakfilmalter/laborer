import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tables } from "@laborer/shared/schema";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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

let scope: Scope.CloseableScope;
let runEffect: <A, E>(
	effect: Effect.Effect<A, E, ProjectRegistry | LaborerStore>
) => Promise<A>;

beforeEach(async () => {
	scope = Effect.runSync(Scope.make());
	const context = await Effect.runPromise(
		Layer.buildWithScope(TestLayer, scope)
	);
	runEffect = <A, E>(
		effect: Effect.Effect<A, E, ProjectRegistry | LaborerStore>
	) => Effect.runPromise(Effect.provide(effect, Layer.succeedContext(context)));
});

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

afterEach(async () => {
	if (scope) {
		await Effect.runPromise(Scope.close(scope, Exit.void));
	}
});

describe("ProjectRegistry integration with WorktreeReconciler", () => {
	it("addProject creates workspace records for main and linked worktrees", async () => {
		const repoPath = initRepo("project-registry-detect", tempRoots);
		const linkedPath = join(repoPath, ".worktrees", "feature-d");
		git(`worktree add -b feature/d ${linkedPath}`, repoPath);

		const project = await runEffect(
			Effect.gen(function* () {
				const registry = yield* ProjectRegistry;
				return yield* registry.addProject(repoPath);
			})
		);

		const rows = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				return store.query(tables.workspaces.where("projectId", project.id));
			})
		);

		expect(rows.length).toBe(2);
		expect(rows.every((row) => row.origin === "external")).toBe(true);
		expect(rows.every((row) => row.status === "stopped")).toBe(true);
	});
});
