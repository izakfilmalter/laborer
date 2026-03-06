/**
 * RPC Handlers
 *
 * Implements handler logic for the LaborerRpcs group.
 * Handlers delegate to Effect services for real work.
 *
 * Terminal operations are delegated to the TerminalClient service, which
 * connects to the standalone terminal service via Effect RPC. The server
 * no longer runs PTY processes in-process.
 *
 * @see Issue #143: Server TerminalClient + remove server terminal modules
 */

import { join } from "node:path";
import { LaborerRpcs, RpcError } from "@laborer/shared/rpc";
import { events, tables } from "@laborer/shared/schema";
import { Array as Arr, Effect, pipe } from "effect";
import { ConfigService } from "../services/config-service.js";
import { DiffService } from "../services/diff-service.js";
import { GithubTaskImporter } from "../services/github-task-importer.js";
import { LaborerStore } from "../services/laborer-store.js";
import { LinearTaskImporter } from "../services/linear-task-importer.js";
import {
	type PrdStorageError,
	PrdStorageService,
	slugifyPrdTitle,
} from "../services/prd-storage-service.js";
import { PrdTaskImporter } from "../services/prd-task-importer.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { TaskManager } from "../services/task-manager.js";
import { TerminalClient } from "../services/terminal-client.js";
import { WorkspaceProvider } from "../services/workspace-provider.js";

const startTime = Date.now();

const toRpcError = (
	error: PrdStorageError,
	code = "PRD_STORAGE_ERROR"
): RpcError =>
	new RpcError({
		code,
		message: error.message,
	});

const toPrdResponse = (prd: {
	id: string;
	projectId: string;
	title: string;
	slug: string;
	filePath: string;
	status: string;
	createdAt: string;
}) => ({
	id: prd.id,
	projectId: prd.projectId,
	title: prd.title,
	slug: prd.slug,
	filePath: prd.filePath,
	status: prd.status as "draft" | "active" | "completed",
	createdAt: prd.createdAt,
});

const toTaskResponse = (task: {
	id: string;
	projectId: string;
	source: string;
	prdId: string | null;
	externalId: string | null;
	title: string;
	status: string;
}) => ({
	id: task.id,
	projectId: task.projectId,
	source: task.source,
	prdId: task.prdId ?? undefined,
	externalId: task.externalId ?? undefined,
	title: task.title,
	status: task.status,
});

export const handleConfigGet = ({ projectId }: { projectId: string }) =>
	Effect.gen(function* () {
		const registry = yield* ProjectRegistry;
		const configService = yield* ConfigService;

		const project = yield* registry.getProject(projectId);
		return yield* configService.resolveConfig(project.repoPath, project.name);
	});

export const handleConfigUpdate = ({
	projectId,
	config,
}: {
	projectId: string;
	config: {
		prdsDir?: string | undefined;
		rlphConfig?: string | undefined;
		setupScripts?: readonly string[] | undefined;
		worktreeDir?: string | undefined;
	};
}) =>
	Effect.gen(function* () {
		const isValidSetupScripts =
			config.setupScripts === undefined ||
			(config.setupScripts.every((script) => typeof script === "string") &&
				Array.isArray(config.setupScripts));

		const isValidConfig =
			(config.prdsDir === undefined || typeof config.prdsDir === "string") &&
			(config.worktreeDir === undefined ||
				typeof config.worktreeDir === "string") &&
			(config.rlphConfig === undefined ||
				typeof config.rlphConfig === "string") &&
			isValidSetupScripts;

		if (!isValidConfig) {
			return yield* new RpcError({
				code: "INVALID_INPUT",
				message:
					"Invalid config payload. Expected optional string fields for prdsDir, worktreeDir, rlphConfig, and setupScripts as string array.",
			});
		}

		const registry = yield* ProjectRegistry;
		const configService = yield* ConfigService;

		const project = yield* registry.getProject(projectId);
		yield* configService.writeProjectConfig(project.repoPath, config);
	});

