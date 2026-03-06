import {
	existsSync,
	mkdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterAll } from "vitest";
import { BranchStateTracker } from "../src/services/branch-state-tracker.js";
import {
	FileWatcher,
	type WatchEvent,
	type WatchSubscription,
} from "../src/services/file-watcher.js";
import {
	DEFAULT_IGNORED_PREFIXES,
	RepositoryEventBus,
	type RepositoryFileEvent,
	shouldIgnore,
} from "../src/services/repository-event-bus.js";
import { RepositoryIdentity } from "../src/services/repository-identity.js";
import { RepositoryWatchCoordinator } from "../src/services/repository-watch-coordinator.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";
import { initRepo } from "./helpers/git-helpers.js";
import { TestLaborerStore } from "./helpers/test-store.js";
import { waitFor } from "./helpers/timing-helpers.js";

const tempRoots: string[] = [];

/**
 * Standalone event bus layer — no watcher coordinator, just the bus
 * for unit-level tests of subscribe/publish/normalize behavior.
 */
const EventBusTestLayer = RepositoryEventBus.layer;

type RecordedWatchersByPath = Map<
	string,
	{ readonly onChange: (event: WatchEvent) => void }[]
>;

const createDeterministicIntegrationLayer = (
	repoPath: string,
	recordedWatchers: RecordedWatchersByPath
) => {
	const recordingFileWatcher = Layer.succeed(
		FileWatcher,
		FileWatcher.of({
			subscribe: (path, onChange, _onError, _options) =>
				Effect.sync(() => {
					const existing = recordedWatchers.get(path) ?? [];
					existing.push({ onChange });
					recordedWatchers.set(path, existing);
					return {
						close: () => undefined,
					} satisfies WatchSubscription;
				}),
		})
	);

	return RepositoryWatchCoordinator.layer.pipe(
		Layer.provide(
			Layer.succeed(
				BranchStateTracker,
				BranchStateTracker.of({
					refreshBranches: () => Effect.succeed({ checked: 0, updated: 0 }),
				})
			)
		),
		Layer.provideMerge(RepositoryEventBus.layer),
		Layer.provide(recordingFileWatcher),
		Layer.provide(
			Layer.succeed(
				WorktreeReconciler,
				WorktreeReconciler.of({
					reconcile: () =>
						Effect.succeed({ added: 0, removed: 0, unchanged: 0 }),
				})
			)
		),
		Layer.provide(
			Layer.succeed(
				RepositoryIdentity,
				RepositoryIdentity.of({
					resolve: () =>
						Effect.succeed({
							canonicalRoot: repoPath,
							canonicalGitCommonDir: join(repoPath, ".git"),
							repoId: `${repoPath}-repo`,
							isMainWorktree: true,
						}),
				})
			)
		),
		Layer.provideMerge(TestLaborerStore)
	);
};

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

// ── Unit tests: shouldIgnore ──────────────────────────────────

describe("shouldIgnore", () => {
	it.effect("ignores .git paths", () =>
		Effect.sync(() => {
			assert.isTrue(shouldIgnore(".git", DEFAULT_IGNORED_PREFIXES));
			assert.isTrue(
				shouldIgnore(".git/objects/pack", DEFAULT_IGNORED_PREFIXES)
			);
		})
	);

	it.effect("ignores node_modules paths", () =>
		Effect.sync(() => {
			assert.isTrue(shouldIgnore("node_modules", DEFAULT_IGNORED_PREFIXES));
			assert.isTrue(
				shouldIgnore("node_modules/lodash/index.js", DEFAULT_IGNORED_PREFIXES)
			);
		})
	);

	it.effect("ignores dist, build, and out paths", () =>
		Effect.sync(() => {
			assert.isTrue(shouldIgnore("dist", DEFAULT_IGNORED_PREFIXES));
			assert.isTrue(shouldIgnore("build", DEFAULT_IGNORED_PREFIXES));
			assert.isTrue(shouldIgnore("out", DEFAULT_IGNORED_PREFIXES));
			assert.isTrue(shouldIgnore("dist/bundle.js", DEFAULT_IGNORED_PREFIXES));
		})
	);

	it.effect("ignores framework-specific output directories", () =>
		Effect.sync(() => {
			assert.isTrue(shouldIgnore(".next", DEFAULT_IGNORED_PREFIXES));
			assert.isTrue(shouldIgnore(".nuxt", DEFAULT_IGNORED_PREFIXES));
			assert.isTrue(shouldIgnore(".svelte-kit", DEFAULT_IGNORED_PREFIXES));
			assert.isTrue(shouldIgnore(".turbo", DEFAULT_IGNORED_PREFIXES));
		})
	);

	it.effect("ignores IDE and OS metadata", () =>
		Effect.sync(() => {
			assert.isTrue(shouldIgnore(".idea", DEFAULT_IGNORED_PREFIXES));
			assert.isTrue(shouldIgnore(".vscode", DEFAULT_IGNORED_PREFIXES));
			assert.isTrue(shouldIgnore(".DS_Store", DEFAULT_IGNORED_PREFIXES));
		})
	);

	it.effect("does not ignore source files", () =>
		Effect.sync(() => {
			assert.isFalse(shouldIgnore("src/index.ts", DEFAULT_IGNORED_PREFIXES));
			assert.isFalse(
				shouldIgnore("packages/server/main.ts", DEFAULT_IGNORED_PREFIXES)
			);
			assert.isFalse(shouldIgnore("README.md", DEFAULT_IGNORED_PREFIXES));
		})
	);

	it.effect("ignores empty paths", () =>
		Effect.sync(() => {
			assert.isTrue(shouldIgnore("", DEFAULT_IGNORED_PREFIXES));
		})
	);
});

