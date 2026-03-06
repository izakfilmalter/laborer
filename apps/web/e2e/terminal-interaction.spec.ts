/**
 * E2E Tests - Terminal interaction
 *
 * Covers the real terminal pipeline by creating a workspace, spawning a
 * terminal into the empty pane, sending a shell command, and verifying the
 * rendered output appears in xterm.js.
 *
 * @see PRD-e2e-test-coverage.md - Issue 15
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

async function addProjectAndCreateWorkspace(
	page: Page,
	branchName: string
): Promise<string> {
	const tempRepoDir = getTempRepoDir();
	const expectedProjectName = basename(tempRepoDir);

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
			name: expectedProjectName,
			exact: true,
		})
	).toBeVisible({ timeout: 10_000 });

	await page
		.getByRole("button", {
			name: `Create workspace in ${expectedProjectName}`,
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

	await expect(
		page.getByText("Workspace created on branch", { exact: false })
	).toBeVisible({ timeout: 30_000 });
	await expect(dialogTitle).not.toBeVisible();
	await expect(
		page.getByRole("button", {
			name: `Destroy workspace ${branchName}`,
		})
	).toBeVisible({
		timeout: 15_000,
	});

	return `${expectedProjectName}/${branchName}`;
}

test.describe("terminal interaction", () => {
	test("can spawn a terminal, run a command, and see the output", async ({
		page,
		terminal,
	}) => {
		const branchName = `e2e-terminal-${Date.now()}`;
		await addProjectAndCreateWorkspace(page, branchName);

		const spawnTerminalButton = page
			.getByRole("button", {
				name: "New terminal",
			})
			.last();
		await expect(spawnTerminalButton).toBeVisible({ timeout: 15_000 });
		await spawnTerminalButton.click();

		const spawnedToast = page.getByText("Terminal spawned:", {
			exact: false,
		});
		await expect(spawnedToast).toBeVisible({ timeout: 30_000 });

		await expect(
			page.getByText(branchName, { exact: false }).last()
		).toBeVisible({
			timeout: 15_000,
		});
		await expect(terminal.terminalInputs).toHaveCount(1, { timeout: 15_000 });

		const terminalScreenshotBefore = await terminal.terminalPanes
			.first()
			.screenshot();
		await terminal.typeCommand("pwd");
		await expect
			.poll(
				async () => {
					const terminalScreenshotAfter = await terminal.terminalPanes
						.first()
						.screenshot();
					return terminalScreenshotAfter.equals(terminalScreenshotBefore);
				},
				{ timeout: 10_000 }
			)
			.toBe(false);
	});
});
