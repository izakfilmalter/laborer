/**
 * TaskManager — Effect Service
 *
 * Manages the lifecycle of tasks (create, update status, remove, list).
 * Tasks represent units of work scoped to a project, with sources:
 * linear, github, manual, or prd.
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const taskManager = yield* TaskManager
 *   const task = yield* taskManager.createTask("project-id", "Fix bug", "manual")
 * })
 * ```
 *
 * Issue #100: Task CRUD — create manual task
 * Issue #101: Task CRUD — update status
 * Issue #102: Task CRUD — list per project
 */

import { RpcError } from "@laborer/shared/rpc";
import { events, tables } from "@laborer/shared/schema";
import { Array as Arr, Context, Effect, Layer, pipe } from "effect";
import { LaborerStore } from "./laborer-store.js";

/**
 * Shape of a task record returned by the TaskManager.
 * Matches the LiveStore tasks table columns.
 */
interface TaskRecord {
	readonly externalId: string | null;
	readonly id: string;
	readonly prdId: string | null;
	readonly projectId: string;
	readonly source: string;
	readonly status: string;
	readonly title: string;
}

class TaskManager extends Context.Tag("@laborer/TaskManager")<
	TaskManager,
	{
		readonly createTask: (
			projectId: string,
			title: string,
			source: string,
			externalId?: string,
			prdId?: string
		) => Effect.Effect<TaskRecord, RpcError>;
		readonly updateTaskStatus: (
			taskId: string,
			status: string
		) => Effect.Effect<void, RpcError>;
		readonly removeTask: (taskId: string) => Effect.Effect<void, RpcError>;
		readonly getTask: (taskId: string) => Effect.Effect<TaskRecord, RpcError>;
		readonly listTasks: (
			projectId: string,
			statusFilter?: string
		) => Effect.Effect<readonly TaskRecord[], never>;
	}
>() {
	static readonly layer = Layer.effect(
		TaskManager,
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;

			const createTask = Effect.fn("TaskManager.createTask")(function* (
				projectId: string,
				title: string,
				source: string,
				externalId?: string,
				prdId?: string
			) {
				// 1. Validate the project exists
				const existingProjects = store.query(
					tables.projects.where("id", projectId)
				);

				if (existingProjects.length === 0) {
					return yield* new RpcError({
						message: `Project not found: ${projectId}`,
						code: "NOT_FOUND",
					});
				}

				// 2. Validate the source is a known value
				const validSources = ["linear", "github", "manual", "prd"];
				if (!validSources.includes(source)) {
					return yield* new RpcError({
						message: `Invalid task source: ${source}. Must be one of: ${validSources.join(", ")}`,
						code: "INVALID_SOURCE",
					});
				}

				// 3. Validate title is non-empty
				const trimmedTitle = title.trim();
				if (trimmedTitle.length === 0) {
					return yield* new RpcError({
						message: "Task title cannot be empty",
						code: "INVALID_TITLE",
					});
				}

				// 4. Generate a unique ID
				const id = crypto.randomUUID();

				// 5. Commit TaskCreated event to LiveStore
				const task: TaskRecord = {
					id,
					projectId,
					source,
					prdId: prdId ?? null,
					externalId: externalId ?? null,
					title: trimmedTitle,
					status: "pending",
				};

				store.commit(
					events.taskCreated({
						id: task.id,
						projectId: task.projectId,
						source: task.source,
						prdId: task.prdId,
						externalId: task.externalId,
						title: task.title,
						status: task.status,
					})
				);

				return task;
			});

			const updateTaskStatus = Effect.fn("TaskManager.updateTaskStatus")(
				function* (taskId: string, status: string) {
					// 1. Validate the task exists
					const existingTasks = store.query(tables.tasks.where("id", taskId));

					if (existingTasks.length === 0) {
						return yield* new RpcError({
							message: `Task not found: ${taskId}`,
							code: "NOT_FOUND",
						});
					}

					// 2. Validate the status is a known value
					const validStatuses = [
						"pending",
						"in_progress",
						"completed",
						"cancelled",
					];
					if (!validStatuses.includes(status)) {
						return yield* new RpcError({
							message: `Invalid task status: ${status}. Must be one of: ${validStatuses.join(", ")}`,
							code: "INVALID_STATUS",
						});
					}

					// 3. Commit TaskStatusChanged event to LiveStore
					store.commit(events.taskStatusChanged({ id: taskId, status }));
				}
			);

			const removeTask = Effect.fn("TaskManager.removeTask")(function* (
				taskId: string
			) {
				// 1. Validate the task exists
				const existingTasks = store.query(tables.tasks.where("id", taskId));

				if (existingTasks.length === 0) {
					return yield* new RpcError({
						message: `Task not found: ${taskId}`,
						code: "NOT_FOUND",
					});
				}

				// 2. Commit TaskRemoved event to LiveStore
				store.commit(events.taskRemoved({ id: taskId }));
			});

			const getTask = Effect.fn("TaskManager.getTask")(function* (
				taskId: string
			) {
				const results = store.query(tables.tasks.where("id", taskId));

				if (results.length === 0) {
					return yield* new RpcError({
						message: `Task not found: ${taskId}`,
						code: "NOT_FOUND",
					});
				}

				return results[0] as TaskRecord;
			});

			const listTasks = (projectId: string, statusFilter?: string) =>
				Effect.sync(() => {
					const allTasks = store.query(
						tables.tasks.where("projectId", projectId)
					);

					if (statusFilter) {
						return pipe(
							allTasks,
							Arr.filter((t) => t.status === statusFilter)
						);
					}

					return allTasks;
				});

			return TaskManager.of({
				createTask,
				updateTaskStatus,
				removeTask,
				getTask,
				listTasks,
			});
		})
	);
}

export { TaskManager };
