/**
 * RPC Handlers
 *
 * Implements handler logic for the LaborerRpcs group.
 * Handlers delegate to Effect services for real work.
 * Services that aren't yet implemented return "not implemented" errors.
 */

import { LaborerRpcs, RpcError } from "@laborer/shared/rpc";
import { Effect } from "effect";
import { ProjectRegistry } from "../services/project-registry.js";

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
 * - health.check: returns server uptime
 * - project.add: delegates to ProjectRegistry.addProject (Issue #21)
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
		// Workspace RPCs (stubs — Issue #33-47)
		// -------------------------------------------------------------------
		"workspace.create": () => Effect.fail(notImplemented("workspace.create")),
		"workspace.destroy": () => Effect.fail(notImplemented("workspace.destroy")),

		// -------------------------------------------------------------------
		// Terminal RPCs (stubs — Issue #50-59)
		// -------------------------------------------------------------------
		"terminal.spawn": () => Effect.fail(notImplemented("terminal.spawn")),
		"terminal.write": () => Effect.fail(notImplemented("terminal.write")),
		"terminal.resize": () => Effect.fail(notImplemented("terminal.resize")),
		"terminal.kill": () => Effect.fail(notImplemented("terminal.kill")),

		// -------------------------------------------------------------------
		// Diff RPCs (stubs — Issue #82-86)
		// -------------------------------------------------------------------
		"diff.refresh": () => Effect.fail(notImplemented("diff.refresh")),

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