export const handlePrdCreate = ({
	projectId,
	title,
	content,
}: {
	projectId: string;
	title: string;
	content: string;
}) =>
	Effect.gen(function* () {
		const trimmedTitle = title.trim();
		if (trimmedTitle.length === 0) {
			return yield* new RpcError({
				code: "INVALID_INPUT",
				message: "PRD title cannot be empty",
			});
		}

		const registry = yield* ProjectRegistry;
		const storage = yield* PrdStorageService;
		const { store } = yield* LaborerStore;
		const project = yield* registry.getProject(projectId);
		const slug = slugifyPrdTitle(trimmedTitle);

		const existingPrds = store.query(tables.prds.where("projectId", projectId));
		const duplicatePrd = existingPrds.find(
			(prd) => prd.title === trimmedTitle || prd.slug === slug
		);

		if (duplicatePrd) {
			return yield* new RpcError({
				code: "ALREADY_EXISTS",
				message: `PRD already exists for project ${projectId}: ${trimmedTitle}`,
			});
		}

		const filePath = yield* storage
			.createPrdFile(project.repoPath, project.name, trimmedTitle, content)
			.pipe(Effect.mapError((error) => toRpcError(error)));

		const prd = {
			id: crypto.randomUUID(),
			projectId,
			title: trimmedTitle,
			slug,
			filePath,
			status: "draft" as const,
			createdAt: new Date().toISOString(),
		};

		store.commit(events.prdCreated(prd));

		return toPrdResponse(prd);
	});

export const handlePrdList = ({ projectId }: { projectId: string }) =>
	Effect.gen(function* () {
		const registry = yield* ProjectRegistry;
		const { store } = yield* LaborerStore;

		yield* registry.getProject(projectId);

		return store
			.query(tables.prds.where("projectId", projectId))
			.map((prd) => toPrdResponse(prd));
	});

export const handlePrdRead = ({ prdId }: { prdId: string }) =>
	Effect.gen(function* () {
		const storage = yield* PrdStorageService;
		const { store } = yield* LaborerStore;

		const prd = store.query(tables.prds.where("id", prdId))[0];
		if (!prd) {
			return yield* new RpcError({
				code: "NOT_FOUND",
				message: `PRD not found: ${prdId}`,
			});
		}

		const content = yield* storage
			.readPrdFile(prd.filePath)
			.pipe(Effect.mapError((error) => toRpcError(error, "NOT_FOUND")));

		return {
			...toPrdResponse(prd),
			content,
		};
	});

export const handlePrdRemove = ({ prdId }: { prdId: string }) =>
	Effect.gen(function* () {
		const { store } = yield* LaborerStore;
		const storage = yield* PrdStorageService;
		const taskManager = yield* TaskManager;

		const prd = store.query(tables.prds.where("id", prdId))[0];
		if (!prd) {
			return yield* new RpcError({
				code: "NOT_FOUND",
				message: `PRD not found: ${prdId}`,
			});
		}

		yield* storage
			.removePrdArtifacts(prd.filePath)
			.pipe(Effect.mapError((error) => toRpcError(error)));

		const linkedTasks = store
			.query(tables.tasks.where("prdId", prdId))
			.filter((task) => task.source === "prd");

		for (const task of linkedTasks) {
			yield* taskManager.removeTask(task.id);
		}

		store.commit(events.prdRemoved({ id: prdId }));
	});

export const handlePrdUpdate = ({
	prdId,
	content,
}: {
	prdId: string;
	content: string;
}) =>
	Effect.gen(function* () {
		const { store } = yield* LaborerStore;
		const storage = yield* PrdStorageService;

		const prd = store.query(tables.prds.where("id", prdId))[0];
		if (!prd) {
			return yield* new RpcError({
				code: "NOT_FOUND",
				message: `PRD not found: ${prdId}`,
			});
		}

		yield* storage
			.updatePrdFile(prd.filePath, content)
			.pipe(Effect.mapError((error) => toRpcError(error)));

		store.commit(
			events.prdUpdated({
				id: prd.id,
				projectId: prd.projectId,
				title: prd.title,
				slug: prd.slug,
				filePath: prd.filePath,
				status: prd.status as "draft" | "active" | "completed",
				createdAt: prd.createdAt,
			})
		);

		return toPrdResponse(prd);
	});

