/**
 * RPC Handlers
 *
 * Implements handler logic for the LaborerRpcs group.
 * Currently only health.check is implemented; all other methods
 * return "not implemented" errors and will be wired to real
 * services as those services are built (Issue #19+).
 */

import { LaborerRpcs, RpcError } from "@laborer/shared/rpc";
import { Effect } from "effect";

const startTime = Date.now();

const notImplemented = (method: string) =>
	new RpcError({
		message: `${method} is not yet implemented`,
		code: "NOT_IMPLEMENTED",
	});

/**
 * RPC handler layer for the LaborerRpcs group.
 *
 * The health.check handler returns the server uptime.
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
		// Project RPCs (stubs — Issue #21-25)
		// -------------------------------------------------------------------
		"project.add": () => Effect.fail(notImplemented("project.add")),
		"project.remove": () => Effect.fail(notImplemented("project.remove")),

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
