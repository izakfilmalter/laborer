import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { events, tables } from "@laborer/shared/schema";
import { Effect, Layer } from "effect";
import { afterAll } from "vitest";
import { BranchStateTracker } from "../src/services/branch-state-tracker.js";
import { FileWatcher } from "../src/services/file-watcher.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
import { RepositoryEventBus } from "../src/services/repository-event-bus.js";
import { RepositoryIdentity } from "../src/services/repository-identity.js";
import { RepositoryWatchCoordinator } from "../src/services/repository-watch-coordinator.js";
import { WorktreeDetector } from "../src/services/worktree-detector.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";
import { git, initRepo } from "./helpers/git-helpers.js";
import { TestLaborerStore } from "./helpers/test-store.js";
import { waitFor } from "./helpers/timing-helpers.js";

const tempRoots: string[] = [];

const TestLayer = BranchStateTracker.layer.pipe(
	Layer.provideMerge(TestLaborerStore)
);

const CoordinatorTestLayer = RepositoryWatchCoordinator.layer.pipe(
	Layer.provide(BranchStateTracker.layer),
	Layer.provide(RepositoryEventBus.layer),
	Layer.provide(FileWatcher.layer),
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
	Layer.provide(RepositoryIdentity.layer),
	Layer.provide(PortAllocator.make(4600, 4620)),
	Layer.provideMerge(TestLaborerStore)
);

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("BranchStateTracker", () => {
	it.scoped("refreshes branch name when workspace branch is stale", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("branch-refresh-stale", tempRoots);
			const worktreePath = join(repoPath, ".worktrees", "branch-stale");
			git(`worktree add -b feature/stale ${worktreePath}`, repoPath);

			const projectId = crypto.randomUUID();
			const workspaceId = crypto.randomUUID();

			const { store } = yield* LaborerStore;
			store.commit(
				events.projectCreated({
					id: projectId,
					repoPath,
					name: "branch-refresh-stale",
					rlphConfig: null,
				})
			);
			store.commit(
				events.workspaceCreated({
					id: workspaceId,
					projectId,
					taskSource: null,
					branchName: "feature/stale",
					worktreePath,
					port: 0,
					status: "stopped",
					origin: "external",
					createdAt: new Date().toISOString(),
					baseSha: null,
				})
			);

			// Switch the worktree to a different branch
			git("checkout -b feature/updated", worktreePath);

			const tracker = yield* BranchStateTracker;
			const result = yield* tracker.refreshBranches(projectId);

			assert.strictEqual(result.checked, 1);
			assert.strictEqual(result.updated, 1);

			const workspace = store.query(tables.workspaces.where("id", workspaceId));
			assert.strictEqual(workspace[0]?.branchName, "feature/updated");
		}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("does not update when branch name is already current", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("branch-refresh-current", tempRoots);
			const worktreePath = join(repoPath, ".worktrees", "branch-current");
			git(`worktree add -b feature/current ${worktreePath}`, repoPath);

			const projectId = crypto.randomUUID();
			const workspaceId = crypto.randomUUID();

			const { store } = yield* LaborerStore;
			store.commit(
				events.projectCreated({
					id: projectId,
					repoPath,
					name: "branch-refresh-current",
					rlphConfig: null,
				})
			);
			store.commit(
				events.workspaceCreated({
					id: workspaceId,
					projectId,
					taskSource: null,
					branchName: "feature/current",
					worktreePath,
					port: 0,
					status: "stopped",
					origin: "external",
					createdAt: new Date().toISOString(),
					baseSha: null,
				})
			);

			const tracker = yield* BranchStateTracker;
			const result = yield* tracker.refreshBranches(projectId);

			assert.strictEqual(result.checked, 1);
			assert.strictEqual(result.updated, 0);

			const workspace = store.query(tables.workspaces.where("id", workspaceId));
			assert.strictEqual(workspace[0]?.branchName, "feature/current");
		}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("refreshes multiple workspaces in one pass", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("branch-refresh-multi", tempRoots);
			const worktreeA = join(repoPath, ".worktrees", "branch-multi-a");
			const worktreeB = join(repoPath, ".worktrees", "branch-multi-b");
			git(`worktree add -b feature/multi-a ${worktreeA}`, repoPath);
			git(`worktree add -b feature/multi-b ${worktreeB}`, repoPath);

			const projectId = crypto.randomUUID();
			const wsIdA = crypto.randomUUID();
			const wsIdB = crypto.randomUUID();

			const { store } = yield* LaborerStore;
			store.commit(
				events.projectCreated({
					id: projectId,
					repoPath,
					name: "branch-refresh-multi",
					rlphConfig: null,
				})
			);
			store.commit(
				events.workspaceCreated({
					id: wsIdA,
					projectId,
					taskSource: null,
					branchName: "feature/multi-a",
					worktreePath: worktreeA,
					port: 0,
					status: "stopped",
					origin: "external",
					createdAt: new Date().toISOString(),
					baseSha: null,
				})
			);
			store.commit(
				events.workspaceCreated({
					id: wsIdB,
					projectId,
					taskSource: null,
					branchName: "feature/multi-b",
					worktreePath: worktreeB,
					port: 0,
					status: "stopped",
					origin: "external",
					createdAt: new Date().toISOString(),
					baseSha: null,
				})
			);

			// Switch both worktrees to new branches
			git("checkout -b feature/multi-a-new", worktreeA);
			git("checkout -b feature/multi-b-new", worktreeB);

			const tracker = yield* BranchStateTracker;
			const result = yield* tracker.refreshBranches(projectId);

			assert.strictEqual(result.checked, 2);
			assert.strictEqual(result.updated, 2);

			const wsA = store.query(tables.workspaces.where("id", wsIdA));
			const wsB = store.query(tables.workspaces.where("id", wsIdB));
			assert.strictEqual(wsA[0]?.branchName, "feature/multi-a-new");
			assert.strictEqual(wsB[0]?.branchName, "feature/multi-b-new");
		}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("skips destroyed workspaces during branch refresh", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("branch-refresh-destroyed", tempRoots);

			const projectId = crypto.randomUUID();
			const workspaceId = crypto.randomUUID();

			const { store } = yield* LaborerStore;
			store.commit(
				events.projectCreated({
					id: projectId,
					repoPath,
					name: "branch-refresh-destroyed",
					rlphConfig: null,
				})
			);
			store.commit(
				events.workspaceCreated({
					id: workspaceId,
					projectId,
					taskSource: null,
					branchName: "main",
					worktreePath: repoPath,
					port: 0,
					status: "stopped",
					origin: "external",
					createdAt: new Date().toISOString(),
					baseSha: null,
				})
			);
			store.commit(
				events.workspaceStatusChanged({
					id: workspaceId,
					status: "destroyed",
				})
			);

			const tracker = yield* BranchStateTracker;
			const result = yield* tracker.refreshBranches(projectId);

			assert.strictEqual(result.checked, 0);
			assert.strictEqual(result.updated, 0);
		}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("detects detached HEAD state during branch refresh", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("branch-refresh-detached", tempRoots);
			const worktreePath = join(repoPath, ".worktrees", "branch-detached");
			git(`worktree add -b feature/detach ${worktreePath}`, repoPath);

			const projectId = crypto.randomUUID();
			const workspaceId = crypto.randomUUID();

			const { store } = yield* LaborerStore;
			store.commit(
				events.projectCreated({
					id: projectId,
					repoPath,
					name: "branch-refresh-detached",
					rlphConfig: null,
				})
			);
			store.commit(
				events.workspaceCreated({
					id: workspaceId,
					projectId,
					taskSource: null,
					branchName: "feature/detach",
					worktreePath,
					port: 0,
					status: "stopped",
					origin: "external",
					createdAt: new Date().toISOString(),
					baseSha: null,
				})
			);

			// Detach HEAD in the worktree
			const headSha = git("rev-parse HEAD", worktreePath);
			git(`checkout ${headSha}`, worktreePath);

			const tracker = yield* BranchStateTracker;
			const result = yield* tracker.refreshBranches(projectId);

			assert.strictEqual(result.updated, 1);

			const workspace = store.query(tables.workspaces.where("id", workspaceId));
			assert.isTrue(workspace[0]?.branchName.startsWith("detached/"));
		}).pipe(Effect.provide(TestLayer))
	);
});

