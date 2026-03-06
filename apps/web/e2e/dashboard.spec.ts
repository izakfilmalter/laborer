/**
 * E2E Tests - Dashboard
 *
 * Covers the cross-project dashboard summary flow through the real UI by
 * creating a project and workspace, switching to the dashboard, verifying
 * the overview and project section render, checking workspace status badges,
 * and then switching back to the terminal panel view.
 *
 * @see PRD-e2e-test-coverage.md - Issues 19 and 20
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/test-fixtures.js";

function getTempRepoDir(): string {
	const stateFile = join(tmpdir(), "laborer-e2e-state.json");
	const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
		readonly tempRepoDir: string;
	};
	return state.tempRepoDir;
}

async function addProjectAndCreateWorkspace(page: Page): Promise<{
	readonly branchName: string;
	readonly projectName: string;
	readonly repoPath: string;
}> {
	const repoPath = getTempRepoDir();
	const projectName = basename(repoPath);
	const branchName = `e2e-dashboard-${Date.now()}`;

	await page.goto("/?reset");
	await expect(page.getByText("connected", { exact: false })).toBeVisible({
		timeout: 15_000,
	});

	const projectsHeading = page.getByRole("heading", { name: "Projects" });
	await expect(projectsHeading).toBeVisible();

	const repoPathInput = projectsHeading
		.locator("..")
		.getByLabel("Repository path");
	await repoPathInput.fill(repoPath);

	await projectsHeading
		.locator("..")
		.getByRole("button", { name: "Add", exact: true })
		.click();

	await expect(
		page.getByRole("button", {
			name: projectName,
			exact: true,
		})
	).toBeVisible({ timeout: 10_000 });

	await page
		.getByRole("button", {
			name: `Create workspace in ${projectName}`,
		})
		.click();

	const dialogTitle = page.getByRole("heading", {
		name: "Create Workspace",
	});
	await expect(dialogTitle).toBeVisible({ timeout: 10_000 });

	await page
		.getByRole("textbox", { name: "Branch Name (optional)" })
		.fill(branchName);

	await page
		.getByRole("button", {
			name: "Create Workspace",
			exact: true,
		})
		.click();

	const successToast = page.getByText("Workspace created on branch", {
		exact: false,
	});
	await expect(successToast).toBeVisible({ timeout: 30_000 });
	await expect(successToast).toContainText(branchName);
	await expect(dialogTitle).not.toBeVisible();

	return { branchName, projectName, repoPath };
}

function getProjectDashboardCard(page: Page, repoPath: string) {
	return page
		.locator('[data-slot="card"]')
		.filter({ has: page.getByText(repoPath, { exact: true }) });
}

test.describe("dashboard", () => {
	test("can switch to the dashboard and see the cross-project summary", async ({
		page,
		panels,
	}) => {
		const { branchName, projectName, repoPath } =
			await addProjectAndCreateWorkspace(page);

		const paneRegions = page.locator("[data-pane-id]");
		await expect(paneRegions).toHaveCount(1, { timeout: 15_000 });

		await panels.switchToDashboard();

		await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({
			timeout: 10_000,
		});
		await expect(page.getByText("1 project", { exact: true })).toBeVisible();

		const projectCard = getProjectDashboardCard(page, repoPath);
		await expect(projectCard).toHaveCount(1);
		await expect(
			projectCard.getByText(projectName, { exact: true })
		).toBeVisible();
		await expect(
			projectCard.getByText(repoPath, { exact: true })
		).toBeVisible();
		await expect(
			projectCard.getByText(branchName, { exact: true })
		).toBeVisible();

		await panels.switchToPanels();

		await expect(paneRegions).toHaveCount(1, { timeout: 10_000 });
		await expect(paneRegions.first()).toBeVisible();
	});

	test("shows workspace status badges in the dashboard", async ({
		page,
		panels,
	}) => {
		const { branchName, repoPath } = await addProjectAndCreateWorkspace(page);

		await panels.switchToDashboard();

		const projectCard = getProjectDashboardCard(page, repoPath);
		await expect(projectCard).toHaveCount(1);

		const workspaceRow = projectCard
			.locator("div")
			.filter({
				has: page.getByText(branchName, { exact: true }),
				hasText: "running",
			})
			.first();
		await expect(
			workspaceRow.getByText(branchName, { exact: true })
		).toBeVisible();
		await expect(workspaceRow).toContainText("running");
	});
});
