/**
 * E2E Tests — Project Management
 *
 * Tests project lifecycle flows: add project, open/save settings, delete.
 * All tests exercise the full stack: browser UI -> RPC mutation -> backend
 * -> LiveStore sync -> UI re-render.
 *
 * Uses the temp git repository created by globalSetup.
 *
 * @see PRD-e2e-test-coverage.md — Issues 4, 5, 6
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

test.describe("project management", () => {
	test("can add a project and see it in the sidebar", async ({ page }) => {
		const tempRepoDir = getTempRepoDir();
		const expectedProjectName = basename(tempRepoDir);

		// Navigate to the app with reset to clear any stale OPFS state
		await page.goto("/?reset");

		// Wait for the app to be fully loaded — server must be connected
		const connectedStatus = page.getByText("connected", { exact: false });
		await expect(connectedStatus).toBeVisible({ timeout: 15_000 });

		// Locate the sidebar add-project form (text input + submit button).
		// When no projects exist, there are two AddProjectForm instances:
		// one in the sidebar next to the "Projects" heading, and one in the
		// WelcomeEmptyState. Scope to the sidebar by finding the form near
		// the "Projects" heading.
		const projectsHeading = page.getByRole("heading", { name: "Projects" });
		await expect(projectsHeading).toBeVisible();

		// The sidebar form is the sibling of the Projects heading
		const sidebarForm = projectsHeading
			.locator("..")
			.getByLabel("Repository path");
		await expect(sidebarForm).toBeVisible();

		// Enter the temp git repo path
		await sidebarForm.fill(tempRepoDir);

		// Click the Add button next to the input in the sidebar form
		const addButton = projectsHeading
			.locator("..")
			.getByRole("button", { name: "Add", exact: true });
		await addButton.click();

		// Wait for the success toast to appear confirming the project was added
		const successToast = page.getByText(
			`Project "${expectedProjectName}" added`
		);
		await expect(successToast).toBeVisible({ timeout: 10_000 });

		// Verify the project name appears in the sidebar as a collapsible group.
		// The CollapsibleTrigger has the project name as its exact accessible name.
		// Use exact: true to avoid matching other buttons that include the
		// project name (e.g., "Create workspace in <name>", "Remove project <name>").
		const projectInSidebar = page.getByRole("button", {
			name: expectedProjectName,
			exact: true,
		});
		await expect(projectInSidebar).toBeVisible();

		// Verify the input was cleared after successful submission
		await expect(sidebarForm).toHaveValue("");
	});

	test("can open project settings, modify a field, save, and verify persistence", async ({
		page,
	}) => {
		const tempRepoDir = getTempRepoDir();
		const expectedProjectName = basename(tempRepoDir);

		// Navigate to the app with reset to clear any stale OPFS state
		await page.goto("/?reset");

		// Wait for the app to be fully loaded — server must be connected
		const connectedStatus = page.getByText("connected", { exact: false });
		await expect(connectedStatus).toBeVisible({ timeout: 15_000 });

		// --- Step 1: Add a project so there's something to configure ---
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

		// --- Step 2: Open the project settings modal ---
		const settingsButton = page.getByRole("button", {
			name: `Open settings for ${expectedProjectName}`,
		});
		await settingsButton.click();

		// Wait for the settings form to load (async config.get RPC)
		const modalTitle = page.getByText("Project settings");
		await expect(modalTitle).toBeVisible({ timeout: 10_000 });

		// Wait for the loading spinner to disappear and form fields to appear
		const worktreeDirInput = page.getByRole("textbox", {
			name: "Worktree directory",
		});
		await expect(worktreeDirInput).toBeVisible({ timeout: 10_000 });

		// Read the initial value of the worktree directory field
		const initialWorktreeDir = await worktreeDirInput.inputValue();

		// --- Step 3: Modify the worktree directory field ---
		const newWorktreeDir = `/tmp/e2e-test-worktrees/${expectedProjectName}`;
		await worktreeDirInput.clear();
		await worktreeDirInput.fill(newWorktreeDir);

		// Verify the input shows the new value before saving
		await expect(worktreeDirInput).toHaveValue(newWorktreeDir);

		// --- Step 4: Save the settings ---
		const saveButton = page.getByRole("button", { name: "Save" });
		await saveButton.click();

		// Wait for the success toast
		const successToast = page.getByText(
			`Saved settings for ${expectedProjectName}`
		);
		await expect(successToast).toBeVisible({ timeout: 10_000 });

		// The dialog should close on successful save
		await expect(modalTitle).not.toBeVisible();

		// --- Step 5: Re-open settings and verify the saved value persists ---
		await settingsButton.click();

		// Wait for the form to load again
		const worktreeDirInputAgain = page.getByRole("textbox", {
			name: "Worktree directory",
		});
		await expect(worktreeDirInputAgain).toBeVisible({ timeout: 10_000 });

		// Verify the worktree directory shows the updated value, not the initial one
		await expect(worktreeDirInputAgain).toHaveValue(newWorktreeDir);
		expect(newWorktreeDir).not.toBe(initialWorktreeDir);
	});

	test("can delete a project and verify it disappears from the sidebar", async ({
		page,
	}) => {
		const tempRepoDir = getTempRepoDir();
		const expectedProjectName = basename(tempRepoDir);

		// Navigate to the app with reset to clear any stale OPFS state
		await page.goto("/?reset");

		// Wait for the app to be fully loaded — server must be connected
		const connectedStatus = page.getByText("connected", { exact: false });
		await expect(connectedStatus).toBeVisible({ timeout: 15_000 });

		// --- Step 1: Add a project so there's something to delete ---
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

		// --- Step 2: Click the delete/remove button for the project ---
		const removeButton = page.getByRole("button", {
			name: `Remove project ${expectedProjectName}`,
		});
		await removeButton.click();

		// --- Step 3: Confirm the deletion in the alert dialog ---
		const dialogTitle = page.getByText("Remove project?");
		await expect(dialogTitle).toBeVisible();

		const confirmButton = page.getByRole("button", { name: "Remove" });
		await confirmButton.click();

		// --- Step 4: Verify success toast ---
		const successToast = page.getByText(
			`Project "${expectedProjectName}" removed`
		);
		await expect(successToast).toBeVisible({ timeout: 10_000 });

		// --- Step 5: Verify the project is no longer in the sidebar ---
		await expect(projectInSidebar).not.toBeVisible();
	});
});
