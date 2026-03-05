import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { events, schema, tables } from "@laborer/shared/schema";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService } from "../src/services/config-service.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
import { ProjectRegistry } from "../src/services/project-registry.js";
import { WorkspaceProvider } from "../src/services/workspace-provider.js";
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

const TestLayer = WorkspaceProvider.layer.pipe(
	Layer.provideMerge(ProjectRegistry.layer),
	Layer.provideMerge(WorktreeReconciler.layer),
	Layer.provideMerge(WorktreeDetector.layer),
	Layer.provideMerge(ConfigService.layer),
	Layer.provideMerge(PortAllocator.make(4300, 4300)),
	Layer.provideMerge(TestLaborerStore)
);

const ensureBunSpawnForNodeTests = (): void => {
	const runtimeGlobal = globalThis as unknown as { Bun?: unknown };

	if (runtimeGlobal.Bun !== undefined) {
		return;
	}

	runtimeGlobal.Bun = {
		spawn: (cmd: string[], options?: { readonly cwd?: string }) => {
			const child = spawn(cmd[0] ?? "", cmd.slice(1), {
				cwd: options?.cwd,
			});

			return {
				stdout: child.stdout,
				stderr: child.stderr,
				exited: new Promise<number>((resolve) => {
					child.on("close", (code) => resolve(code ?? 1));
				}),
			};
		},
	};
};

let scope: Scope.CloseableScope;
let runEffect: <A, E>(
	effect: Effect.Effect<A, E, WorkspaceProvider | LaborerStore | PortAllocator>
) => Promise<A>;

beforeEach(async () => {
	ensureBunSpawnForNodeTests();
	scope = Effect.runSync(Scope.make());
	const context = await Effect.runPromise(
		Layer.buildWithScope(TestLayer, scope)
	);
	runEffect = <A, E>(
		effect: Effect.Effect<
			A,
			E,
			WorkspaceProvider | LaborerStore | PortAllocator
		>
	) => Effect.runPromise(Effect.provide(effect, Layer.succeedContext(context)));
});

afterEach(async () => {
	if (scope) {
		await Effect.runPromise(Scope.close(scope, Exit.void));
	}
});

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("WorkspaceProvider.destroyWorktree origin behavior", () => {
	it("keeps git worktree and branch for external workspaces", async () => {
		const repoPath = initRepo("destroy-external");
		const branchName = "feature/external";
		const worktreePath = join(repoPath, ".worktrees", "external");
		git(`worktree add -b ${branchName} ${worktreePath}`, repoPath);

		const projectId = crypto.randomUUID();
		const workspaceId = crypto.randomUUID();
		const allocatedPort = await runEffect(
			Effect.gen(function* () {
				const allocator = yield* PortAllocator;
				return yield* allocator.allocate();
			})
		);

		await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: projectId,
						repoPath,
						name: "destroy-external",
						rlphConfig: null,
					})
				);
				store.commit(
					events.workspaceCreated({
						id: workspaceId,
						projectId,
						taskSource: null,
						branchName,
						worktreePath,
						port: allocatedPort,
						status: "stopped",
						origin: "external",
						createdAt: new Date().toISOString(),
						baseSha: null,
					})
				);

				const provider = yield* WorkspaceProvider;
				yield* provider.destroyWorktree(workspaceId);
			})
		);

		expect(existsSync(worktreePath)).toBe(true);
		expect(git(`branch --list ${branchName}`, repoPath)).toContain(branchName);

		const workspaceRows = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				return store.query(tables.workspaces.where("id", workspaceId));
			})
		);
		expect(workspaceRows).toHaveLength(0);

		const reallocatedPort = await runEffect(
			Effect.gen(function* () {
				const allocator = yield* PortAllocator;
				return yield* allocator.allocate();
			})
		);
		expect(reallocatedPort).toBe(allocatedPort);
	});

	it("removes git worktree and branch for laborer workspaces", async () => {
		const repoPath = initRepo("destroy-laborer");
		const branchName = "feature/laborer";
		const worktreePath = join(repoPath, ".worktrees", "laborer");
		git(`worktree add -b ${branchName} ${worktreePath}`, repoPath);

		const projectId = crypto.randomUUID();
		const workspaceId = crypto.randomUUID();

		await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: projectId,
						repoPath,
						name: "destroy-laborer",
						rlphConfig: null,
					})
				);
				store.commit(
					events.workspaceCreated({
						id: workspaceId,
						projectId,
						taskSource: null,
						branchName,
						worktreePath,
						port: 0,
						status: "stopped",
						origin: "laborer",
						createdAt: new Date().toISOString(),
						baseSha: null,
					})
				);

				const provider = yield* WorkspaceProvider;
				yield* provider.destroyWorktree(workspaceId);
			})
		);

		expect(existsSync(worktreePath)).toBe(false);
		expect(git(`branch --list ${branchName}`, repoPath)).toBe("");

		const workspaceRows = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				return store.query(tables.workspaces.where("id", workspaceId));
			})
		);
		expect(workspaceRows).toHaveLength(0);
	});
});
