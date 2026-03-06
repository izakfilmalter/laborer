import { assert, describe, it } from "@effect/vitest";
import { events, schema, tables } from "@laborer/shared/schema";
import { PrdStatus } from "@laborer/shared/types";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Schema } from "effect";

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

		const created = store.query(tables.prds.where("id", "prd-1"));
		assert.strictEqual(created.length, 1);
		assert.strictEqual(created[0]?.id, "prd-1");
		assert.strictEqual(created[0]?.projectId, "project-1");
		assert.strictEqual(created[0]?.title, "MCP planning");
		assert.strictEqual(created[0]?.slug, "mcp-planning");
		assert.strictEqual(created[0]?.filePath, "/tmp/PRD-mcp-planning.md");
		assert.strictEqual(created[0]?.status, "draft");
		assert.strictEqual(created[0]?.createdAt, "2026-03-06T00:00:00.000Z");

		store.commit(events.prdStatusChanged({ id: "prd-1", status: "active" }));

		const afterStatus = store.query(tables.prds.where("id", "prd-1"));
		assert.strictEqual(afterStatus[0]?.status, "active");

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

		const afterUpdate = store.query(tables.prds.where("id", "prd-1"));
		assert.strictEqual(afterUpdate[0]?.title, "MCP planning revised");
		assert.strictEqual(afterUpdate[0]?.status, "active");

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

		const afterRemove = store.query(tables.prds.where("id", "prd-1"));
		assert.strictEqual(afterRemove.length, 0);
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

		const tasks = store.query(tables.tasks.where("id", "task-1"));
		assert.strictEqual(tasks.length, 1);
		assert.strictEqual(tasks[0]?.id, "task-1");
		assert.strictEqual(tasks[0]?.prdId, null);
		assert.strictEqual(tasks[0]?.title, "Existing task");
		assert.strictEqual(tasks[0]?.status, "pending");
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

		const tasks = store.query(tables.tasks.where("id", "task-2"));
		assert.strictEqual(tasks.length, 1);
		assert.strictEqual(tasks[0]?.id, "task-2");
		assert.strictEqual(tasks[0]?.prdId, "prd-1");
		assert.strictEqual(tasks[0]?.source, "prd");
		assert.strictEqual(tasks[0]?.title, "Implement MCP issue flow");
	});

	it("validates the supported prd status values", () => {
		const decodePrdStatus = Schema.decodeUnknownSync(PrdStatus);

		assert.strictEqual(decodePrdStatus("draft"), "draft");
		assert.strictEqual(decodePrdStatus("active"), "active");
		assert.strictEqual(decodePrdStatus("completed"), "completed");
		assert.throws(() => decodePrdStatus("pending"));
	});
});
