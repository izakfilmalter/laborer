import { events, schema, tables } from "@laborer/shared/schema";
import { PrdStatus } from "@laborer/shared/types";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

const createTestStore = async () =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const adapter = makeAdapter({ storage: { type: "in-memory" } });
				return yield* createStore({
					schema,
					storeId: `test-${crypto.randomUUID()}`,
					adapter,
					batchUpdates: (run) => run(),
					disableDevtools: true,
				});
			}).pipe(provideOtel({}))
		)
	);

describe("PRD LiveStore schema", () => {
	it("materializes prd lifecycle events into the prds table", async () => {
		const store = await createTestStore();

		store.commit(
			events.prdCreated({
				id: "prd-1",
				projectId: "project-1",
				title: "MCP planning",
				slug: "mcp-planning",
				filePath: "/tmp/PRD-mcp-planning.md",
				status: "draft",
				createdAt: "2026-03-06T00:00:00.000Z",
			})
		);

		expect(store.query(tables.prds.where("id", "prd-1"))).toEqual([
			expect.objectContaining({
				id: "prd-1",
				projectId: "project-1",
				title: "MCP planning",
				slug: "mcp-planning",
				filePath: "/tmp/PRD-mcp-planning.md",
				status: "draft",
				createdAt: "2026-03-06T00:00:00.000Z",
			}),
		]);

		store.commit(events.prdStatusChanged({ id: "prd-1", status: "active" }));

		expect(store.query(tables.prds.where("id", "prd-1"))).toEqual([
			expect.objectContaining({ status: "active" }),
		]);

		store.commit(
			events.prdUpdated({
				id: "prd-1",
				projectId: "project-1",
				title: "MCP planning revised",
				slug: "mcp-planning",
				filePath: "/tmp/PRD-mcp-planning.md",
				status: "active",
				createdAt: "2026-03-06T00:00:00.000Z",
			})
		);

		expect(store.query(tables.prds.where("id", "prd-1"))).toEqual([
			expect.objectContaining({
				title: "MCP planning revised",
				status: "active",
			}),
		]);

		store.commit(events.prdRemoved({ id: "prd-1" }));

		expect(store.query(tables.prds.where("id", "prd-1"))).toEqual([]);
	});

	it("keeps existing task materialization working", async () => {
		const store = await createTestStore();

		store.commit(
			events.taskCreated({
				id: "task-1",
				projectId: "project-1",
				source: "manual",
				prdId: null,
				externalId: null,
				title: "Existing task",
				status: "pending",
			})
		);

		expect(store.query(tables.tasks.where("id", "task-1"))).toEqual([
			expect.objectContaining({
				id: "task-1",
				prdId: null,
				title: "Existing task",
				status: "pending",
			}),
		]);
	});

	it("stores prd-linked tasks with their prdId", async () => {
		const store = await createTestStore();

		store.commit(
			events.taskCreated({
				id: "task-2",
				projectId: "project-1",
				source: "prd",
				prdId: "prd-1",
				externalId: null,
				title: "Implement MCP issue flow",
				status: "pending",
			})
		);

		expect(store.query(tables.tasks.where("id", "task-2"))).toEqual([
			expect.objectContaining({
				id: "task-2",
				prdId: "prd-1",
				source: "prd",
				title: "Implement MCP issue flow",
			}),
		]);
	});

	it("validates the supported prd status values", () => {
		const decodePrdStatus = Schema.decodeUnknownSync(PrdStatus);

		expect(decodePrdStatus("draft")).toBe("draft");
		expect(decodePrdStatus("active")).toBe("active");
		expect(decodePrdStatus("completed")).toBe("completed");
		expect(() => decodePrdStatus("pending")).toThrow();
	});
});