// ── Unit tests: RepositoryEventBus ──────────────────────────

describe("RepositoryEventBus", () => {
	it.effect("subscribers receive published events", () =>
		Effect.gen(function* () {
			const bus = yield* RepositoryEventBus;
			const received: RepositoryFileEvent[] = [];

			yield* bus.subscribe((event) => {
				received.push(event);
			});

			const testEvent: RepositoryFileEvent = {
				type: "add",
				relativePath: "src/index.ts",
				absolutePath: "/repo/src/index.ts",
				projectId: "test-project",
				repoRoot: "/repo",
			};

			yield* bus.publish(testEvent);

			assert.strictEqual(received.length, 1);
			assert.deepStrictEqual(received[0], testEvent);
		}).pipe(Effect.provide(EventBusTestLayer))
	);

	it.effect("multiple subscribers receive the same event", () =>
		Effect.gen(function* () {
			const bus = yield* RepositoryEventBus;
			const receivedA: RepositoryFileEvent[] = [];
			const receivedB: RepositoryFileEvent[] = [];

			yield* bus.subscribe((event) => {
				receivedA.push(event);
			});
			yield* bus.subscribe((event) => {
				receivedB.push(event);
			});

			const testEvent: RepositoryFileEvent = {
				type: "change",
				relativePath: "lib/utils.ts",
				absolutePath: "/repo/lib/utils.ts",
				projectId: "test-project",
				repoRoot: "/repo",
			};

			yield* bus.publish(testEvent);

			assert.strictEqual(receivedA.length, 1);
			assert.strictEqual(receivedB.length, 1);
			assert.deepStrictEqual(receivedA[0], testEvent);
			assert.deepStrictEqual(receivedB[0], testEvent);
		}).pipe(Effect.provide(EventBusTestLayer))
	);

	it.effect("unsubscribe removes the handler", () =>
		Effect.gen(function* () {
			const bus = yield* RepositoryEventBus;
			const received: RepositoryFileEvent[] = [];

			const sub = yield* bus.subscribe((event) => {
				received.push(event);
			});

			const event1: RepositoryFileEvent = {
				type: "add",
				relativePath: "a.ts",
				absolutePath: "/repo/a.ts",
				projectId: "test-project",
				repoRoot: "/repo",
			};

			yield* bus.publish(event1);
			assert.strictEqual(received.length, 1);

			sub.unsubscribe();

			const event2: RepositoryFileEvent = {
				type: "change",
				relativePath: "b.ts",
				absolutePath: "/repo/b.ts",
				projectId: "test-project",
				repoRoot: "/repo",
			};

			yield* bus.publish(event2);
			assert.strictEqual(
				received.length,
				1,
				"Should not receive events after unsubscribe"
			);
		}).pipe(Effect.provide(EventBusTestLayer))
	);

	it.effect("normalizeEvent returns null for null fileName", () =>
		Effect.gen(function* () {
			const bus = yield* RepositoryEventBus;

			const result = bus.normalizeEvent({
				type: "change",
				fileName: null,
				repoRoot: "/repo",
				projectId: "test-project",
			});

			assert.isNull(result);
		}).pipe(Effect.provide(EventBusTestLayer))
	);

	it.effect("normalizeEvent suppresses ignored paths", () =>
		Effect.gen(function* () {
			const bus = yield* RepositoryEventBus;

			const gitResult = bus.normalizeEvent({
				type: "change",
				fileName: ".git/objects/pack/abc123",
				repoRoot: "/repo",
				projectId: "test-project",
			});
			assert.isNull(gitResult);

			const nodeModulesResult = bus.normalizeEvent({
				type: "add",
				fileName: "node_modules/lodash/index.js",
				repoRoot: "/repo",
				projectId: "test-project",
			});
			assert.isNull(nodeModulesResult);

			const distResult = bus.normalizeEvent({
				type: "change",
				fileName: "dist/bundle.js",
				repoRoot: "/repo",
				projectId: "test-project",
			});
			assert.isNull(distResult);
		}).pipe(Effect.provide(EventBusTestLayer))
	);

	it.effect("normalizeEvent returns event for source files", () =>
		Effect.gen(function* () {
			const bus = yield* RepositoryEventBus;

			const result = bus.normalizeEvent({
				type: "change",
				fileName: "src/index.ts",
				repoRoot: "/repo",
				projectId: "test-project",
			});

			assert.isNotNull(result);
			assert.strictEqual(result?.type, "change");
			assert.strictEqual(result?.relativePath, "src/index.ts");
			assert.strictEqual(result?.projectId, "test-project");
			assert.strictEqual(result?.repoRoot, "/repo");
		}).pipe(Effect.provide(EventBusTestLayer))
	);
});

