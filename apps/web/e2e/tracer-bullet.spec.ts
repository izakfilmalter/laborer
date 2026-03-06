/**
 * Tracer Bullet E2E Test
 *
 * Proves the full Playwright infrastructure works end-to-end:
 * - Global setup started all 3 services
 * - WebKit browser can navigate to the app
 * - The app loads and renders its basic UI structure
 *
 * This is the foundational test — if this passes, the Playwright
 * infrastructure is working and other E2E tests can be built on top.
 *
 * @see PRD-e2e-test-coverage.md — Issue 3
 */

import { expect, test } from "./fixtures/test-fixtures.js";

test.describe("tracer bullet", () => {
	test("app loads and renders basic page structure", async ({ page }) => {
		// Navigate to the app (uses ?reset to clear OPFS state)
		await page.goto("/?reset");

		// Wait for the app to fully load — the "Home" navigation link
		// is rendered by the Header component in the root layout
		const homeLink = page.getByRole("link", { name: "Home" });
		await expect(homeLink).toBeVisible();

		// Verify the header is present with its controls
		const resetButton = page.getByRole("button", {
			name: "Reset persistence",
		});
		await expect(resetButton).toBeVisible();

		// Verify the sidebar structure is present
		// When no projects exist, we should see "Projects" heading and the
		// welcome empty state or "No projects" message
		const projectsHeading = page.getByRole("heading", { name: "Projects" });
		await expect(projectsHeading).toBeVisible();

		// Verify the server status section is present in the sidebar
		const serverStatusHeading = page.getByRole("heading", {
			name: "Server Status",
		});
		await expect(serverStatusHeading).toBeVisible();

		// Verify the server connects successfully (health check status shows "connected")
		const connectedStatus = page.getByText("connected", { exact: false });
		await expect(connectedStatus).toBeVisible({ timeout: 15_000 });
	});

	test("page title is set to laborer", async ({ page }) => {
		await page.goto("/");
		await expect(page).toHaveTitle("laborer");
	});
});
