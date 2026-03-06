import { assert, describe, it } from "@effect/vitest";
import { Effect, Either, Layer } from "effect";
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
	it.scoped(
		"creates a PRD, writes the file, and lists the saved metadata",
		() => {
			const calls: [string, string, string, string][] = [];
			const createPrdFile: PrdStorageService["Type"]["createPrdFile"] = (
				repoPath,
				name,
				title,
				content
			) => {
				calls.push([repoPath, name, title, content]);
				return Effect.succeed("/tmp/prds/PRD-mcp-server-prd-workflow.md");
			};

			return Effect.gen(function* () {
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "MCP Server & PRD Workflow",
					content: "# PRD\n",
				});

				assert.strictEqual(created.projectId, project.id);
				assert.strictEqual(created.title, "MCP Server & PRD Workflow");
				assert.strictEqual(created.slug, "mcp-server-prd-workflow");
				assert.strictEqual(
					created.filePath,
					"/tmp/prds/PRD-mcp-server-prd-workflow.md"
				);
				assert.strictEqual(created.status, "draft");

				const listed = yield* handlePrdList({ projectId: project.id });
				assert.deepStrictEqual(listed, [created]);

				assert.strictEqual(calls.length, 1);
				assert.strictEqual(calls[0]?.[0], project.repoPath);
				assert.strictEqual(calls[0]?.[1], project.name);
				assert.strictEqual(calls[0]?.[2], "MCP Server & PRD Workflow");
				assert.strictEqual(calls[0]?.[3], "# PRD\n");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						makeProjectRegistryLayer(),
						makePrdStorageLayer(createPrdFile)
					)
				)
			);
		}
	);

	it.scoped("rejects duplicate PRD titles within the same project", () =>
		Effect.gen(function* () {
			yield* handlePrdCreate({
				projectId: project.id,
				title: "Shared plan",
				content: "# First\n",
			});

			const result = yield* handlePrdCreate({
				projectId: project.id,
				title: "Shared plan",
				content: "# Second\n",
			}).pipe(Effect.either);

			assert.isTrue(Either.isLeft(result));
			if (Either.isLeft(result)) {
				assert.strictEqual(result.left.code, "ALREADY_EXISTS");
				assert.include(result.left.message, "Shared plan");
			}
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
});
