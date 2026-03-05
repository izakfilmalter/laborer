import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { events, schema, tables } from "@laborer/shared/schema";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
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

const getDefaultBranchForTest = (repoPath: string): string => {
	try {
		git("rev-parse --verify refs/heads/main", repoPath);
		return "main";
	} catch {
		// fall through
	}

	try {
		git("rev-parse --verify refs/heads/master", repoPath);
		return "master";
	} catch {
		return "HEAD";
	}
};

const getDetectedWorktreePaths = (repoPath: string): string[] =>
	git("worktree list --porcelain", repoPath)
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));

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

const TestLayer = WorktreeReconciler.layer.pipe(
	Layer.provideMerge(WorktreeDetector.layer),
	Layer.provideMerge(PortAllocator.make(4100, 4110)),
	Layer.provideMerge(TestLaborerStore)
);

let scope: Scope.CloseableScope;
let runEffect: <A, E>(
	effect: Effect.Effect<A, E, WorktreeReconciler | LaborerStore | PortAllocator>
) => Promise<A>;

beforeEach(async () => {
	scope = Effect.runSync(Scope.make());
	const context = await Effect.runPromise(
		Layer.buildWithScope(TestLayer, scope)
	);
	runEffect = <A, E>(
		effect: Effect.Effect<
			A,
			E,
			WorktreeReconciler | LaborerStore | PortAllocator
		>
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

describe("WorktreeReconciler", () => {
	it("creates external stopped workspaces for detected worktrees", async () => {
		const repoPath = initRepo("reconciler-create");
		const linkedPath = join(repoPath, ".worktrees", "feature-c");
		git(`worktree add -b feature/c ${linkedPath}`, repoPath);

		const result = await runEffect(
			Effect.gen(function* () {
				const reconciler = yield* WorktreeReconciler;
				return yield* reconciler.reconcile("project-1", repoPath);
			})
		);

		expect(result.added).toBe(2);

		const rows = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				return store.query(tables.workspaces.where("projectId", "project-1"));
			})
		);

		expect(rows.length).toBe(2);
		for (const row of rows) {
			expect(row.origin).toBe("external");
			expect(row.status).toBe("stopped");
			expect(row.port).toBe(0);
		}
	});

	it("leaves matching existing workspace records untouched", async () => {
		const repoPath = initRepo("reconciler-unchanged");
		const [mainWorktreePath] = getDetectedWorktreePaths(repoPath);

		await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.workspaceCreated({
						id: "existing-main-workspace",
						projectId: "project-unchanged",
						taskSource: null,
						branchName: "custom/main",
						worktreePath: mainWorktreePath ?? repoPath,
						port: 4321,
						status: "running",
						origin: "laborer",
						createdAt: new Date().toISOString(),
						baseSha: "custom-base-sha",
					})
				);
			})
		);

		const result = await runEffect(
			Effect.gen(function* () {
				const reconciler = yield* WorktreeReconciler;
				return yield* reconciler.reconcile("project-unchanged", repoPath);
			})
		);

		expect(result.added).toBe(0);
		expect(result.removed).toBe(0);
		expect(result.unchanged).toBe(1);

		const rows = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				return store.query(
					tables.workspaces.where("projectId", "project-unchanged")
				);
			})
		);

		expect(rows.length).toBe(1);
		expect(rows[0]?.id).toBe("existing-main-workspace");
		expect(rows[0]?.origin).toBe("laborer");
		expect(rows[0]?.status).toBe("running");
		expect(rows[0]?.port).toBe(4321);
	});

	it("removes stale workspace records not present on disk", async () => {
		const repoPath = initRepo("reconciler-stale");
		const stalePath = join(repoPath, ".worktrees", "missing");

		await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.workspaceCreated({
						id: "stale-workspace",
						projectId: "project-2",
						taskSource: null,
						branchName: "feature/missing",
						worktreePath: stalePath,
						port: 0,
						status: "stopped",
						origin: "external",
						createdAt: new Date().toISOString(),
						baseSha: null,
					})
				);
			})
		);

		const result = await runEffect(
			Effect.gen(function* () {
				const reconciler = yield* WorktreeReconciler;
				return yield* reconciler.reconcile("project-2", repoPath);
			})
		);

		expect(result.removed).toBe(1);

		const rows = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				return store.query(tables.workspaces.where("projectId", "project-2"));
			})
		);

		expect(rows.some((row) => row.id === "stale-workspace")).toBe(false);
	});

	it("handles mixed add, remove, and unchanged reconciliation", async () => {
		const repoPath = initRepo("reconciler-mixed");
		const linkedPath = join(repoPath, ".worktrees", "feature-mixed");
		const stalePath = join(repoPath, ".worktrees", "missing-mixed");
		git(`worktree add -b feature/mixed ${linkedPath}`, repoPath);
		const [mainWorktreePath] = getDetectedWorktreePaths(repoPath);

		await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.workspaceCreated({
						id: "existing-main",
						projectId: "project-mixed",
						taskSource: null,
						branchName: "main",
						worktreePath: mainWorktreePath ?? repoPath,
						port: 0,
						status: "stopped",
						origin: "external",
						createdAt: new Date().toISOString(),
						baseSha: null,
					})
				);
				store.commit(
					events.workspaceCreated({
						id: "stale-workspace",
						projectId: "project-mixed",
						taskSource: null,
						branchName: "feature/stale",
						worktreePath: stalePath,
						port: 0,
						status: "stopped",
						origin: "external",
						createdAt: new Date().toISOString(),
						baseSha: null,
					})
				);
			})
		);

		const result = await runEffect(
			Effect.gen(function* () {
				const reconciler = yield* WorktreeReconciler;
				return yield* reconciler.reconcile("project-mixed", repoPath);
			})
		);

		expect(result.added).toBe(1);
		expect(result.removed).toBe(1);
		expect(result.unchanged).toBe(1);

		const rows = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				return store.query(
					tables.workspaces.where("projectId", "project-mixed")
				);
			})
		);

		expect(rows.length).toBe(2);
		expect(rows.some((row) => row.id === "existing-main")).toBe(true);
		expect(rows.some((row) => row.branchName === "feature/mixed")).toBe(true);
		expect(rows.some((row) => row.id === "stale-workspace")).toBe(false);
	});

	it("derives base SHA from merge-base for detected worktrees", async () => {
		const repoPath = initRepo("reconciler-base-sha");
		git("checkout -b feature/base-sha", repoPath);
		writeFileSync(join(repoPath, "feature.txt"), "feature branch content\n");
		git("add feature.txt", repoPath);
		git('commit -m "feature commit"', repoPath);

		const result = await runEffect(
			Effect.gen(function* () {
				const reconciler = yield* WorktreeReconciler;
				return yield* reconciler.reconcile("project-base-sha", repoPath);
			})
		);

		expect(result.added).toBe(1);

		const defaultBranch = getDefaultBranchForTest(repoPath);
		const expectedBaseSha = git(`merge-base ${defaultBranch} HEAD`, repoPath);
		const rows = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				return store.query(
					tables.workspaces.where("projectId", "project-base-sha")
				);
			})
		);

		expect(rows.length).toBe(1);
		expect(rows[0]?.baseSha).toBe(expectedBaseSha);
	});

	it("frees allocated port when removing stale workspace", async () => {
		const repoPath = initRepo("reconciler-free-port");
		const stalePath = join(repoPath, ".worktrees", "missing-port");

		await runEffect(
			Effect.gen(function* () {
				const allocator = yield* PortAllocator;
				const allocatedPort = yield* allocator.allocate();
				const { store } = yield* LaborerStore;
				store.commit(
					events.workspaceCreated({
						id: "stale-port-workspace",
						projectId: "project-free-port",
						taskSource: null,
						branchName: "feature/stale-port",
						worktreePath: stalePath,
						port: allocatedPort,
						status: "stopped",
						origin: "external",
						createdAt: new Date().toISOString(),
						baseSha: null,
					})
				);
			})
		);

		const result = await runEffect(
			Effect.gen(function* () {
				const reconciler = yield* WorktreeReconciler;
				return yield* reconciler.reconcile("project-free-port", repoPath);
			})
		);

		expect(result.removed).toBe(1);

		const reusedPort = await runEffect(
			Effect.gen(function* () {
				const allocator = yield* PortAllocator;
				return yield* allocator.allocate();
			})
		);

		expect(reusedPort).toBe(4100);
	});
});