// ── Integration tests: watcher → event bus pipeline ─────────

describe("RepositoryEventBus watcher integration", () => {
	it.scoped(
		"file add in watched repo emits normalized event through the event bus",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("eventbus-add-1", tempRoots);
				const recordedWatchers: RecordedWatchersByPath = new Map();
				const addEventTestLayer = createDeterministicIntegrationLayer(
					repoPath,
					recordedWatchers
				);

				yield* Effect.gen(function* () {
					const coordinator = yield* RepositoryWatchCoordinator;
					const bus = yield* RepositoryEventBus;

					const received: RepositoryFileEvent[] = [];
					yield* bus.subscribe((event) => {
						received.push(event);
					});

					yield* coordinator.watchProject("project-eventbus-add", repoPath);

					// Create a new source file in the repo, then deterministically
					// deliver the watcher signal through the coordinator.
					writeFileSync(join(repoPath, "new-file.ts"), "export const x = 1;\n");
					recordedWatchers
						.get(repoPath)
						?.at(-1)
						?.onChange({ type: "rename", fileName: "new-file.ts" });

					yield* Effect.promise(() =>
						waitFor(() =>
							Promise.resolve(
								received.some((e) => e.relativePath === "new-file.ts")
							)
						)
					);

					const addEvent = received.find(
						(e) => e.relativePath === "new-file.ts"
					);
					assert.isDefined(addEvent);
					assert.strictEqual(addEvent?.type, "add");
					assert.strictEqual(addEvent?.projectId, "project-eventbus-add");
				}).pipe(Effect.provide(addEventTestLayer));
			})
	);

	it.scoped(
		"file change in watched repo emits event through the event bus",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("eventbus-change-1", tempRoots);
				const recordedWatchers: RecordedWatchersByPath = new Map();
				const changeEventTestLayer = createDeterministicIntegrationLayer(
					repoPath,
					recordedWatchers
				);

				yield* Effect.gen(function* () {
					const coordinator = yield* RepositoryWatchCoordinator;
					const bus = yield* RepositoryEventBus;

					const received: RepositoryFileEvent[] = [];
					yield* bus.subscribe((event) => {
						received.push(event);
					});

					yield* coordinator.watchProject("project-eventbus-change", repoPath);
					writeFileSync(join(repoPath, "README.md"), "# updated content\n");
					recordedWatchers.get(repoPath)?.at(-1)?.onChange({
						type: "change",
						fileName: "README.md",
					});

					yield* Effect.promise(() =>
						waitFor(() =>
							Promise.resolve(
								received.some((e) => e.relativePath === "README.md")
							)
						)
					);

					const changeEvent = received.find(
						(e) => e.relativePath === "README.md"
					);
					assert.isDefined(changeEvent);
					assert.strictEqual(changeEvent?.type, "change");
					assert.strictEqual(changeEvent?.projectId, "project-eventbus-change");
				}).pipe(Effect.provide(changeEventTestLayer));
			})
	);

	it.scoped(
		"file delete in watched repo emits event through the event bus",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("eventbus-delete-1", tempRoots);
				const recordedWatchers: RecordedWatchersByPath = new Map();
				const deleteEventTestLayer = createDeterministicIntegrationLayer(
					repoPath,
					recordedWatchers
				);

				// Create a file first so we can delete it
				const filePath = join(repoPath, "to-delete.ts");
				writeFileSync(filePath, "export const x = 1;\n");

				yield* Effect.gen(function* () {
					const coordinator = yield* RepositoryWatchCoordinator;
					const bus = yield* RepositoryEventBus;

					const received: RepositoryFileEvent[] = [];
					yield* bus.subscribe((event) => {
						received.push(event);
					});

					yield* coordinator.watchProject("project-eventbus-delete", repoPath);
					unlinkSync(filePath);
					recordedWatchers
						.get(repoPath)
						?.at(-1)
						?.onChange({ type: "rename", fileName: "to-delete.ts" });

					yield* Effect.promise(() =>
						waitFor(() =>
							Promise.resolve(
								received.some((e) => e.relativePath === "to-delete.ts")
							)
						)
					);

					const deleteEvent = received.find(
						(e) => e.relativePath === "to-delete.ts"
					);
					assert.isDefined(deleteEvent);
					assert.strictEqual(deleteEvent?.type, "delete");
					assert.strictEqual(deleteEvent?.projectId, "project-eventbus-delete");
				}).pipe(Effect.provide(deleteEventTestLayer));
			})
	);

	it.scoped("ignored paths do not produce events through the event bus", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("eventbus-ignore-1", tempRoots);
			const recordedWatchers: RecordedWatchersByPath = new Map();
			const ignoredPathsTestLayer = createDeterministicIntegrationLayer(
				repoPath,
				recordedWatchers
			);

			// Create files in ignored directories
			const nodeModulesDir = join(repoPath, "node_modules");
			mkdirSync(nodeModulesDir, { recursive: true });
			writeFileSync(
				join(nodeModulesDir, "lodash.js"),
				"module.exports = {};\n"
			);

			const distDir = join(repoPath, "dist");
			mkdirSync(distDir, { recursive: true });
			writeFileSync(join(distDir, "bundle.js"), "// bundle\n");

			yield* Effect.gen(function* () {
				const coordinator = yield* RepositoryWatchCoordinator;
				const bus = yield* RepositoryEventBus;

				const received: RepositoryFileEvent[] = [];
				yield* bus.subscribe((event) => {
					received.push(event);
				});

				yield* coordinator.watchProject("project-eventbus-ignore", repoPath);

				// Also create a non-ignored file so we know the watcher is working.
				writeFileSync(
					join(repoPath, "canary-source.ts"),
					"export const canary = true;\n"
				);
				recordedWatchers.get(repoPath)?.at(-1)?.onChange({
					type: "rename",
					fileName: "node_modules/lodash.js",
				});
				recordedWatchers.get(repoPath)?.at(-1)?.onChange({
					type: "rename",
					fileName: "dist/bundle.js",
				});
				recordedWatchers.get(repoPath)?.at(-1)?.onChange({
					type: "rename",
					fileName: "canary-source.ts",
				});

				yield* Effect.promise(() =>
					waitFor(() =>
						Promise.resolve(
							received.some((e) => e.relativePath === "canary-source.ts")
						)
					)
				);

				const ignoredEvents = received.filter(
					(e) =>
						e.relativePath.startsWith("node_modules") ||
						e.relativePath.startsWith("dist") ||
						e.relativePath.startsWith(".git")
				);

				assert.strictEqual(
					ignoredEvents.length,
					0,
					`Expected no events from ignored paths, but received: ${ignoredEvents.map((e) => e.relativePath).join(", ")}`
				);
			}).pipe(Effect.provide(ignoredPathsTestLayer));
		})
	);

	it.scoped(
		"multiple subscribers receive events without creating duplicate watchers",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("eventbus-multi-sub-1", tempRoots);
				const recordedWatchers: RecordedWatchersByPath = new Map();
				const multiSubscriberTestLayer = createDeterministicIntegrationLayer(
					repoPath,
					recordedWatchers
				);

				yield* Effect.gen(function* () {
					const coordinator = yield* RepositoryWatchCoordinator;
					const bus = yield* RepositoryEventBus;

					const receivedA: RepositoryFileEvent[] = [];
					const receivedB: RepositoryFileEvent[] = [];

					yield* bus.subscribe((event) => {
						receivedA.push(event);
					});
					yield* bus.subscribe((event) => {
						receivedB.push(event);
					});

					yield* coordinator.watchProject("project-eventbus-multi", repoPath);
					writeFileSync(
						join(repoPath, "multi-sub-test.ts"),
						"export const y = 2;\n"
					);
					recordedWatchers.get(repoPath)?.at(-1)?.onChange({
						type: "rename",
						fileName: "multi-sub-test.ts",
					});

					yield* Effect.promise(() =>
						waitFor(() =>
							Promise.resolve(
								receivedA.some((e) => e.relativePath === "multi-sub-test.ts") &&
									receivedB.some((e) => e.relativePath === "multi-sub-test.ts")
							)
						)
					);

					const eventA = receivedA.find(
						(e) => e.relativePath === "multi-sub-test.ts"
					);
					const eventB = receivedB.find(
						(e) => e.relativePath === "multi-sub-test.ts"
					);

					assert.isDefined(eventA);
					assert.isDefined(eventB);
					assert.strictEqual(eventA?.projectId, eventB?.projectId);
				}).pipe(Effect.provide(multiSubscriberTestLayer));
			})
	);
});
