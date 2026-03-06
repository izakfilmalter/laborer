import { assert, describe, it } from "@effect/vitest";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect } from "effect";
import { events, schema, tables } from "../src/schema.js";

const makeTestStore = Effect.gen(function* () {
	const adapter = makeAdapter({ storage: { type: "in-memory" } });

	return yield* createStore({
		schema,
		storeId: `test-${crypto.randomUUID()}`,
		adapter,
		batchUpdates: (run) => run(),
		disableDevtools: true,
	});
}).pipe(provideOtel({}));

describe("LiveStore schema", () => {
	it.scoped(
		"materializes project lifecycle events into the projects table",
		() =>
			Effect.gen(function* () {
				const store = yield* makeTestStore;

				store.commit(
					events.projectCreated({
						id: "project-1",
						repoPath: "/tmp/project-1",
						name: "Project One",
						rlphConfig: null,
					})
				);

				const createdProject = store.query(
					tables.projects.where("id", "project-1")
				);

				assert.strictEqual(createdProject.length, 1);
				assert.deepStrictEqual(createdProject[0], {
					id: "project-1",
					repoPath: "/tmp/project-1",
					name: "Project One",
					rlphConfig: null,
				});

				store.commit(events.projectRemoved({ id: "project-1" }));

				assert.deepStrictEqual(
					store.query(tables.projects.where("id", "project-1")),
					[]
				);
			})
	);

	it.scoped(
		"materializes workspace lifecycle events into the workspaces table",
		() =>
			Effect.gen(function* () {
				const store = yield* makeTestStore;

				store.commit(
					events.workspaceCreated({
						id: "workspace-1",
						projectId: "project-1",
						taskSource: "manual",
						branchName: "feature/test-coverage",
						worktreePath: "/tmp/project-1/.laborer/workspace-1",
						port: 4321,
						status: "creating",
						origin: "laborer",
						createdAt: "2026-03-06T00:00:00.000Z",
						baseSha: "abc123",
					})
				);

				const createdWorkspace = store.query(
					tables.workspaces.where("id", "workspace-1")
				);

				assert.strictEqual(createdWorkspace.length, 1);
				assert.deepStrictEqual(createdWorkspace[0], {
					id: "workspace-1",
					projectId: "project-1",
					taskSource: "manual",
					branchName: "feature/test-coverage",
					worktreePath: "/tmp/project-1/.laborer/workspace-1",
					port: 4321,
					status: "creating",
					origin: "laborer",
					createdAt: "2026-03-06T00:00:00.000Z",
					baseSha: "abc123",
				});

				store.commit(
					events.workspaceStatusChanged({
						id: "workspace-1",
						status: "running",
					})
				);

				const updatedWorkspace = store.query(
					tables.workspaces.where("id", "workspace-1")
				);

				assert.strictEqual(updatedWorkspace.length, 1);
				assert.strictEqual(updatedWorkspace[0]?.status, "running");

				store.commit(events.workspaceDestroyed({ id: "workspace-1" }));

				assert.deepStrictEqual(
					store.query(tables.workspaces.where("id", "workspace-1")),
					[]
				);
			})
	);

	it.scoped("materializes prd lifecycle events into the prds table", () =>
		Effect.gen(function* () {
			const store = yield* makeTestStore;

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

			assert.deepStrictEqual(store.query(tables.prds.where("id", "prd-1")), [
				{
					id: "prd-1",
					projectId: "project-1",
					title: "MCP planning",
					slug: "mcp-planning",
					filePath: "/tmp/PRD-mcp-planning.md",
					status: "draft",
					createdAt: "2026-03-06T00:00:00.000Z",
				},
			]);

			store.commit(events.prdStatusChanged({ id: "prd-1", status: "active" }));

			assert.strictEqual(
				store.query(tables.prds.where("id", "prd-1"))[0]?.status,
				"active"
			);

			store.commit(events.prdRemoved({ id: "prd-1" }));

			assert.deepStrictEqual(store.query(tables.prds.where("id", "prd-1")), []);
		})
	);
});
