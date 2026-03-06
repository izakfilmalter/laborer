import { Effect, Either, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { handlePrdCreate, handlePrdList } from "../src/rpc/handlers.js";
import { PrdStorageService } from "../src/services/prd-storage-service.js";
import { ProjectRegistry } from "../src/services/project-registry.js";
import { TestLaborerStore } from "./helpers/test-store.js";

const project = {
	id: "project-1",
	name: "laborer",
	repoPath: "/repo/laborer",
	rlphConfig: null,
} as const;

const makeProjectRegistryLayer = () =>
	Layer.succeed(
		ProjectRegistry,
		ProjectRegistry.of({
			addProject: () => Effect.die("not used in this test"),
			removeProject: () => Effect.die("not used in this test"),
			listProjects: () => Effect.succeed([project]),
			getProject: (projectId: string) =>
				projectId === project.id
					? Effect.succeed(project)
					: Effect.die(`unexpected project lookup: ${projectId}`),
		})
	);

const makePrdStorageLayer = (
	createPrdFile: PrdStorageService["Type"]["createPrdFile"]
) =>
	Layer.succeed(
		PrdStorageService,
		PrdStorageService.of({
			createPrdFile,
			readPrdFile: () => Effect.die("not used in this test"),
			resolvePrdsDir: () => Effect.die("not used in this test"),
		})
	);

describe("PRD RPC handlers", () => {
	it("creates a PRD, writes the file, and lists the saved metadata", async () => {
		const createPrdFile = vi.fn(() =>
			Effect.succeed("/tmp/prds/PRD-mcp-server-prd-workflow.md")
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "MCP Server & PRD Workflow",
					content: "# PRD\n",
				});

				expect(created).toEqual(
					expect.objectContaining({
						projectId: project.id,
						title: "MCP Server & PRD Workflow",
						slug: "mcp-server-prd-workflow",
						filePath: "/tmp/prds/PRD-mcp-server-prd-workflow.md",
						status: "draft",
					})
				);

				const listed = yield* handlePrdList({ projectId: project.id });
				expect(listed).toEqual([created]);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						makeProjectRegistryLayer(),
						makePrdStorageLayer(createPrdFile)
					)
				)
			)
		);

		expect(createPrdFile).toHaveBeenCalledWith(
			project.repoPath,
			project.name,
			"MCP Server & PRD Workflow",
			"# PRD\n"
		);
	});

	it("rejects duplicate PRD titles within the same project", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				yield* handlePrdCreate({
					projectId: project.id,
					title: "Shared plan",
					content: "# First\n",
				});

				return yield* handlePrdCreate({
					projectId: project.id,
					title: "Shared plan",
					content: "# Second\n",
				}).pipe(Effect.either);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						makeProjectRegistryLayer(),
						makePrdStorageLayer((_, __, title) =>
							Effect.succeed(`/tmp/prds/PRD-${title}.md`)
						)
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("ALREADY_EXISTS");
			expect(result.left.message).toContain("Shared plan");
		}
	});
});
