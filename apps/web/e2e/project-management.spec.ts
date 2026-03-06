/**
 * E2E Tests — Project Management
 *
 * Tests the full add-project flow: enter repo path in the browser-mode
 * text input -> RPC mutation -> LiveStore sync -> sidebar rendering.
 *
 * Uses the temp git repository created by globalSetup.
 *
 * @see PRD-e2e-test-coverage.md — Issue 4
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
});
