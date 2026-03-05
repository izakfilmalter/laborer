import { describe, expect, it } from "vitest";
import {
	canImportTasks,
	filterTasksByProjectAndSource,
} from "../src/components/task-source-picker.helpers";

const SAMPLE_TASKS = [
	{ id: "1", projectId: "p1", source: "manual", status: "pending" },
	{ id: "2", projectId: "p1", source: "linear", status: "pending" },
	{ id: "3", projectId: "p2", source: "github", status: "completed" },
	{ id: "4", projectId: "p1", source: "github", status: "pending" },
] as const;

describe("task source picker helpers", () => {
	it("filters tasks by source across all projects", () => {
		expect(filterTasksByProjectAndSource(SAMPLE_TASKS, null, "github")).toEqual(
			[SAMPLE_TASKS[2], SAMPLE_TASKS[3]]
		);
	});

	it("filters tasks by project and source together", () => {
		expect(filterTasksByProjectAndSource(SAMPLE_TASKS, "p1", "linear")).toEqual(
			[SAMPLE_TASKS[1]]
		);
	});

	it("leaves manual tasks import-free even with an active project", () => {
		expect(canImportTasks("manual", "p1")).toBe(false);
	});

	it("requires a concrete project before importing external tasks", () => {
		expect(canImportTasks("github", null)).toBe(false);
		expect(canImportTasks("linear", "p1")).toBe(true);
	});
});
