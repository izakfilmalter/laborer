import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { events, tables } from "@laborer/shared/schema";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll } from "vitest";
import { BranchStateTracker } from "../src/services/branch-state-tracker.js";
import { ConfigService } from "../src/services/config-service.js";
import { FileWatcher } from "../src/services/file-watcher.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
import { ProjectRegistry } from "../src/services/project-registry.js";
import { RepositoryEventBus } from "../src/services/repository-event-bus.js";
import { RepositoryIdentity } from "../src/services/repository-identity.js";
import { RepositoryWatchCoordinator } from "../src/services/repository-watch-coordinator.js";
import { WorkspaceProvider } from "../src/services/workspace-provider.js";
import { WorktreeDetector } from "../src/services/worktree-detector.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";
import { git, initRepo } from "./helpers/git-helpers.js";
import { TestLaborerStore } from "./helpers/test-store.js";

const tempRoots: string[] = [];

const TestLayer = WorkspaceProvider.layer.pipe(
	Layer.provideMerge(ProjectRegistry.layer),
	Layer.provideMerge(RepositoryWatchCoordinator.layer),
	Layer.provideMerge(BranchStateTracker.layer),
	Layer.provideMerge(RepositoryEventBus.layer),
	Layer.provideMerge(FileWatcher.layer),
	Layer.provideMerge(WorktreeReconciler.layer),
	Layer.provideMerge(WorktreeDetector.layer),
	Layer.provideMerge(RepositoryIdentity.layer),
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

beforeAll(() => {
	ensureBunSpawnForNodeTests();
});

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("WorkspaceProvider.destroyWorktree origin behavior", () => {
	it.scoped("keeps git worktree and branch for external workspaces", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("destroy-external", tempRoots);
			const branchName = "feature/external";
			const worktreePath = join(repoPath, ".worktrees", "external");
			git(`worktree add -b ${branchName} ${worktreePath}`, repoPath);

			const projectId = crypto.randomUUID();
			const workspaceId = crypto.randomUUID();

			const allocator = yield* PortAllocator;
			const allocatedPort = yield* allocator.allocate();

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

			assert.isTrue(existsSync(worktreePath));
			assert.include(git(`branch --list ${branchName}`, repoPath), branchName);

			const workspaceRows = store.query(
				tables.workspaces.where("id", workspaceId)
			);
			assert.strictEqual(workspaceRows.length, 0);

			const reallocatedPort = yield* allocator.allocate();
			assert.strictEqual(reallocatedPort, allocatedPort);
		}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("removes git worktree and branch for laborer workspaces", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("destroy-laborer", tempRoots);
			const branchName = "feature/laborer";
			const worktreePath = join(repoPath, ".worktrees", "laborer");
			git(`worktree add -b ${branchName} ${worktreePath}`, repoPath);

			const projectId = crypto.randomUUID();
			const workspaceId = crypto.randomUUID();

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

			assert.isFalse(existsSync(worktreePath));
			assert.strictEqual(git(`branch --list ${branchName}`, repoPath), "");

			const workspaceRows = store.query(
				tables.workspaces.where("id", workspaceId)
			);
			assert.strictEqual(workspaceRows.length, 0);
		}).pipe(Effect.provide(TestLayer))
	);
});
