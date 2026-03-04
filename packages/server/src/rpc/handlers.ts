/**
 * RPC Handlers
 *
 * Implements handler logic for the LaborerRpcs group.
 * Handlers delegate to Effect services for real work.
 * Services that aren't yet implemented return "not implemented" errors.
 */

import { LaborerRpcs, RpcError } from "@laborer/shared/rpc";
import { Effect } from "effect";
import { DiffService } from "../services/diff-service.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { TerminalManager } from "../services/terminal-manager.js";
import { WorkspaceProvider } from "../services/workspace-provider.js";

const startTime = Date.now();

const notImplemented = (method: string) =>
	new RpcError({
		message: `${method} is not yet implemented`,
		code: "NOT_IMPLEMENTED",
	});

/**
 * RPC handler layer for the LaborerRpcs group.
 *
 * Implemented handlers:
 * - health.check: returns server uptime (Issue #12)
 * - project.add: delegates to ProjectRegistry.addProject (Issue #21)
 * - project.remove: delegates to ProjectRegistry.removeProject (Issue #22)
 * - workspace.create: delegates to WorkspaceProvider.createWorktree (Issue #33/#40)
 * - workspace.destroy: delegates to WorkspaceProvider.destroyWorktree (Issue #43)
 * - terminal.spawn: delegates to TerminalManager.spawn (Issue #50)
 * - terminal.write: delegates to TerminalManager.write (Issue #52)
 * - terminal.resize: delegates to TerminalManager.resize (Issue #53)
 * - terminal.kill: delegates to TerminalManager.kill (Issue #54)
 * - diff.refresh: delegates to DiffService.getDiff (Issue #82)
 *
 * All other handlers are stubs that will be replaced as
 * their backing services are implemented.
 */
export const LaborerRpcsLive = LaborerRpcs.toLayer(
	LaborerRpcs.of({
		// -------------------------------------------------------------------
		// Health Check (Issue #12)
		// -------------------------------------------------------------------
		"health.check": () =>
			Effect.succeed({
				status: "ok" as const,
				uptime: (Date.now() - startTime) / 1000,
			}),

		// -------------------------------------------------------------------
		// Project RPCs (Issue #21-25)
		// -------------------------------------------------------------------
		"project.add": ({ repoPath }) =>
			Effect.gen(function* () {
				const registry = yield* ProjectRegistry;
				const project = yield* registry.addProject(repoPath);
				return {
					id: project.id,
					repoPath: project.repoPath,
					name: project.name,
					rlphConfig: project.rlphConfig ?? undefined,
				};
			}),
		"project.remove": ({ projectId }) =>
			Effect.gen(function* () {
				const registry = yield* ProjectRegistry;
				yield* registry.removeProject(projectId);
			}),

		// -------------------------------------------------------------------
		// Workspace RPCs (Issue #33-47)
		// -------------------------------------------------------------------
		"workspace.create": ({ projectId, branchName, taskId }) =>
			Effect.gen(function* () {
				const provider = yield* WorkspaceProvider;
				const workspace = yield* provider.createWorktree(
					projectId,
					branchName,
					taskId
				);
				return {
					id: workspace.id,
					projectId: workspace.projectId,
					branchName: workspace.branchName,
					worktreePath: workspace.worktreePath,
					port: workspace.port,
					status: workspace.status as
						| "creating"
						| "running"
						| "stopped"
						| "errored"
						| "destroyed",
				};
			}),
		"workspace.destroy": ({ workspaceId }) =>
			Effect.gen(function* () {
				const provider = yield* WorkspaceProvider;
				yield* provider.destroyWorktree(workspaceId);
			}),

		// -------------------------------------------------------------------
		// Terminal RPCs (Issue #50-59)
		// -------------------------------------------------------------------
		"terminal.spawn": ({ workspaceId, command }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn(workspaceId, command);
			}),
		"terminal.write": ({ terminalId, data }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.write(terminalId, data);
			}),
		"terminal.resize": ({ terminalId, cols, rows }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.resize(terminalId, cols, rows);
			}),
		"terminal.kill": ({ terminalId }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.kill(terminalId);
			}),

		// -------------------------------------------------------------------
		// Diff RPCs (Issue #82-86)
		// -------------------------------------------------------------------
		"diff.refresh": ({ workspaceId }) =>
			Effect.gen(function* () {
				const diffService = yield* DiffService;
				return yield* diffService.getDiff(workspaceId);
			}),

		// -------------------------------------------------------------------
		// Editor RPCs (stubs — Issue #111)
		// -------------------------------------------------------------------
		"editor.open": () => Effect.fail(notImplemented("editor.open")),

		// -------------------------------------------------------------------
		// rlph RPCs (stubs — Issue #92-98)
		// -------------------------------------------------------------------
		"rlph.startLoop": () => Effect.fail(notImplemented("rlph.startLoop")),
		"rlph.writePRD": () => Effect.fail(notImplemented("rlph.writePRD")),
		"rlph.review": () => Effect.fail(notImplemented("rlph.review")),
		"rlph.fix": () => Effect.fail(notImplemented("rlph.fix")),
	})
);
