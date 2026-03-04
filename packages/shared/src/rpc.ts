import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import { WorkspaceStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class RpcError extends Schema.TaggedError<RpcError>("RpcError")(
	"RpcError",
	{
		message: Schema.String,
		code: Schema.optional(Schema.String),
	}
) {}

// ---------------------------------------------------------------------------
// Shared Response Schemas
// ---------------------------------------------------------------------------

const HealthCheckResponse = Schema.Struct({
	status: Schema.Literal("ok"),
	uptime: Schema.Number,
});

const ProjectResponse = Schema.Struct({
	id: Schema.String,
	repoPath: Schema.String,
	name: Schema.String,
	rlphConfig: Schema.optional(Schema.String),
});

const WorkspaceResponse = Schema.Struct({
	id: Schema.String,
	projectId: Schema.String,
	branchName: Schema.String,
	worktreePath: Schema.String,
	port: Schema.Int,
	status: WorkspaceStatus,
});

const TerminalResponse = Schema.Struct({
	id: Schema.String,
	workspaceId: Schema.String,
	command: Schema.String,
	status: Schema.Literal("running", "stopped"),
});

const DiffResponse = Schema.Struct({
	workspaceId: Schema.String,
	diffContent: Schema.String,
	lastUpdated: Schema.String,
});

// ---------------------------------------------------------------------------
// RPC Definitions
// ---------------------------------------------------------------------------

export class LaborerRpcs extends RpcGroup.make(
	// -----------------------------------------------------------------------
	// Health Check
	// -----------------------------------------------------------------------
	Rpc.make("health.check", {
		success: HealthCheckResponse,
	}),

	// -----------------------------------------------------------------------
	// Project RPCs
	// -----------------------------------------------------------------------
	Rpc.make("project.add", {
		success: ProjectResponse,
		error: RpcError,
		payload: {
			repoPath: Schema.String,
		},
	}),

	Rpc.make("project.remove", {
		error: RpcError,
		payload: {
			projectId: Schema.String,
		},
	}),

	// -----------------------------------------------------------------------
	// Workspace RPCs
	// -----------------------------------------------------------------------
	Rpc.make("workspace.create", {
		success: WorkspaceResponse,
		error: RpcError,
		payload: {
			projectId: Schema.String,
			branchName: Schema.optional(Schema.String),
			taskId: Schema.optional(Schema.String),
		},
	}),

	Rpc.make("workspace.destroy", {
		error: RpcError,
		payload: {
			workspaceId: Schema.String,
		},
	}),

	// -----------------------------------------------------------------------
	// Terminal RPCs
	// -----------------------------------------------------------------------
	Rpc.make("terminal.spawn", {
		success: TerminalResponse,
		error: RpcError,
		payload: {
			workspaceId: Schema.String,
			command: Schema.optional(Schema.String),
		},
	}),

	Rpc.make("terminal.write", {
		error: RpcError,
		payload: {
			terminalId: Schema.String,
			data: Schema.String,
		},
	}),

	Rpc.make("terminal.resize", {
		error: RpcError,
		payload: {
			terminalId: Schema.String,
			cols: Schema.Int,
			rows: Schema.Int,
		},
	}),

	Rpc.make("terminal.kill", {
		error: RpcError,
		payload: {
			terminalId: Schema.String,
		},
	}),

	// -----------------------------------------------------------------------
	// Diff RPCs
	// -----------------------------------------------------------------------
	Rpc.make("diff.refresh", {
		success: DiffResponse,
		error: RpcError,
		payload: {
			workspaceId: Schema.String,
		},
	}),

	// -----------------------------------------------------------------------
	// Editor RPCs
	// -----------------------------------------------------------------------
	Rpc.make("editor.open", {
		error: RpcError,
		payload: {
			workspaceId: Schema.String,
			filePath: Schema.optional(Schema.String),
		},
	}),

	// -----------------------------------------------------------------------
	// rlph RPCs
	// -----------------------------------------------------------------------
	Rpc.make("rlph.startLoop", {
		success: TerminalResponse,
		error: RpcError,
		payload: {
			workspaceId: Schema.String,
		},
	}),

	Rpc.make("rlph.writePRD", {
		success: TerminalResponse,
		error: RpcError,
		payload: {
			workspaceId: Schema.String,
			description: Schema.optional(Schema.String),
		},
	}),

	Rpc.make("rlph.review", {
		success: TerminalResponse,
		error: RpcError,
		payload: {
			workspaceId: Schema.String,
			prNumber: Schema.Int,
		},
	}),

	Rpc.make("rlph.fix", {
		success: TerminalResponse,
		error: RpcError,
		payload: {
			workspaceId: Schema.String,
			prNumber: Schema.Int,
		},
	})
) {}