describe("RepositoryWatchCoordinator branch refresh integration", () => {
	it.scoped(
		"branch switch on main worktree triggers branch refresh through the coordinator",
		() =>
			Effect.gen(function* () {
				// Use a repo without linked worktrees so the coordinator
				// watches .git/ directly (where HEAD lives). A branch switch
				// on the main worktree modifies .git/HEAD which fs.watch sees.
				const repoPath = initRepo("coord-branch-refresh", tempRoots);

				const { store } = yield* LaborerStore;
				const projectId = "project-coord-branch";
				store.commit(
					events.projectCreated({
						id: projectId,
						repoPath,
						name: "coord-branch-refresh",
						rlphConfig: null,
					})
				);

				const coordinator = yield* RepositoryWatchCoordinator;
				yield* coordinator.watchAll();

				// Wait for initial reconciliation to create workspace record
				yield* Effect.promise(() =>
					waitFor(() =>
						Promise.resolve(
							store.query(tables.workspaces.where("projectId", projectId))
								.length >= 1
						)
					)
				);

				// Verify the initial branch name
				const initialWorkspaces = store.query(
					tables.workspaces.where("projectId", projectId)
				) as readonly { readonly branchName: string }[];
				const initialBranch = initialWorkspaces[0]?.branchName;

				// Switch branch on the main worktree (modifies .git/HEAD)
				git("checkout -b feature/coord-branch-updated", repoPath);

				// Wait for the branch name to be refreshed
				yield* Effect.promise(() =>
					waitFor(() => {
						const workspaces = store.query(
							tables.workspaces.where("projectId", projectId)
						) as readonly { readonly branchName: string }[];
						return Promise.resolve(
							workspaces.some(
								(w) => w.branchName === "feature/coord-branch-updated"
							)
						);
					})
				);

				const workspaces = store.query(
					tables.workspaces.where("projectId", projectId)
				) as readonly { readonly branchName: string }[];
				const updatedWorkspace = workspaces.find(
					(w) => w.branchName === "feature/coord-branch-updated"
				);
				assert.isDefined(updatedWorkspace);
				assert.notStrictEqual(
					initialBranch,
					"feature/coord-branch-updated",
					"Branch should have been different initially"
				);
			}).pipe(Effect.provide(CoordinatorTestLayer))
	);

	it.scoped(
		"worktree metadata changes trigger both reconciliation and branch refresh",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("coord-both-triggers", tempRoots);

				const { store } = yield* LaborerStore;
				const projectId = "project-coord-both";
				store.commit(
					events.projectCreated({
						id: projectId,
						repoPath,
						name: "coord-both-triggers",
						rlphConfig: null,
					})
				);

				const coordinator = yield* RepositoryWatchCoordinator;
				yield* coordinator.watchAll();

				// Wait for initial reconciliation (main worktree only)
				yield* Effect.promise(() =>
					waitFor(() =>
						Promise.resolve(
							store.query(tables.workspaces.where("projectId", projectId))
								.length >= 1
						)
					)
				);

				// Add a worktree — this creates .git/worktrees/<name>
				// which should trigger both reconciliation AND branch refresh
				const worktreePath = join(
					repoPath,
					".worktrees",
					"coord-both-triggers"
				);
				git(`worktree add -b feature/both-triggers ${worktreePath}`, repoPath);

				// Wait for the new worktree to appear as a workspace
				yield* Effect.promise(() =>
					waitFor(() =>
						Promise.resolve(
							store.query(tables.workspaces.where("projectId", projectId))
								.length >= 2
						)
					)
				);

				const workspaces = store.query(
					tables.workspaces.where("projectId", projectId)
				) as readonly { readonly branchName: string }[];
				const newWorkspace = workspaces.find(
					(w) => w.branchName === "feature/both-triggers"
				);
				assert.isDefined(
					newWorkspace,
					"New worktree should be detected with correct branch name"
				);
			}).pipe(Effect.provide(CoordinatorTestLayer))
	);
});
