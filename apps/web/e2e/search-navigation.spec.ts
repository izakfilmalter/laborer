/**
 * E2E Tests - Search Navigation
 *
 * Tests sidebar search filtering through the real UI and backend-backed
 * project/workspace state.
 *
 * Uses the temp git repository created by globalSetup.
 *
 * @see PRD-e2e-test-coverage.md - Issues 16, 17, and 18
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/test-fixtures.js";

const DARK_CLASS_PATTERN = /dark/;

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
}> {
	const tempRepoDir = getTempRepoDir();
	const projectName = basename(tempRepoDir);
	const branchName = `e2e-search-${Date.now()}`;

	await page.goto("/?reset");
	await expect(page.getByText("connected", { exact: false })).toBeVisible({
		timeout: 15_000,
	});

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

	return { branchName, projectName };
}

test.describe("search navigation", () => {
	test("filters projects and workspaces in real time and restores them when cleared", async ({
		page,
		sidebar,
	}) => {
		const { branchName, projectName } =
			await addProjectAndCreateWorkspace(page);

		const projectInSidebar = page.getByRole("button", {
			name: projectName,
			exact: true,
		});
		await expect(projectInSidebar).toBeVisible({ timeout: 10_000 });

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

	test("can collapse a project group, keep it collapsed across reload, and expand it again", async ({
		page,
	}) => {
		const { branchName, projectName } =
			await addProjectAndCreateWorkspace(page);

		const projectToggle = page.getByRole("button", {
			name: projectName,
			exact: true,
		});
		const destroyWorkspaceButton = page.getByRole("button", {
			name: `Destroy workspace ${branchName}`,
		});

		await expect(projectToggle).toHaveAttribute("aria-expanded", "true");
		await expect(destroyWorkspaceButton).toBeVisible({ timeout: 15_000 });

		await projectToggle.click();

		await expect(projectToggle).toHaveAttribute("aria-expanded", "false");
		await expect(destroyWorkspaceButton).not.toBeVisible();

		await page.goto("/");
		await expect(page.getByText("connected", { exact: false })).toBeVisible({
			timeout: 15_000,
		});
		await expect(projectToggle).toBeVisible({ timeout: 10_000 });
		await expect(projectToggle).toHaveAttribute("aria-expanded", "false");
		await expect(destroyWorkspaceButton).not.toBeVisible();

		await projectToggle.click();

		await expect(projectToggle).toHaveAttribute("aria-expanded", "true");
		await expect(destroyWorkspaceButton).toBeVisible({ timeout: 15_000 });
	});

	test("can toggle the theme and restore the original mode", async ({
		page,
	}) => {
		await page.goto("/?reset");
		await expect(page.getByText("connected", { exact: false })).toBeVisible({
			timeout: 15_000,
		});

		const html = page.locator("html");
		const themeToggle = page.getByRole("button", { name: "Toggle theme" });
		const isDarkModeInitially = (await html.getAttribute("class"))?.includes(
			"dark"
		);

		const nextTheme = isDarkModeInitially ? "Light" : "Dark";
		const originalTheme = isDarkModeInitially ? "Dark" : "Light";

		await themeToggle.click();
		await page.getByRole("menuitem", { name: nextTheme, exact: true }).click();

		if (isDarkModeInitially) {
			await expect(html).not.toHaveClass(DARK_CLASS_PATTERN);
		} else {
			await expect(html).toHaveClass(DARK_CLASS_PATTERN);
		}

		await themeToggle.click();
		await page
			.getByRole("menuitem", { name: originalTheme, exact: true })
			.click();

		if (isDarkModeInitially) {
			await expect(html).toHaveClass(DARK_CLASS_PATTERN);
		} else {
			await expect(html).not.toHaveClass(DARK_CLASS_PATTERN);
		}
	});
});
