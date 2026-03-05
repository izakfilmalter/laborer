import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, tables } from "@laborer/shared/schema";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
import { ProjectRegistry } from "../src/services/project-registry.js";
import { WorktreeDetector } from "../src/services/worktree-detector.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";

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

const TestLayer = ProjectRegistry.layer.pipe(
	Layer.provideMerge(WorktreeReconciler.layer),
	Layer.provideMerge(WorktreeDetector.layer),
	Layer.provideMerge(PortAllocator.make(4200, 4210)),
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
		const repoPath = initRepo("project-registry-detect");
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
