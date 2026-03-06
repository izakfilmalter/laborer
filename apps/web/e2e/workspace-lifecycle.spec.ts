/**
 * E2E Tests — Workspace Lifecycle
 *
 * Tests workspace lifecycle flows: create and destroy workspaces via the
 * per-project "+" button dialog, verify the workspace cards appear in the
 * sidebar with their branch names and status badges, and confirm removal.
 *
 * All tests exercise the full stack: browser UI -> RPC mutation -> backend
 * (worktree creation, port allocation, setup scripts) -> LiveStore sync
 * -> UI re-render.
 *
 * Uses the temp git repository created by globalSetup.
 *
 * @see PRD-e2e-test-coverage.md — Issues 8, 9, 10
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "./fixtures/test-fixtures.js";

/**
 * Read the temp repo path from the global setup state file.
 * The state file is written by globalSetup.ts and contains
 * the path to the temp git repo created for testing.
 */
function getTempRepoDir(): string {
	const stateFile = join(tmpdir(), "laborer-e2e-state.json");
	const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
		readonly tempRepoDir: string;
	};
	return state.tempRepoDir;
}

test.describe("workspace lifecycle", () => {
	test("can create a workspace and see it in the sidebar", async ({ page }) => {
		const tempRepoDir = getTempRepoDir();
		const expectedProjectName = basename(tempRepoDir);

		// Navigate to the app with reset to clear any stale OPFS state
		await page.goto("/?reset");

		// Wait for the app to be fully loaded — server must be connected
		const connectedStatus = page.getByText("connected", { exact: false });
		await expect(connectedStatus).toBeVisible({ timeout: 15_000 });

		// --- Step 1: Add a project so there's something to create a workspace for ---
		const projectsHeading = page.getByRole("heading", { name: "Projects" });
		await expect(projectsHeading).toBeVisible();

		const sidebarForm = projectsHeading
			.locator("..")
			.getByLabel("Repository path");
		await expect(sidebarForm).toBeVisible();
		await sidebarForm.fill(tempRepoDir);

		const addButton = projectsHeading
			.locator("..")
			.getByRole("button", { name: "Add", exact: true });
		await addButton.click();

		// Wait for the project to appear in the sidebar
		const projectInSidebar = page.getByRole("button", {
			name: expectedProjectName,
			exact: true,
		});
		await expect(projectInSidebar).toBeVisible({ timeout: 10_000 });

		// --- Step 2: Click the per-project "+" button to open the Create Workspace dialog ---
		const createWorkspaceButton = page.getByRole("button", {
			name: `Create workspace in ${expectedProjectName}`,
		});
		await createWorkspaceButton.click();

		// Wait for the Create Workspace dialog to appear.
		// Use getByRole("heading") to target the dialog title specifically,
		// since "Create Workspace" also appears as a submit button label.
		const dialogTitle = page.getByRole("heading", {
			name: "Create Workspace",
		});
		await expect(dialogTitle).toBeVisible({ timeout: 10_000 });

		// --- Step 3: Verify the project is pre-selected and submit the form ---
		// The project should be pre-selected because we used the per-project "+" button
		// (defaultProjectId is set). Leave branch name empty to auto-generate.

		// Click the "Create Workspace" submit button
		const submitButton = page.getByRole("button", {
			name: "Create Workspace",
			exact: true,
		});
		await submitButton.click();

		// Wait for the "Creating..." state, then the success toast.
		// Workspace creation involves worktree creation, port allocation, and
		// potentially setup scripts, so give it a generous timeout.
		const successToast = page.getByText("Workspace created on branch", {
			exact: false,
		});
		await expect(successToast).toBeVisible({ timeout: 30_000 });

		// --- Step 4: Verify the workspace card appears in the sidebar ---
		// After creation, the dialog closes and the workspace should appear
		// under the project group in the sidebar. The workspace card shows
		// the branch name and a status badge.

		// The dialog should close on success
		await expect(dialogTitle).not.toBeVisible();

		// The workspace card should show a status badge (running or creating)
		// Look for the status badge within the sidebar — workspace status
		// transitions from "creating" to "running" once setup completes.
		// We check for "running" since the success toast only fires after
		// the workspace is fully created.
		const runningBadge = page.getByText("running", { exact: true }).first();
		await expect(runningBadge).toBeVisible({ timeout: 15_000 });

		// The "No workspaces" empty state should no longer be visible
		// since we now have an active workspace
		const noWorkspacesText = page.getByText("No workspaces");
		await expect(noWorkspacesText).not.toBeVisible();
	});

	test("shows the created workspace branch name and running status in the sidebar", async ({
		page,
	}) => {
		const tempRepoDir = getTempRepoDir();
		const expectedProjectName = basename(tempRepoDir);
		const branchName = `e2e-branch-${Date.now()}`;

		await page.goto("/?reset");

		const connectedStatus = page.getByText("connected", { exact: false });
		await expect(connectedStatus).toBeVisible({ timeout: 15_000 });

		const projectsHeading = page.getByRole("heading", { name: "Projects" });
		await expect(projectsHeading).toBeVisible();

		const sidebarForm = projectsHeading
			.locator("..")
			.getByLabel("Repository path");
		await sidebarForm.fill(tempRepoDir);

		const addButton = projectsHeading
			.locator("..")
			.getByRole("button", { name: "Add", exact: true });
		await addButton.click();

		const projectInSidebar = page.getByRole("button", {
			name: expectedProjectName,
			exact: true,
		});
		await expect(projectInSidebar).toBeVisible({ timeout: 10_000 });

		const createWorkspaceButton = page.getByRole("button", {
			name: `Create workspace in ${expectedProjectName}`,
		});
		await createWorkspaceButton.click();

		const dialogTitle = page.getByRole("heading", {
			name: "Create Workspace",
		});
		await expect(dialogTitle).toBeVisible({ timeout: 10_000 });

		const branchNameInput = page.getByRole("textbox", {
			name: "Branch Name (optional)",
		});
		await branchNameInput.fill(branchName);

		const submitButton = page.getByRole("button", {
			name: "Create Workspace",
			exact: true,
		});
		await submitButton.click();

		const successToast = page.getByText("Workspace created on branch", {
			exact: false,
		});
		await expect(successToast).toBeVisible({ timeout: 30_000 });
		await expect(successToast).toContainText(branchName);

		await expect(dialogTitle).not.toBeVisible();

		await expect(page.getByText(branchName, { exact: true })).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			page.getByRole("button", {
				name: `Destroy workspace ${branchName}`,
			})
		).toBeVisible({ timeout: 15_000 });
		await expect(
			page.getByText("running", { exact: true }).first()
		).toBeVisible({
			timeout: 15_000,
		});
	});

	test("can destroy a workspace and verify it disappears from the sidebar", async ({
		page,
	}) => {
		const tempRepoDir = getTempRepoDir();
		const expectedProjectName = basename(tempRepoDir);
		const branchName = `e2e-destroy-${Date.now()}`;

		await page.goto("/?reset");

		const connectedStatus = page.getByText("connected", { exact: false });
		await expect(connectedStatus).toBeVisible({ timeout: 15_000 });

		const projectsHeading = page.getByRole("heading", { name: "Projects" });
		await expect(projectsHeading).toBeVisible();

		const sidebarForm = projectsHeading
			.locator("..")
			.getByLabel("Repository path");
		await sidebarForm.fill(tempRepoDir);

		const addButton = projectsHeading
			.locator("..")
			.getByRole("button", { name: "Add", exact: true });
		await addButton.click();

		const projectInSidebar = page.getByRole("button", {
			name: expectedProjectName,
			exact: true,
		});
		await expect(projectInSidebar).toBeVisible({ timeout: 10_000 });

		const createWorkspaceButton = page.getByRole("button", {
			name: `Create workspace in ${expectedProjectName}`,
		});
		await createWorkspaceButton.click();

		const dialogTitle = page.getByRole("heading", {
			name: "Create Workspace",
		});
		await expect(dialogTitle).toBeVisible({ timeout: 10_000 });

		const branchNameInput = page.getByRole("textbox", {
			name: "Branch Name (optional)",
		});
		await branchNameInput.fill(branchName);

		const submitButton = page.getByRole("button", {
			name: "Create Workspace",
			exact: true,
		});
		await submitButton.click();

		const successToast = page.getByText("Workspace created on branch", {
			exact: false,
		});
		await expect(successToast).toBeVisible({ timeout: 30_000 });
		await expect(successToast).toContainText(branchName);

		await expect(dialogTitle).not.toBeVisible();

		const workspaceBranch = page.getByText(branchName, { exact: true });
		await expect(workspaceBranch).toBeVisible({ timeout: 15_000 });

		const destroyWorkspaceButton = page.getByRole("button", {
			name: `Destroy workspace ${branchName}`,
		});
		await expect(destroyWorkspaceButton).toBeVisible({ timeout: 15_000 });
		await destroyWorkspaceButton.click();

		const destroyDialogTitle = page.getByRole("heading", {
			name: "Destroy workspace?",
		});
		await expect(destroyDialogTitle).toBeVisible({ timeout: 10_000 });

		const confirmDestroyButton = page.getByRole("button", {
			name: "Destroy",
			exact: true,
		});
		await confirmDestroyButton.click();

		await expect(destroyDialogTitle).not.toBeVisible({ timeout: 30_000 });
		await expect(workspaceBranch).not.toBeVisible({ timeout: 30_000 });
		await expect(destroyWorkspaceButton).not.toBeVisible({ timeout: 30_000 });
	});
});
