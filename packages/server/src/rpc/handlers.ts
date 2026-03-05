/**
 * RPC Handlers
 *
 * Implements handler logic for the LaborerRpcs group.
 * Handlers delegate to Effect services for real work.
 * All RPC methods are now fully implemented — no stubs remain.
 */

import { join } from "node:path";
import { LaborerRpcs, RpcError } from "@laborer/shared/rpc";
import { tables } from "@laborer/shared/schema";
import { Array as Arr, Effect, pipe } from "effect";
import { DiffService } from "../services/diff-service.js";
import { LaborerStore } from "../services/laborer-store.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { TaskManager } from "../services/task-manager.js";
import { TerminalManager } from "../services/terminal-manager.js";
import { WorkspaceProvider } from "../services/workspace-provider.js";

const startTime = Date.now();

/**
 * RPC handler layer for the LaborerRpcs group.
 *
 * All 21 RPC methods are fully implemented:
 * - health.check: returns server uptime (Issue #12)
 * - project.add: delegates to ProjectRegistry.addProject (Issue #21)
 * - project.remove: delegates to ProjectRegistry.removeProject (Issue #22)
 * - workspace.create: delegates to WorkspaceProvider.createWorktree + DiffService.startPolling (Issue #33/#40/#85)
 * - workspace.destroy: delegates to DiffService.stopPolling + TerminalManager.killAllForWorkspace + WorkspaceProvider.destroyWorktree (Issue #43/#44/#85)
 * - terminal.spawn: delegates to TerminalManager.spawn (Issue #50)
 * - terminal.write: delegates to TerminalManager.write (Issue #52)
 * - terminal.resize: delegates to TerminalManager.resize (Issue #53)
 * - terminal.kill: delegates to TerminalManager.kill (Issue #54)
 * - terminal.remove: delegates to TerminalManager.remove (Issue #132)
 * - terminal.restart: delegates to TerminalManager.restart (Issue #133)
 * - diff.refresh: delegates to DiffService.getDiff (Issue #82)
 * - editor.open: opens file in configured editor (Issue #111)
 * - rlph.startLoop: delegates to TerminalManager.spawn with `rlph --once` (Issue #92)
 * - rlph.writePRD: delegates to TerminalManager.spawn with `rlph prd [description]` (Issue #94)
 * - rlph.review: delegates to TerminalManager.spawn with `rlph review <prNumber>` (Issue #96)
 * - rlph.fix: delegates to TerminalManager.spawn with `rlph fix <prNumber>` (Issue #98)
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
				// with "running" status. Polling runs in the background and commits
				// DiffUpdated events to LiveStore on each interval.
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
				// This prevents polling errors when the worktree directory is removed
				// and ensures no leaked polling fibers.
				const diffService = yield* DiffService;
				yield* diffService.stopPolling(workspaceId);

				// Issue #44: Kill all workspace processes before removing the worktree.
				// This prevents orphan PTY processes that would keep running after
				// the workspace directory is removed.
				const tm = yield* TerminalManager;
				yield* tm.killAllForWorkspace(workspaceId);

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
		"terminal.remove": ({ terminalId }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				yield* tm.remove(terminalId);
			}),
		"terminal.restart": ({ terminalId }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.restart(terminalId);
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

				// 3. Get the editor command from env (lazy import to avoid import-time side effects)
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
		// rlph RPCs (Issue #92-98)
		// -------------------------------------------------------------------
		"rlph.startLoop": ({ workspaceId }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn(workspaceId, "rlph --once");
			}),
		"rlph.writePRD": ({ workspaceId, description }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				const command = description ? `rlph prd ${description}` : "rlph prd";
				return yield* tm.spawn(workspaceId, command);
			}),
		"rlph.review": ({ workspaceId, prNumber }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn(workspaceId, `rlph review ${prNumber}`);
			}),
		"rlph.fix": ({ workspaceId, prNumber }) =>
			Effect.gen(function* () {
				const tm = yield* TerminalManager;
				return yield* tm.spawn(workspaceId, `rlph fix ${prNumber}`);
			}),

		// -------------------------------------------------------------------
		// Task RPCs (Issue #100-102)
		// -------------------------------------------------------------------
		"task.create": ({ projectId, title }) =>
			Effect.gen(function* () {
				const taskManager = yield* TaskManager;
				const task = yield* taskManager.createTask(projectId, title, "manual");
				return {
					id: task.id,
					projectId: task.projectId,
					source: task.source,
					externalId: task.externalId ?? undefined,
					title: task.title,
					status: task.status,
				};
			}),
		"task.updateStatus": ({ taskId, status }) =>
			Effect.gen(function* () {
				const taskManager = yield* TaskManager;
				yield* taskManager.updateTaskStatus(taskId, status);

				// Issue #105: Task-driven workspace auto-creation.
				// When a task transitions to "in_progress", automatically create a
				// workspace for it — connecting the task lifecycle to the workspace
				// lifecycle. The branch name is derived from the task title for
				// discoverability in `git branch` output.
				if (status === "in_progress") {
					const { store } = yield* LaborerStore;
					const task = yield* taskManager.getTask(taskId);

					// Check if a workspace already exists for this task to prevent
					// duplicate creation (e.g., if the task is toggled back to
					// in_progress after being paused).
					const existingWorkspaces = store.query(tables.workspaces);
					const hasWorkspace = pipe(
						existingWorkspaces,
						Arr.findFirst(
							(w) => w.taskSource === taskId && w.status !== "destroyed"
						)
					);

					if (hasWorkspace._tag === "None") {
						// Derive branch name from task: task/<id-prefix>/<slug>
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

						// Auto-start diff polling (mirrors workspace.create handler)
						if (workspace.status === "running") {
							const diffService = yield* DiffService;
							yield* diffService.startPolling(workspace.id);
						}
					}
				}

				// Issue #106: Task-driven workspace auto-cleanup.
				// When a task transitions to "completed" or "cancelled", automatically
				// destroy any linked workspace. This keeps the environment clean by
				// freeing ports, removing worktrees, and killing processes when a task
				// is finished. Mirrors the workspace.destroy handler pattern.
				if (status === "completed" || status === "cancelled") {
					const { store } = yield* LaborerStore;
					const allWorkspaces = store.query(tables.workspaces);

					// Find all non-destroyed workspaces linked to this task
					const linkedWorkspaces = pipe(
						allWorkspaces,
						Arr.filter(
							(w) => w.taskSource === taskId && w.status !== "destroyed"
						)
					);

					// Destroy each linked workspace using the same cleanup sequence
					// as the workspace.destroy handler: stop polling → kill terminals
					// → remove worktree. Errors are logged but do not fail the status
					// update — the task status change is the user's intent.
					for (const workspace of linkedWorkspaces) {
						yield* Effect.gen(function* () {
							const diffService = yield* DiffService;
							yield* diffService.stopPolling(workspace.id);

							const tm = yield* TerminalManager;
							yield* tm.killAllForWorkspace(workspace.id);

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
