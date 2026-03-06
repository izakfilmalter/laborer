/**
 * E2E Tests - Search Navigation
 *
 * Tests sidebar search filtering through the real UI and backend-backed
 * project/workspace state.
 *
 * Uses the temp git repository created by globalSetup.
 *
 * @see PRD-e2e-test-coverage.md - Issue 16
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "./fixtures/test-fixtures.js";

function getTempRepoDir(): string {
	const stateFile = join(tmpdir(), "laborer-e2e-state.json");
	const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
		readonly tempRepoDir: string;
	};
	return state.tempRepoDir;
}

test.describe("search navigation", () => {
	test("filters projects and workspaces in real time and restores them when cleared", async ({
		page,
		sidebar,
	}) => {
		const tempRepoDir = getTempRepoDir();
		const expectedProjectName = basename(tempRepoDir);
		const branchName = `e2e-search-${Date.now()}`;

		await page.goto("/?reset");

		const connectedStatus = page.getByText("connected", { exact: false });
		await expect(connectedStatus).toBeVisible({ timeout: 15_000 });

		const projectsHeading = page.getByRole("heading", { name: "Projects" });
		await expect(projectsHeading).toBeVisible();

		const repoPathInput = projectsHeading
			.locator("..")
			.getByLabel("Repository path");
		await repoPathInput.fill(tempRepoDir);

		await projectsHeading
			.locator("..")
			.getByRole("button", { name: "Add", exact: true })
			.click();

		const projectInSidebar = page.getByRole("button", {
			name: expectedProjectName,
			exact: true,
		});
		await expect(projectInSidebar).toBeVisible({ timeout: 10_000 });

		await page
			.getByRole("button", {
				name: `Create workspace in ${expectedProjectName}`,
			})
			.click();

		const createWorkspaceDialog = page.getByRole("heading", {
			name: "Create Workspace",
		});
		await expect(createWorkspaceDialog).toBeVisible({ timeout: 10_000 });

		await page
			.getByRole("textbox", { name: "Branch Name (optional)" })
			.fill(branchName);

		await page
			.getByRole("button", { name: "Create Workspace", exact: true })
			.click();

		const successToast = page.getByText("Workspace created on branch", {
			exact: false,
		});
		await expect(successToast).toBeVisible({ timeout: 30_000 });
		await expect(successToast).toContainText(branchName);
		await expect(createWorkspaceDialog).not.toBeVisible();

		const destroyWorkspaceButton = page.getByRole("button", {
			name: `Destroy workspace ${branchName}`,
		});
		await expect(destroyWorkspaceButton).toBeVisible({ timeout: 15_000 });

		await sidebar.search(branchName);
		await expect(sidebar.searchInput).toHaveValue(branchName);
		await expect(projectInSidebar).toBeVisible();
		await expect(destroyWorkspaceButton).toBeVisible();

		const noMatchesText = page.getByText("No matching projects or workspaces.");
		await sidebar.search("definitely-no-search-match");
		await expect(noMatchesText).toBeVisible();
		await expect(projectInSidebar).not.toBeVisible();
		await expect(destroyWorkspaceButton).not.toBeVisible();

		await sidebar.clearSearch();
		await expect(sidebar.searchInput).toHaveValue("");
		await expect(noMatchesText).not.toBeVisible();
		await expect(projectInSidebar).toBeVisible();
		await expect(destroyWorkspaceButton).toBeVisible();
	});
});
