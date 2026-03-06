import { RpcTest } from "@effect/rpc";
import { LaborerRpcs } from "@laborer/shared/rpc";
import { Context, Effect, Layer, Ref } from "effect";
import { LaborerRpcsLive } from "../../src/rpc/handlers.js";
import { ConfigService } from "../../src/services/config-service.js";
import { DiffService } from "../../src/services/diff-service.js";
import { GithubTaskImporter } from "../../src/services/github-task-importer.js";
import { LaborerStore } from "../../src/services/laborer-store.js";
import { LinearTaskImporter } from "../../src/services/linear-task-importer.js";
import { PortAllocator } from "../../src/services/port-allocator.js";
import { PrdStorageService } from "../../src/services/prd-storage-service.js";
import { ProjectRegistry } from "../../src/services/project-registry.js";
import { RepositoryIdentity } from "../../src/services/repository-identity.js";
import { TaskManager } from "../../src/services/task-manager.js";
import { TerminalClient } from "../../src/services/terminal-client.js";
import { WorkspaceProvider } from "../../src/services/workspace-provider.js";
import { WorktreeDetector } from "../../src/services/worktree-detector.js";
import { WorktreeReconciler } from "../../src/services/worktree-reconciler.js";
import { WorktreeWatcher } from "../../src/services/worktree-watcher.js";
import { TestLaborerStore } from "../helpers/test-store.js";

class TestTerminalClientRecorder extends Context.Tag(
	"@laborer/test/TestTerminalClientRecorder"
)<
	TestTerminalClientRecorder,
	{
		readonly killAllForWorkspaceCalls: Ref.Ref<readonly string[]>;
		readonly spawnInWorkspaceCalls: Ref.Ref<
			readonly {
				readonly command: string | undefined;
				readonly workspaceId: string;
			}[]
		>;
	}
>() {}

const TestTerminalClientRecorderLayer = Layer.effect(
	TestTerminalClientRecorder,
	Effect.gen(function* () {
		return TestTerminalClientRecorder.of({
			killAllForWorkspaceCalls: yield* Ref.make<readonly string[]>([]),
			spawnInWorkspaceCalls: yield* Ref.make<
				readonly {
					readonly command: string | undefined;
					readonly workspaceId: string;
				}[]
			>([]),
		});
	})
);

const TestTerminalClient = Layer.effect(
	TerminalClient,
	Effect.gen(function* () {
		const recorder = yield* TestTerminalClientRecorder;

		return TerminalClient.of({
			spawnInWorkspace: (workspaceId, command) =>
				Effect.gen(function* () {
					yield* Ref.update(recorder.spawnInWorkspaceCalls, (calls) => [
						...calls,
						{ command, workspaceId },
					]);

					return {
						id: crypto.randomUUID(),
						workspaceId,
						command: command ?? "test-shell",
						status: "running" as const,
					};
				}),
			killAllForWorkspace: (workspaceId) =>
				Effect.gen(function* () {
					yield* Ref.update(recorder.killAllForWorkspaceCalls, (calls) => [
						...calls,
						workspaceId,
					]);
					return 0;
				}),
		});
	})
);

export const TestLaborerRpcLayer = LaborerRpcsLive.pipe(
	Layer.provide(LinearTaskImporter.layer),
	Layer.provide(GithubTaskImporter.layer),
	Layer.provide(TaskManager.layer),
	Layer.provide(PrdStorageService.layer),
	Layer.provide(DiffService.layer),
	Layer.provide(TestTerminalClient),
	Layer.provideMerge(TestTerminalClientRecorderLayer),
	Layer.provide(WorkspaceProvider.layer),
	Layer.provide(ConfigService.layer),
	Layer.provide(ProjectRegistry.layer),
	Layer.provide(RepositoryIdentity.layer),
	Layer.provide(WorktreeWatcher.layer),
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
	Layer.provide(PortAllocator.make(4100, 4199)),
	Layer.provide(TestLaborerStore)
);

const TestLaborerRpcWithStoreLayer = LaborerRpcsLive.pipe(
	Layer.provide(LinearTaskImporter.layer),
	Layer.provide(GithubTaskImporter.layer),
	Layer.provide(TaskManager.layer),
	Layer.provide(PrdStorageService.layer),
	Layer.provide(DiffService.layer),
	Layer.provide(TestTerminalClient),
	Layer.provideMerge(TestTerminalClientRecorderLayer),
	Layer.provide(WorkspaceProvider.layer),
	Layer.provide(ConfigService.layer),
	Layer.provide(ProjectRegistry.layer),
	Layer.provide(RepositoryIdentity.layer),
	Layer.provide(WorktreeWatcher.layer),
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
	Layer.provide(PortAllocator.make(4100, 4199)),
	Layer.provideMerge(TestLaborerStore)
);

export const TestLaborerRpcClient = RpcTest.makeClient(LaborerRpcs);

export const makeTestRpcClient = TestLaborerRpcClient.pipe(
	Effect.provide(TestLaborerRpcLayer)
);

export const makeScopedTestRpcContext = Effect.gen(function* () {
	const context = yield* Layer.build(TestLaborerRpcWithStoreLayer);
	const client = yield* TestLaborerRpcClient.pipe(
		Effect.provide(Layer.succeedContext(context))
	);
	const { store } = Context.get(context, LaborerStore);
	const terminalClientRecorder = Context.get(
		context,
		TestTerminalClientRecorder
	);

	return { client, store, terminalClientRecorder };
});