export const handlePrdUpdateStatus = ({
	prdId,
	status,
}: {
	prdId: string;
	status: string;
}) =>
	Effect.gen(function* () {
		const { store } = yield* LaborerStore;

		const prd = store.query(tables.prds.where("id", prdId))[0];
		if (!prd) {
			return yield* new RpcError({
				code: "NOT_FOUND",
				message: `PRD not found: ${prdId}`,
			});
		}

		const validStatuses = ["draft", "active", "completed"] as const;
		if (!validStatuses.some((value) => value === status)) {
			return yield* new RpcError({
				code: "INVALID_STATUS",
				message: `Invalid PRD status: ${status}. Must be one of: ${validStatuses.join(", ")}`,
			});
		}

		store.commit(
			events.prdStatusChanged({
				id: prdId,
				status: status as "draft" | "active" | "completed",
			})
		);

		return toPrdResponse({
			...prd,
			status: status as "draft" | "active" | "completed",
		});
	});

export const handlePrdCreateIssue = ({
	prdId,
	title,
	body,
}: {
	prdId: string;
	title: string;
	body: string;
}) =>
	Effect.gen(function* () {
		const trimmedTitle = title.trim();
		const trimmedBody = body.trim();

		if (trimmedTitle.length === 0) {
			return yield* new RpcError({
				code: "INVALID_INPUT",
				message: "PRD issue title cannot be empty",
			});
		}

		if (trimmedBody.length === 0) {
			return yield* new RpcError({
				code: "INVALID_INPUT",
				message: "PRD issue body cannot be empty",
			});
		}

		const { store } = yield* LaborerStore;
		const storage = yield* PrdStorageService;
		const taskManager = yield* TaskManager;

		const prd = store.query(tables.prds.where("id", prdId))[0];
		if (!prd) {
			return yield* new RpcError({
				code: "NOT_FOUND",
				message: `PRD not found: ${prdId}`,
			});
		}

		const { issueNumber } = yield* storage
			.appendIssue(prd.filePath, trimmedTitle, trimmedBody)
			.pipe(Effect.mapError((error) => toRpcError(error)));

		const task = yield* taskManager.createTask(
			prd.projectId,
			trimmedTitle,
			"prd",
			`${prd.id}:issue:${issueNumber}`,
			prd.id
		);

		return toTaskResponse(task);
	});

export const handleProjectList = () =>
	Effect.gen(function* () {
		const registry = yield* ProjectRegistry;
		const projects = yield* registry.listProjects();
		return projects.map((project) => ({
			id: project.id,
			repoPath: project.repoPath,
			name: project.name,
			rlphConfig: project.rlphConfig ?? undefined,
		}));
	});

