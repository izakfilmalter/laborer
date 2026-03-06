import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EMPTY_STATE_TEXT =
	"Create a PRD through the MCP flow to track plan progress here.";

const { queryDbMock, useLaborerStoreMock } = vi.hoisted(() => ({
	queryDbMock: vi.fn((_table, options: { label: string }) => options),
	useLaborerStoreMock: vi.fn(),
}));

vi.mock("@livestore/livestore", () => ({
	queryDb: queryDbMock,
}));

vi.mock("@/livestore/store", () => ({
	useLaborerStore: useLaborerStoreMock,
}));

vi.mock("@laborer/shared/schema", () => ({
	prds: { name: "prds" },
	tasks: { name: "tasks" },
}));

import { PlanList } from "../src/components/plan-list";

describe("PlanList", () => {
	afterEach(() => {
		cleanup();
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders plans newest first with progress indicators", () => {
		useLaborerStoreMock.mockReturnValue({
			useQuery: (query: { label: string }) => {
				if (query.label === "planList.prds") {
					return [
						{
							id: "prd-1",
							projectId: "project-1",
							title: "Older plan",
							createdAt: "2026-03-05T10:00:00.000Z",
						},
						{
							id: "prd-2",
							projectId: "project-1",
							title: "Newest plan",
							createdAt: "2026-03-06T10:00:00.000Z",
						},
						{
							id: "prd-3",
							projectId: "project-2",
							title: "Other project plan",
							createdAt: "2026-03-07T10:00:00.000Z",
						},
					];
				}

				if (query.label === "planList.tasks") {
					return [
						{
							projectId: "project-1",
							source: "prd",
							prdId: "prd-1",
							status: "completed",
						},
						{
							projectId: "project-1",
							source: "prd",
							prdId: "prd-1",
							status: "pending",
						},
						{
							projectId: "project-1",
							source: "prd",
							prdId: "prd-2",
							status: "completed",
						},
						{
							projectId: "project-1",
							source: "github",
							prdId: "prd-2",
							status: "completed",
						},
					];
				}

				return [];
			},
		});

		const { container } = render(<PlanList projectId="project-1" />);

		expect(screen.getByText("Newest plan")).toBeTruthy();
		expect(screen.getByText("Older plan")).toBeTruthy();
		expect(screen.getByText("1/1 done")).toBeTruthy();
		expect(screen.getByText("1/2 done")).toBeTruthy();
		expect(screen.queryByText("Other project plan")).toBeNull();

		const titles = Array.from(
			container.querySelectorAll("p.font-medium.text-sm")
		).map((node) => node.textContent);
		expect(titles).toEqual(["Newest plan", "Older plan"]);
	});

	it("shows an empty state when the project has no plans", () => {
		useLaborerStoreMock.mockReturnValue({
			useQuery: () => [],
		});

		render(<PlanList projectId="project-1" />);

		expect(screen.getByText("No plans")).toBeTruthy();
		expect(screen.getByText(EMPTY_STATE_TEXT)).toBeTruthy();
	});

	it("collapses and re-expands the section", () => {
		useLaborerStoreMock.mockReturnValue({
			useQuery: (query: { label: string }) => {
				if (query.label === "planList.prds") {
					return [
						{
							id: "prd-1",
							projectId: "project-1",
							title: "Selected plan",
							createdAt: "2026-03-06T10:00:00.000Z",
						},
					];
				}

				return [];
			},
		});

		render(<PlanList projectId="project-1" />);

		expect(screen.getByText("Selected plan")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Plans" }));
		expect(screen.queryByText("Selected plan")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Plans" }));
		expect(screen.getByText("Selected plan")).toBeTruthy();
	});
});
