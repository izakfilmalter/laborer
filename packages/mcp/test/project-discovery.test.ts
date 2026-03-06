import { assert, describe, it } from "@effect/vitest";
import { Effect, Either, Layer } from "effect";
import { LaborerRpcClient } from "../src/services/laborer-rpc-client.js";
import {
	discoverProjectFromCwd,
	ProjectDiscovery,
} from "../src/services/project-discovery.js";

const projects = [
	{
		id: "project-1",
		name: "laborer",
		repoPath: "/repo/laborer",
		rlphConfig: undefined,
	},
	{
		id: "project-2",
		name: "other",
		repoPath: "/repo/other",
		rlphConfig: undefined,
	},
] as const;

const makeLaborerRpcClientLayer = (
	listProjects: LaborerRpcClient["Type"]["listProjects"]
) =>
	Layer.succeed(
		LaborerRpcClient,
		LaborerRpcClient.of({
			createIssue: () => Effect.die("Not implemented in this test"),
			createPrd: () => Effect.die("Not implemented in this test"),
			listRemainingIssues: () => Effect.die("Not implemented in this test"),
			listPrds: () => Effect.die("Not implemented in this test"),
			listProjects,
			readPrd: () => Effect.die("Not implemented in this test"),
			readIssues: () => Effect.die("Not implemented in this test"),
			updateIssue: () => Effect.die("Not implemented in this test"),
			updatePrd: () => Effect.die("Not implemented in this test"),
		})
	);

describe("discoverProjectFromCwd", () => {
	it.effect("matches a project directly from its repo path", () =>
		Effect.sync(() => {
			assert.deepStrictEqual(
				discoverProjectFromCwd(projects, "/repo/laborer"),
				projects[0]
			);
		})
	);

	it.effect("walks up parent directories to find the closest project", () =>
		Effect.sync(() => {
			assert.deepStrictEqual(
				discoverProjectFromCwd(projects, "/repo/laborer/packages/mcp/src"),
				projects[0]
			);
		})
	);

	it.effect("returns null when no registered project matches the cwd", () =>
		Effect.sync(() => {
			assert.isNull(discoverProjectFromCwd(projects, "/tmp/outside-project"));
		})
	);
});

describe("ProjectDiscovery", () => {
	it.effect("loads projects through the RPC client and resolves the cwd", () =>
		Effect.gen(function* () {
			const discovery = yield* ProjectDiscovery;
			const project = yield* discovery.discoverProject(
				"/repo/laborer/packages/mcp"
			);

			assert.deepStrictEqual(project, projects[0]);
		}).pipe(
			Effect.provide(
				ProjectDiscovery.layer.pipe(
					Layer.provide(
						makeLaborerRpcClientLayer(() => Effect.succeed(projects))
					)
				)
			)
		)
	);

	it.effect(
		"fails with NOT_FOUND when the cwd is outside registered projects",
		() =>
			Effect.gen(function* () {
				const discovery = yield* ProjectDiscovery;
				const result = yield* discovery
					.discoverProject("/tmp/outside-project")
					.pipe(Effect.either);

				assert.isTrue(Either.isLeft(result));
				if (Either.isLeft(result)) {
					assert.strictEqual(result.left.code, "NOT_FOUND");
					assert.include(result.left.message, "/tmp/outside-project");
				}
			}).pipe(
				Effect.provide(
					ProjectDiscovery.layer.pipe(
						Layer.provide(
							makeLaborerRpcClientLayer(() => Effect.succeed(projects))
						)
					)
				)
			)
	);
});
