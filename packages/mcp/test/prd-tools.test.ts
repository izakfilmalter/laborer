import { Effect, Either, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { LaborerRpcClient } from "../src/services/laborer-rpc-client.js";
import { ProjectDiscovery } from "../src/services/project-discovery.js";
import { makePrdToolHandlers, PrdTools } from "../src/tools/prd-tools.js";

const project = {
	id: "project-1",
	name: "laborer",
	repoPath: "/repo/laborer",
	rlphConfig: undefined,
} as const;

const prd = {
	id: "prd-1",
	projectId: project.id,
	title: "Roadmap",
	slug: "roadmap",
	filePath: "/tmp/PRD-roadmap.md",
	status: "draft",
	createdAt: "2026-03-06T00:00:00.000Z",
} as const;

const readPrdResponse = {
	...prd,
	content: "# Roadmap",
} as const;

const makeProjectDiscoveryLayer = () =>
	Layer.succeed(
		ProjectDiscovery,
		ProjectDiscovery.of({
			discoverProject: () => Effect.succeed(project),
		})
	);

const makeLaborerRpcClientLayer = (
	overrides: Partial<LaborerRpcClient["Type"]> = {}
) =>
	Layer.succeed(
		LaborerRpcClient,
		LaborerRpcClient.of({
			listProjects: () => Effect.succeed([project]),
			createPrd: () => Effect.succeed(prd),
			listPrds: () => Effect.succeed([prd]),
			readPrd: () => Effect.succeed(readPrdResponse),
			updatePrd: () => Effect.succeed(prd),
			...overrides,
		})
	);

const makeToolkit = (rpcOverrides: Partial<LaborerRpcClient["Type"]> = {}) =>
	PrdTools.pipe(
		Effect.provide(
			PrdTools.toLayer(makePrdToolHandlers).pipe(
				Layer.provide(makeProjectDiscoveryLayer()),
				Layer.provide(makeLaborerRpcClientLayer(rpcOverrides))
			)
		)
	);

describe("PrdTools", () => {
	it("registers the expected MCP PRD tools", () => {
		expect(Object.keys(PrdTools.tools)).toEqual([
			"create_prd",
			"read_prd",
			"update_prd",
			"list_prds",
		]);

		expect(PrdTools.tools.create_prd.description).toContain(
			"current Laborer project"
		);
		expect(PrdTools.tools.read_prd.description).toContain("id or exact title");
	});

	it("create_prd uses the discovered project context", async () => {
		const createPrd = vi.fn(() => Effect.succeed(prd));
		const toolkit = await Effect.runPromise(
			makeToolkit({
				createPrd,
			})
		);

		const result = await Effect.runPromise(
			toolkit.handle("create_prd", {
				title: "Roadmap",
				content: "# Roadmap",
			})
		);

		expect(createPrd).toHaveBeenCalledWith({
			projectId: project.id,
			title: "Roadmap",
			content: "# Roadmap",
		});
		expect(result.result).toEqual(prd);
	});

	it("list_prds uses the discovered project context", async () => {
		const listPrds = vi.fn(() => Effect.succeed([prd]));
		const toolkit = await Effect.runPromise(
			makeToolkit({
				listPrds,
			})
		);

		const result = await Effect.runPromise(toolkit.handle("list_prds", {}));

		expect(listPrds).toHaveBeenCalledWith({ projectId: project.id });
		expect(result.result).toEqual([prd]);
	});

	it("read_prd resolves an exact title before delegating to prd.read", async () => {
		const listPrds = vi.fn(() => Effect.succeed([prd]));
		const readPrd = vi.fn(() => Effect.succeed(readPrdResponse));
		const toolkit = await Effect.runPromise(
			makeToolkit({
				listPrds,
				readPrd,
			})
		);

		const result = await Effect.runPromise(
			toolkit.handle("read_prd", {
				title: prd.title,
			})
		);

		expect(listPrds).toHaveBeenCalledWith({ projectId: project.id });
		expect(readPrd).toHaveBeenCalledWith({ prdId: prd.id });
		expect(result.result).toEqual(readPrdResponse);
	});

	it("update_prd delegates directly to the PRD update RPC", async () => {
		const updatePrd = vi.fn(() => Effect.succeed(prd));
		const toolkit = await Effect.runPromise(
			makeToolkit({
				updatePrd,
			})
		);

		const result = await Effect.runPromise(
			toolkit.handle("update_prd", {
				prdId: prd.id,
				content: "# Updated roadmap",
			})
		);

		expect(updatePrd).toHaveBeenCalledWith({
			prdId: prd.id,
			content: "# Updated roadmap",
		});
		expect(result.result).toEqual(prd);
	});

	it("read_prd fails when neither prdId nor title is provided", async () => {
		const toolkit = await Effect.runPromise(makeToolkit());

		const result = await Effect.runPromise(
			toolkit.handle("read_prd", {}).pipe(Effect.either)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("INVALID_INPUT");
		}
	});
});
