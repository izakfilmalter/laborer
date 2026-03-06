import { McpServer, Tool, Toolkit } from "@effect/ai";
import { RpcError } from "@laborer/shared/rpc";
import { TaskStatus } from "@laborer/shared/types";
import { Effect, Layer, Schema } from "effect";
import { LaborerRpcClient } from "../services/laborer-rpc-client.js";
import { ProjectDiscovery } from "../services/project-discovery.js";

const TaskResponse = Schema.Struct({
	id: Schema.String,
	projectId: Schema.String,
	source: Schema.String,
	prdId: Schema.optional(Schema.String),
	externalId: Schema.optional(Schema.String),
	title: Schema.String,
	status: Schema.String,
});

const CreateIssueTool = Tool.make("create_issue", {
	description:
		"Create a single PRD issue for the current Laborer project and persist it to both the issues markdown file and LiveStore.",
	parameters: {
		prdId: Schema.String,
		title: Schema.String,
		body: Schema.String,
	},
	success: TaskResponse,
	failure: RpcError,
});

const ReadIssuesTool = Tool.make("read_issues", {
	description:
		"Read the full companion issues markdown for a PRD in the current Laborer project.",
	parameters: {
		prdId: Schema.String,
	},
	success: Schema.String,
	failure: RpcError,
});

const UpdateIssueTool = Tool.make("update_issue", {
	description:
		"Update a PRD issue's markdown body and/or task status in the current Laborer project.",
	parameters: {
		taskId: Schema.String,
		body: Schema.optional(Schema.String),
		status: Schema.optional(TaskStatus),
	},
	success: TaskResponse,
	failure: RpcError,
});

const ListRemainingIssuesTool = Tool.make("list_remaining_issues", {
	description:
		"List only pending or in-progress PRD issues for a plan in the current Laborer project.",
	parameters: {
		prdId: Schema.String,
	},
	success: Schema.Array(TaskResponse),
	failure: RpcError,
});

export const IssueTools = Toolkit.make(
	CreateIssueTool,
	ReadIssuesTool,
	UpdateIssueTool,
	ListRemainingIssuesTool
);

const resolveCurrentProject = (projectDiscovery: ProjectDiscovery["Type"]) =>
	Effect.fn("IssueTools.resolveCurrentProject")(function* () {
		return yield* projectDiscovery.discoverProject();
	});

export const makeIssueToolHandlers = Effect.gen(function* () {
	const projectDiscovery = yield* ProjectDiscovery;
	const laborerRpcClient = yield* LaborerRpcClient;
	const getCurrentProject = resolveCurrentProject(projectDiscovery);

	return IssueTools.of({
		create_issue: Effect.fn("IssueTools.create_issue")(function* ({
			prdId,
			title,
			body,
		}) {
			yield* getCurrentProject();
			return yield* laborerRpcClient.createIssue({ prdId, title, body });
		}),
		read_issues: Effect.fn("IssueTools.read_issues")(function* ({ prdId }) {
			yield* getCurrentProject();
			return yield* laborerRpcClient.readIssues({ prdId });
		}),
		update_issue: Effect.fn("IssueTools.update_issue")(function* ({
			taskId,
			body,
			status,
		}) {
			yield* getCurrentProject();
			return yield* laborerRpcClient.updateIssue({
				taskId,
				body,
				status,
			});
		}),
		list_remaining_issues: Effect.fn("IssueTools.list_remaining_issues")(
			function* ({ prdId }) {
				yield* getCurrentProject();
				return yield* laborerRpcClient.listRemainingIssues({ prdId });
			}
		),
	});
});

export const IssueToolsLayer = McpServer.toolkit(IssueTools).pipe(
	Layer.provide(IssueTools.toLayer(makeIssueToolHandlers))
);
