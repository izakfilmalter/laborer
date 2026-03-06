import { Effect, Either, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
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
			createPrd: () => Effect.die("Not implemented in this test"),
			listPrds: () => Effect.die("Not implemented in this test"),
			listProjects,
			readPrd: () => Effect.die("Not implemented in this test"),
			updatePrd: () => Effect.die("Not implemented in this test"),
		})
	);

describe("discoverProjectFromCwd", () => {
	it("matches a project directly from its repo path", () => {
		expect(discoverProjectFromCwd(projects, "/repo/laborer")).toEqual(
			projects[0]
		);
	});

	it("walks up parent directories to find the closest project", () => {
		expect(
			discoverProjectFromCwd(projects, "/repo/laborer/packages/mcp/src")
		).toEqual(projects[0]);
	});

	it("returns null when no registered project matches the cwd", () => {
		expect(discoverProjectFromCwd(projects, "/tmp/outside-project")).toBeNull();
	});
});

describe("ProjectDiscovery", () => {
	it("loads projects through the RPC client and resolves the cwd", async () => {
		const listProjects = vi.fn(() => Effect.succeed(projects));

		const project = await Effect.runPromise(
			Effect.gen(function* () {
				const discovery = yield* ProjectDiscovery;
				return yield* discovery.discoverProject("/repo/laborer/packages/mcp");
			}).pipe(
				Effect.provide(
					ProjectDiscovery.layer.pipe(
						Layer.provide(makeLaborerRpcClientLayer(listProjects))
					)
				)
			)
		);

		expect(project).toEqual(projects[0]);
		expect(listProjects).toHaveBeenCalledTimes(1);
	});

	it("fails with NOT_FOUND when the cwd is outside registered projects", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const discovery = yield* ProjectDiscovery;
				return yield* discovery.discoverProject("/tmp/outside-project");
			}).pipe(
				Effect.either,
				Effect.provide(
					ProjectDiscovery.layer.pipe(
						Layer.provide(
							makeLaborerRpcClientLayer(() => Effect.succeed(projects))
						)
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("NOT_FOUND");
			expect(result.left.message).toContain("/tmp/outside-project");
		}
	});
});
