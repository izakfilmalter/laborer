import { RpcTest } from "@effect/rpc";
import { LaborerRpcs } from "@laborer/shared/rpc";
import { Context, Effect, Layer } from "effect";
import { LaborerRpcsLive } from "../../src/rpc/handlers.js";
import { ConfigService } from "../../src/services/config-service.js";
import { DiffService } from "../../src/services/diff-service.js";
import { GithubTaskImporter } from "../../src/services/github-task-importer.js";
import { LaborerStore } from "../../src/services/laborer-store.js";
import { LinearTaskImporter } from "../../src/services/linear-task-importer.js";
import { PortAllocator } from "../../src/services/port-allocator.js";
import { PrdStorageService } from "../../src/services/prd-storage-service.js";
import { PrdTaskImporter } from "../../src/services/prd-task-importer.js";
import { ProjectRegistry } from "../../src/services/project-registry.js";
import { TaskManager } from "../../src/services/task-manager.js";
import { TerminalClient } from "../../src/services/terminal-client.js";
import { WorkspaceProvider } from "../../src/services/workspace-provider.js";
import { WorktreeDetector } from "../../src/services/worktree-detector.js";
import { WorktreeReconciler } from "../../src/services/worktree-reconciler.js";
import { WorktreeWatcher } from "../../src/services/worktree-watcher.js";
import { TestLaborerStore } from "../helpers/test-store.js";

const TestTerminalClient = Layer.succeed(
	TerminalClient,
	TerminalClient.of({
		spawnInWorkspace: (workspaceId, command) =>
			Effect.succeed({
				id: crypto.randomUUID(),
				workspaceId,
				command: command ?? "test-shell",
				status: "running" as const,
			}),
		killAllForWorkspace: () => Effect.succeed(0),
	})
);

const TestPrdTaskImporter = Layer.succeed(
	PrdTaskImporter,
	PrdTaskImporter.of({
		importParsedTasks: () => Effect.succeed(0),
		watchPrdTerminal: () => Effect.void,
	})
);

export const TestLaborerRpcLayer = LaborerRpcsLive.pipe(
	Layer.provide(TestPrdTaskImporter),
	Layer.provide(LinearTaskImporter.layer),
	Layer.provide(GithubTaskImporter.layer),
	Layer.provide(TaskManager.layer),
	Layer.provide(PrdStorageService.layer),
	Layer.provide(DiffService.layer),
	Layer.provide(TestTerminalClient),
	Layer.provide(WorkspaceProvider.layer),
	Layer.provide(ConfigService.layer),
	Layer.provide(ProjectRegistry.layer),
	Layer.provide(WorktreeWatcher.layer),
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
	Layer.provide(PortAllocator.make(4100, 4199)),
	Layer.provide(TestLaborerStore)
);

const TestLaborerRpcWithStoreLayer = LaborerRpcsLive.pipe(
	Layer.provide(TestPrdTaskImporter),
	Layer.provide(LinearTaskImporter.layer),
	Layer.provide(GithubTaskImporter.layer),
	Layer.provide(TaskManager.layer),
	Layer.provide(PrdStorageService.layer),
	Layer.provide(DiffService.layer),
	Layer.provide(TestTerminalClient),
	Layer.provide(WorkspaceProvider.layer),
	Layer.provide(ConfigService.layer),
	Layer.provide(ProjectRegistry.layer),
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

	return { client, store };
});
