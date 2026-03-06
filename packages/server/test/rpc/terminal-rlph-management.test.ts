import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import type { RpcError } from "@laborer/shared/rpc";
import { events } from "@laborer/shared/schema";
import { Effect, Ref, type Scope } from "effect";
import { initRepo } from "../helpers/git-helpers.js";
import { makeScopedTestRpcContext } from "./test-layer.js";

type RpcTestContext = Effect.Effect.Success<typeof makeScopedTestRpcContext>;

const cleanupTempRoots = (tempRoots: readonly string[]) => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
};

const runWithRpcTestContext = <A, E>(
	run: (context: RpcTestContext) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E, Scope.Scope> =>
	Effect.gen(function* () {
		const context = yield* makeScopedTestRpcContext;
		return yield* run(context);
	}) as Effect.Effect<A, E, Scope.Scope>;

const makeWorkspaceFixture = (
	context: RpcTestContext,
	tempRoots: string[]
): Effect.Effect<
	{
		readonly projectId: string;
		readonly workspaceId: string;
	},
	RpcError,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const repoPath = initRepo("rpc-terminal-rlph", tempRoots);
		const project = yield* context.client.project.add({ repoPath });
		const workspaceId = crypto.randomUUID();
		const worktreePath = join(repoPath, ".worktrees", workspaceId);

		mkdirSync(worktreePath, { recursive: true });
		context.store.commit(
			events.workspaceCreated({
				baseSha: null,
				branchName: "feature/rpc-terminal",
				createdAt: new Date().toISOString(),
				id: workspaceId,
				origin: "external",
				port: 4100,
				projectId: project.id,
				status: "running",
				taskSource: null,
				worktreePath,
			})
		);

		return { projectId: project.id, workspaceId };
	});

describe("LaborerRpcs terminal and rlph management", () => {
	it.scoped("terminal.spawn delegates to the terminal client boundary", () =>
		runWithRpcTestContext(({ client, terminalClientRecorder, ...context }) =>
			Effect.gen(function* () {
				const tempRoots: string[] = [];
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => cleanupTempRoots(tempRoots))
				);

				const { workspaceId } = yield* makeWorkspaceFixture(
					{ client, terminalClientRecorder, ...context },
					tempRoots
				);
				const terminal = yield* client.terminal.spawn({
					workspaceId,
					command: "pnpm test",
				});

				assert.strictEqual(terminal.workspaceId, workspaceId);
				assert.strictEqual(terminal.command, "pnpm test");
				assert.strictEqual(terminal.status, "running");
				assert.deepStrictEqual(
					yield* Ref.get(terminalClientRecorder.spawnInWorkspaceCalls),
					[{ workspaceId, command: "pnpm test" }]
				);
			})
		)
	);

	it.scoped("rlph.startLoop spawns the once command through RPC", () =>
		runWithRpcTestContext(({ client, terminalClientRecorder, ...context }) =>
			Effect.gen(function* () {
				const tempRoots: string[] = [];
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => cleanupTempRoots(tempRoots))
				);

				const { workspaceId } = yield* makeWorkspaceFixture(
					{ client, terminalClientRecorder, ...context },
					tempRoots
				);
				const terminal = yield* client.rlph.startLoop({ workspaceId });

				assert.strictEqual(terminal.workspaceId, workspaceId);
				assert.strictEqual(terminal.command, "rlph --once");
				assert.strictEqual(terminal.status, "running");
				assert.deepStrictEqual(
					yield* Ref.get(terminalClientRecorder.spawnInWorkspaceCalls),
					[{ workspaceId, command: "rlph --once" }]
				);
			})
		)
	);

	it.scoped("rlph.review spawns the review command through RPC", () =>
		runWithRpcTestContext(({ client, terminalClientRecorder, ...context }) =>
			Effect.gen(function* () {
				const tempRoots: string[] = [];
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => cleanupTempRoots(tempRoots))
				);

				const { workspaceId } = yield* makeWorkspaceFixture(
					{ client, terminalClientRecorder, ...context },
					tempRoots
				);
				const terminal = yield* client.rlph.review({
					workspaceId,
					prNumber: 42,
				});

				assert.strictEqual(terminal.workspaceId, workspaceId);
				assert.strictEqual(terminal.command, "rlph review 42");
				assert.strictEqual(terminal.status, "running");
				assert.deepStrictEqual(
					yield* Ref.get(terminalClientRecorder.spawnInWorkspaceCalls),
					[{ workspaceId, command: "rlph review 42" }]
				);
			})
		)
	);

	it.scoped("rlph.fix spawns the fix command through RPC", () =>
		runWithRpcTestContext(({ client, terminalClientRecorder, ...context }) =>
			Effect.gen(function* () {
				const tempRoots: string[] = [];
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => cleanupTempRoots(tempRoots))
				);

				const { workspaceId } = yield* makeWorkspaceFixture(
					{ client, terminalClientRecorder, ...context },
					tempRoots
				);
				const terminal = yield* client.rlph.fix({
					workspaceId,
					prNumber: 77,
				});

				assert.strictEqual(terminal.workspaceId, workspaceId);
				assert.strictEqual(terminal.command, "rlph fix 77");
				assert.strictEqual(terminal.status, "running");
				assert.deepStrictEqual(
					yield* Ref.get(terminalClientRecorder.spawnInWorkspaceCalls),
					[{ workspaceId, command: "rlph fix 77" }]
				);
			})
		)
	);
});
