import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { events, tables } from "@laborer/shared/schema";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll } from "vitest";
import { BranchStateTracker } from "../src/services/branch-state-tracker.js";
import { FileWatcher } from "../src/services/file-watcher.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
import { ProjectRegistry } from "../src/services/project-registry.js";
import { RepositoryEventBus } from "../src/services/repository-event-bus.js";
import { RepositoryIdentity } from "../src/services/repository-identity.js";
import { RepositoryWatchCoordinator } from "../src/services/repository-watch-coordinator.js";
import { WorktreeDetector } from "../src/services/worktree-detector.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";
import { git, initRepo } from "./helpers/git-helpers.js";
import { TestLaborerStore } from "./helpers/test-store.js";
import { delay, waitFor } from "./helpers/timing-helpers.js";

const tempRoots: string[] = [];

/**
 * Full service stack matching production layer composition.
 * ProjectRegistry sits at the top, consuming all repo-watching services.
 */
const TestLayer = ProjectRegistry.layer.pipe(
	Layer.provide(RepositoryWatchCoordinator.layer),
	Layer.provide(BranchStateTracker.layer),
	Layer.provideMerge(RepositoryEventBus.layer),
	Layer.provide(FileWatcher.layer),
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
	Layer.provide(RepositoryIdentity.layer),
	Layer.provide(PortAllocator.make(4700, 4750)),
	Layer.provideMerge(TestLaborerStore)
);

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("Startup bootstrap and project lifecycle integration", () => {
	it.scoped(
		"project add performs canonical discovery and initial refresh before returning ready state",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("boot-add-ready", tempRoots);
				const worktreePath = join(repoPath, ".worktrees", "boot-feature");
				git(`worktree add -b feature/boot-test ${worktreePath}`, repoPath);

				const registry = yield* ProjectRegistry;
				const project = yield* registry.addProject(repoPath);

				const { store } = yield* LaborerStore;

				// After addProject returns, workspace records should already
				// exist with correct branch names — no waiting needed.
				const workspaces = store.query(
					tables.workspaces.where("projectId", project.id)
				) as readonly {
					readonly branchName: string;
					readonly worktreePath: string;
				}[];

				// Both the main worktree and the linked worktree should be present
				assert.strictEqual(
					workspaces.length,
					2,
					"Both worktrees should be reconciled before project is ready"
				);

				// Branch names should already be populated from initial refresh
				const branchNames = workspaces.map((w) => w.branchName).sort();
				assert.isTrue(
					branchNames.includes("feature/boot-test"),
					"Linked worktree branch should be set"
				);
				assert.isTrue(
					branchNames.some((b) => b === "main" || b === "master"),
					"Main worktree branch should be set"
				);
			}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("project add starts the repository watcher coordinator", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("boot-add-watcher", tempRoots);

			const registry = yield* ProjectRegistry;
			const project = yield* registry.addProject(repoPath);

			const { store } = yield* LaborerStore;

			// After addProject, the watcher should be running. Creating a
			// worktree should be detected automatically via the coordinator.
			const worktreePath = join(repoPath, ".worktrees", "boot-watcher");
			git(`worktree add -b feature/boot-watcher ${worktreePath}`, repoPath);

			yield* Effect.promise(() =>
				waitFor(() =>
					Promise.resolve(
						store.query(tables.workspaces.where("projectId", project.id))
							.length === 2
					)
				)
			);

			const workspaces = store.query(
				tables.workspaces.where("projectId", project.id)
			);
			assert.strictEqual(
				workspaces.length,
				2,
				"Watcher should detect new worktree after addProject"
			);
		}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("server boot restores watchers for all persisted projects", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("boot-restore", tempRoots);

			// Simulate a prior server session: seed a project directly
			// into the store before building the coordinator layer.
			const { store } = yield* LaborerStore;
			const projectId = "project-boot-restore";
			store.commit(
				events.projectCreated({
					id: projectId,
					repoPath,
					name: "boot-restore",
					rlphConfig: null,
				})
			);

			// Build the coordinator layer (which calls watchAll at startup)
			const CoordinatorLayer = RepositoryWatchCoordinator.layer.pipe(
				Layer.provide(BranchStateTracker.layer),
				Layer.provide(RepositoryEventBus.layer),
				Layer.provide(FileWatcher.layer),
				Layer.provide(WorktreeReconciler.layer),
				Layer.provide(WorktreeDetector.layer),
				Layer.provide(RepositoryIdentity.layer),
				Layer.provide(PortAllocator.make(4751, 4760))
			);

			// Use a manual scope to simulate server lifecycle
			const scope = yield* Scope.make();

			const storeLayer = Layer.succeed(
				LaborerStore,
				LaborerStore.of({ store })
			);

			const fullLayer = CoordinatorLayer.pipe(Layer.provide(storeLayer));

			yield* Layer.buildWithScope(fullLayer, scope);

			// After layer construction, watchAll has run: reconciliation
			// should have created a workspace for the main checkout
			const workspaces = store.query(
				tables.workspaces.where("projectId", projectId)
			);
			assert.isAbove(
				workspaces.length,
				0,
				"Startup should reconcile worktrees for persisted projects"
			);

			// The watcher should be running — adding a worktree should
			// be detected automatically
			const worktreePath = join(repoPath, ".worktrees", "boot-restore-wt");
			git(`worktree add -b feature/boot-restore ${worktreePath}`, repoPath);

			yield* Effect.promise(() =>
				waitFor(() =>
					Promise.resolve(
						store.query(tables.workspaces.where("projectId", projectId))
							.length === 2
					)
				)
			);

			yield* Scope.close(scope, Exit.succeed(undefined));
		}).pipe(Effect.provide(TestLaborerStore))
	);

	it.scoped(
		"server boot reconciles worktree and branch state that changed while offline",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("boot-offline", tempRoots);
				const worktreePath = join(repoPath, ".worktrees", "boot-offline-wt");

				// Simulate prior server session state: project and one workspace
				const { store } = yield* LaborerStore;
				const projectId = "project-boot-offline";
				const workspaceId = crypto.randomUUID();

				store.commit(
					events.projectCreated({
						id: projectId,
						repoPath,
						name: "boot-offline",
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

				// Simulate offline changes:
				// 1. Switch branch on main worktree
				git("checkout -b feature/offline-change", repoPath);
				// 2. Add a new worktree
				git(`worktree add -b feature/offline-wt ${worktreePath}`, repoPath);

				// Build coordinator layer — startup watchAll should reconcile
				const CoordinatorLayer = RepositoryWatchCoordinator.layer.pipe(
					Layer.provide(BranchStateTracker.layer),
					Layer.provide(RepositoryEventBus.layer),
					Layer.provide(FileWatcher.layer),
					Layer.provide(WorktreeReconciler.layer),
					Layer.provide(WorktreeDetector.layer),
					Layer.provide(RepositoryIdentity.layer),
					Layer.provide(PortAllocator.make(4761, 4770))
				);

				const scope = yield* Scope.make();

				const storeLayer = Layer.succeed(
					LaborerStore,
					LaborerStore.of({ store })
				);

				const fullLayer = CoordinatorLayer.pipe(Layer.provide(storeLayer));

				yield* Layer.buildWithScope(fullLayer, scope);

				// After startup, the offline worktree addition should be reconciled
				const workspaces = store.query(
					tables.workspaces.where("projectId", projectId)
				);
				assert.strictEqual(
					workspaces.length,
					2,
					"Startup should detect worktree added while offline"
				);

				// The branch change on main should be reconciled
				const mainWorkspace = store.query(
					tables.workspaces.where("id", workspaceId)
				) as readonly { readonly branchName: string }[];
				assert.strictEqual(
					mainWorkspace[0]?.branchName,
					"feature/offline-change",
					"Startup should refresh stale branch names from offline changes"
				);

				yield* Scope.close(scope, Exit.succeed(undefined));
			}).pipe(Effect.provide(TestLaborerStore))
	);

	it.scoped(
		"project add through public API returns ready state with all refreshes complete",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("boot-api-ready", tempRoots);

				// Create worktrees before registering the project
				const worktreeA = join(repoPath, ".worktrees", "boot-api-a");
				const worktreeB = join(repoPath, ".worktrees", "boot-api-b");
				git(`worktree add -b feature/api-a ${worktreeA}`, repoPath);
				git(`worktree add -b feature/api-b ${worktreeB}`, repoPath);

				// Switch a worktree to a different branch after creation
				git("checkout -b feature/api-a-switched", worktreeA);

				const registry = yield* ProjectRegistry;
				const project = yield* registry.addProject(repoPath);

				const { store } = yield* LaborerStore;

				// All three worktrees should be present immediately after add
				const workspaces = store.query(
					tables.workspaces.where("projectId", project.id)
				) as readonly {
					readonly branchName: string;
					readonly worktreePath: string;
				}[];

				assert.strictEqual(
					workspaces.length,
					3,
					"All three worktrees should be detected"
				);

				// Branch names should reflect actual git state, including the
				// branch that was switched after worktree creation
				const branchNames = workspaces.map((w) => w.branchName);
				assert.isTrue(
					branchNames.includes("feature/api-a-switched"),
					"Switched branch should be detected by initial refresh"
				);
				assert.isTrue(
					branchNames.includes("feature/api-b"),
					"Worktree B branch should be correct"
				);
			}).pipe(Effect.provide(TestLayer))
	);

	it.scoped(
		"public repo-watching stack stays consistent across branch refresh and worktree churn",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("boot-public-e2e", tempRoots);
				const canonicalRepoPath = realpathSync(repoPath);
				const linkedA = join(repoPath, ".worktrees", "boot-public-a");
				const linkedB = join(repoPath, ".worktrees", "boot-public-b");

				const registry = yield* ProjectRegistry;
				const { store } = yield* LaborerStore;

				const project = yield* registry.addProject(repoPath);
				yield* Effect.promise(() => delay(200));

				writeFileSync(
					join(repoPath, "README.md"),
					"# public repo-watching e2e\n"
				);

				git(`worktree add -b feature/public-a ${linkedA}`, repoPath);
				git(`worktree add -b feature/public-b ${linkedB}`, repoPath);
				git(`worktree remove --force ${linkedA}`, repoPath);

				yield* Effect.promise(() =>
					waitFor(() => {
						const workspaces = store.query(
							tables.workspaces.where("projectId", project.id)
						) as readonly {
							readonly branchName: string;
							readonly worktreePath: string;
						}[];

						const worktreePaths = workspaces.map(
							(workspace) => workspace.worktreePath
						);
						return Promise.resolve(
							workspaces.length === 2 &&
								new Set(worktreePaths).size === 2 &&
								workspaces.some(
									(workspace) => workspace.branchName === "feature/public-b"
								)
						);
					})
				);
				yield* Effect.promise(() => delay(700));

				git("checkout -b feature/public-main-refresh", repoPath);

				yield* Effect.promise(() =>
					waitFor(() => {
						const workspaces = store.query(
							tables.workspaces.where("projectId", project.id)
						) as readonly {
							readonly branchName: string;
							readonly worktreePath: string;
						}[];

						return Promise.resolve(
							workspaces.some(
								(workspace) =>
									workspace.worktreePath === canonicalRepoPath &&
									workspace.branchName === "feature/public-main-refresh"
							)
						);
					})
				);
			}).pipe(Effect.provide(TestLayer))
	);
});