/**
 * RPC handler layer for the LaborerRpcs group.
 *
 * All 23 RPC methods are fully implemented:
 * - health.check: returns server uptime (Issue #12)
 * - project.add: delegates to ProjectRegistry.addProject (Issue #21)
 * - project.remove: delegates to ProjectRegistry.removeProject (Issue #22)
 * - config.get/config.update: delegates to ConfigService via ProjectRegistry lookup (Issue #157)
 * - workspace.create: delegates to WorkspaceProvider.createWorktree + DiffService.startPolling (Issue #33/#40/#85)
 * - workspace.destroy: delegates to DiffService.stopPolling + TerminalClient.killAllForWorkspace + WorkspaceProvider.destroyWorktree (Issue #43/#44/#85)
 * - terminal.spawn: delegates to TerminalClient.spawnInWorkspace (Issue #50/#143)
 * - terminal.write/resize/kill/remove/restart: stub — proxied by web app directly to terminal service (Issue #143)
 * - diff.refresh: delegates to DiffService.getDiff (Issue #82)
 * - editor.open: opens file in configured editor (Issue #111)
 * - rlph.startLoop: delegates to TerminalClient.spawnInWorkspace with `rlph --once` (Issue #92/#143)
 * - rlph.writePRD: delegates to TerminalClient.spawnInWorkspace with `rlph prd [description]` (Issue #94/#143)
 * - rlph.review: delegates to TerminalClient.spawnInWorkspace with `rlph review <prNumber>` (Issue #96/#143)
 * - rlph.fix: delegates to TerminalClient.spawnInWorkspace with `rlph fix <prNumber>` (Issue #98/#143)
 * - task.create: delegates to TaskManager.createTask (Issue #100)
 * - task.updateStatus: delegates to TaskManager.updateTaskStatus + auto-creates workspace on "in_progress" + auto-destroys on "completed"/"cancelled" (Issue #101/#105/#106)
 * - task.remove: delegates to TaskManager.removeTask (Issue #100)
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
		"project.list": handleProjectList,

		// -------------------------------------------------------------------
		// Config RPCs (Issue #157)
		// -------------------------------------------------------------------
		"config.get": handleConfigGet,
		"config.update": handleConfigUpdate,

		// -------------------------------------------------------------------
		// PRD RPCs (Issue #178)
		// -------------------------------------------------------------------
		"prd.create": handlePrdCreate,
		"prd.list": handlePrdList,
		"prd.read": handlePrdRead,
		"prd.remove": handlePrdRemove,
		"prd.update": handlePrdUpdate,
		"prd.updateStatus": handlePrdUpdateStatus,
		"prd.createIssue": handlePrdCreateIssue,

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

				// Issue #85: Auto-start diff polling when workspace is created
				if (workspace.status === "running") {
					const diffService = yield* DiffService;
					yield* diffService.startPolling(workspace.id);
				}

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
				// Issue #85: Stop diff polling before destroying the workspace.
				const diffService = yield* DiffService;
				yield* diffService.stopPolling(workspaceId);

				// Issue #44/#143: Kill all workspace terminals via terminal service.
				const tc = yield* TerminalClient;
				yield* tc.killAllForWorkspace(workspaceId);

				const provider = yield* WorkspaceProvider;
				yield* provider.destroyWorktree(workspaceId);
			}),

		// -------------------------------------------------------------------
		// Terminal RPCs (Issue #50-59, #143)
		// Only terminal.spawn is handled here — it resolves workspace info
		// (cwd, env) before delegating to the terminal service. All other
		// terminal RPCs (write, resize, kill, remove, restart) are called
		// directly from the web app to the terminal service.
		// -------------------------------------------------------------------
		"terminal.spawn": ({ workspaceId, command }) =>
			Effect.gen(function* () {
				const tc = yield* TerminalClient;
				return yield* tc.spawnInWorkspace(workspaceId, command);
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
		// Editor RPCs (Issue #111)
		// -------------------------------------------------------------------
		"editor.open": ({ workspaceId, filePath }) =>
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;

				// 1. Look up the workspace to get worktreePath
				const allWorkspaces = store.query(tables.workspaces);
				const workspaceOpt = pipe(
					allWorkspaces,
					Arr.findFirst((w) => w.id === workspaceId)
				);

				if (workspaceOpt._tag === "None") {
					return yield* new RpcError({
						message: `Workspace not found: ${workspaceId}`,
						code: "NOT_FOUND",
					});
				}

				const workspace = workspaceOpt.value;

				// 2. Build the target path
				const targetPath = filePath
					? join(workspace.worktreePath, filePath)
					: workspace.worktreePath;

				// 3. Get the editor command from env
				const { env } = yield* Effect.promise(
					() => import("@laborer/env/server")
				);
				const editorCommand = env.EDITOR_COMMAND;

				// 4. Execute the editor command
				yield* Effect.tryPromise({
					try: async () => {
						const proc = Bun.spawn([editorCommand, targetPath], {
							stdout: "ignore",
							stderr: "pipe",
						});
						const exitCode = await proc.exited;
						if (exitCode !== 0) {
							const stderr = await new Response(proc.stderr).text();
							throw new Error(
								`Editor command '${editorCommand} ${targetPath}' exited with code ${exitCode}: ${stderr.trim()}`
							);
						}
					},
					catch: (error) =>
						new RpcError({
							message:
								error instanceof Error
									? error.message
									: `Failed to open editor: ${String(error)}`,
							code: "EDITOR_FAILED",
						}),
				});
			}),

		// -------------------------------------------------------------------
		// rlph RPCs (Issue #92-98, #143)
		// Now delegate to TerminalClient.spawnInWorkspace instead of TerminalManager.
		// -------------------------------------------------------------------
		"rlph.startLoop": ({ workspaceId }) =>
			Effect.gen(function* () {
				const tc = yield* TerminalClient;
				return yield* tc.spawnInWorkspace(workspaceId, "rlph --once");
			}),
		"rlph.writePRD": ({ workspaceId, description }) =>
			Effect.gen(function* () {
				const tc = yield* TerminalClient;
				const prdTaskImporter = yield* PrdTaskImporter;
				const command = description ? `rlph prd ${description}` : "rlph prd";
				const terminal = yield* tc.spawnInWorkspace(workspaceId, command);
				yield* prdTaskImporter
					.watchPrdTerminal(terminal.id, workspaceId)
					.pipe(Effect.forkDaemon);
				return terminal;
			}),
		"rlph.review": ({ workspaceId, prNumber }) =>
			Effect.gen(function* () {
				const tc = yield* TerminalClient;
				return yield* tc.spawnInWorkspace(
					workspaceId,
					`rlph review ${prNumber}`
				);
			}),
		"rlph.fix": ({ workspaceId, prNumber }) =>
			Effect.gen(function* () {
				const tc = yield* TerminalClient;
				return yield* tc.spawnInWorkspace(workspaceId, `rlph fix ${prNumber}`);
			}),

		// -------------------------------------------------------------------
		// Task RPCs (Issue #100-102)
		// -------------------------------------------------------------------
		"task.create": ({ projectId, title }) =>
			Effect.gen(function* () {
				const taskManager = yield* TaskManager;
				const task = yield* taskManager.createTask(projectId, title, "manual");
				return toTaskResponse(task);
			}),
		"task.importGithub": ({ projectId }) =>
			Effect.gen(function* () {
				const githubTaskImporter = yield* GithubTaskImporter;
				return yield* githubTaskImporter.importProjectIssues(projectId);
			}),
		"task.importLinear": ({ projectId }) =>
			Effect.gen(function* () {
				const linearTaskImporter = yield* LinearTaskImporter;
				return yield* linearTaskImporter.importProjectIssues(projectId);
			}),
		"task.updateStatus": ({ taskId, status }) =>
			Effect.gen(function* () {
				const taskManager = yield* TaskManager;
				yield* taskManager.updateTaskStatus(taskId, status);

				// Issue #105: Task-driven workspace auto-creation.
				if (status === "in_progress") {
					const { store } = yield* LaborerStore;
					const task = yield* taskManager.getTask(taskId);

					const existingWorkspaces = store.query(tables.workspaces);
					const hasWorkspace = pipe(
						existingWorkspaces,
						Arr.findFirst(
							(w) => w.taskSource === taskId && w.status !== "destroyed"
						)
					);

					if (hasWorkspace._tag === "None") {
						const idPrefix = taskId.slice(0, 8);
						const slug = task.title
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, "-")
							.replace(/^-|-$/g, "")
							.slice(0, 40);
						const branchName = `task/${idPrefix}/${slug}`;

						const provider = yield* WorkspaceProvider;
						const workspace = yield* provider.createWorktree(
							task.projectId,
							branchName,
							taskId
						);

						if (workspace.status === "running") {
							const diffService = yield* DiffService;
							yield* diffService.startPolling(workspace.id);
						}
					}
				}

				// Issue #106: Task-driven workspace auto-cleanup.
				if (status === "completed" || status === "cancelled") {
					const { store } = yield* LaborerStore;
					const allWorkspaces = store.query(tables.workspaces);

					const linkedWorkspaces = pipe(
						allWorkspaces,
						Arr.filter(
							(w) => w.taskSource === taskId && w.status !== "destroyed"
						)
					);

					for (const workspace of linkedWorkspaces) {
						yield* Effect.gen(function* () {
							const diffService = yield* DiffService;
							yield* diffService.stopPolling(workspace.id);

							const tc = yield* TerminalClient;
							yield* tc.killAllForWorkspace(workspace.id);

							const provider = yield* WorkspaceProvider;
							yield* provider.destroyWorktree(workspace.id);
						}).pipe(
							Effect.catchAll((error) =>
								Effect.logWarning(
									`Failed to auto-destroy workspace ${workspace.id} for task ${taskId}: ${String(error)}`
								)
							)
						);
					}
				}
			}),
		"task.remove": ({ taskId }) =>
			Effect.gen(function* () {
				const taskManager = yield* TaskManager;
				yield* taskManager.removeTask(taskId);
			}),
	})
);
