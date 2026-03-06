/**
 * E2E Tests - Panel system
 *
 * Covers the foundational panel-system flows through the real UI. The
 * tests create a workspace to seed the initial terminal pane, verify split
 * layout geometry, and confirm closing an active pane transfers focus to
 * the remaining sibling pane.
 *
 * @see PRD-e2e-test-coverage.md - Issues 11 and 12
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/test-fixtures.js";

interface PaneBox {
	readonly height: number;
	readonly width: number;
	readonly x: number;
	readonly y: number;
}

function getTempRepoDir(): string {
	const stateFile = join(tmpdir(), "laborer-e2e-state.json");
	const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
		readonly tempRepoDir: string;
	};
	return state.tempRepoDir;
}

async function addProjectAndCreateWorkspace(page: Page): Promise<void> {
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
		.getByRole("button", {
			name: "Create Workspace",
			exact: true,
		})
		.click();

	await expect(
		page.getByText("Workspace created on branch", { exact: false })
	).toBeVisible({ timeout: 30_000 });
	await expect(dialogTitle).not.toBeVisible();
}

async function getPaneBoxes(panes: Locator): Promise<readonly PaneBox[]> {
	const paneCount = await panes.count();
	const boxes: PaneBox[] = [];

	for (let index = 0; index < paneCount; index += 1) {
		const box = await panes.nth(index).boundingBox();
		if (!box) {
			throw new Error(`Pane ${index} did not have a bounding box`);
		}
		boxes.push(box);
	}

	return boxes;
}

function getRequiredPane(boxes: readonly PaneBox[], index: number): PaneBox {
	const pane = boxes[index];
	if (!pane) {
		throw new Error(`Missing pane box at index ${index}`);
	}
	return pane;
}

async function closeExtraPanes(
	panes: Locator,
	panels: { closePane: () => Promise<void> }
): Promise<void> {
	for (;;) {
		const paneCount = await panes.count();
		if (paneCount <= 1) {
			return;
		}

		await panes.nth(paneCount - 1).click();
		await panels.closePane();
		await expect(panes).toHaveCount(paneCount - 1, { timeout: 10_000 });
	}
}

test.describe("panel system", () => {
	test("can split panes horizontally and then vertically", async ({
		page,
		panels,
	}) => {
		await addProjectAndCreateWorkspace(page);

		const paneRegions = page.locator("[data-pane-id]");
		await expect(paneRegions).toHaveCount(1, { timeout: 15_000 });
		await expect(page.getByText("No terminal", { exact: true })).toBeVisible({
			timeout: 15_000,
		});

		await paneRegions.first().click();
		await panels.splitHorizontal();

		await expect(paneRegions).toHaveCount(2, { timeout: 10_000 });
		const horizontalBoxes = await getPaneBoxes(paneRegions);
		if (horizontalBoxes.length !== 2) {
			throw new Error(
				`Expected 2 panes after horizontal split, got ${horizontalBoxes.length}`
			);
		}
		const leftPane = getRequiredPane(horizontalBoxes, 0);
		const rightPane = getRequiredPane(horizontalBoxes, 1);

		expect(rightPane.x - leftPane.x).toBeGreaterThan(100);
		expect(Math.abs(leftPane.y - rightPane.y)).toBeLessThan(24);
		expect(Math.abs(leftPane.height - rightPane.height)).toBeLessThan(24);

		await paneRegions.nth(1).click();
		await panels.splitVertical();

		await expect(paneRegions).toHaveCount(3, { timeout: 10_000 });
		const nestedBoxes = await getPaneBoxes(paneRegions);
		if (nestedBoxes.length !== 3) {
			throw new Error(
				`Expected 3 panes after vertical split, got ${nestedBoxes.length}`
			);
		}
		const leftColumnPane = getRequiredPane(nestedBoxes, 0);
		const topRightPane = getRequiredPane(nestedBoxes, 1);
		const bottomRightPane = getRequiredPane(nestedBoxes, 2);

		expect(topRightPane.x - leftColumnPane.x).toBeGreaterThan(100);
		expect(Math.abs(topRightPane.x - bottomRightPane.x)).toBeLessThan(24);
		expect(bottomRightPane.y - topRightPane.y).toBeGreaterThan(50);
		expect(Math.abs(topRightPane.width - bottomRightPane.width)).toBeLessThan(
			24
		);
		expect(leftColumnPane.height).toBeGreaterThan(topRightPane.height + 100);
	});

	test("can close the active pane and keep focus on the remaining pane", async ({
		page,
		panels,
	}) => {
		await addProjectAndCreateWorkspace(page);

		const paneRegions = page.locator("[data-pane-id]");
		await expect(paneRegions.first()).toBeVisible({ timeout: 15_000 });
		await closeExtraPanes(paneRegions, panels);
		await expect(paneRegions).toHaveCount(1, { timeout: 10_000 });

		await paneRegions.first().click();
		await panels.splitHorizontal();

		await expect(paneRegions).toHaveCount(2, { timeout: 10_000 });

		const originalPaneId = await paneRegions
			.first()
			.getAttribute("data-pane-id");
		const siblingPane = paneRegions.nth(1);
		const siblingPaneId = await siblingPane.getAttribute("data-pane-id");
		if (!(originalPaneId && siblingPaneId)) {
			throw new Error("Expected both panes to expose data-pane-id attributes");
		}

		await siblingPane.click();
		await panels.closePane();

		await expect(paneRegions).toHaveCount(1, { timeout: 10_000 });
		await expect(page.locator(`[data-pane-id="${siblingPaneId}"]`)).toHaveCount(
			0
		);
		await expect(
			page.locator(`[data-pane-id="${originalPaneId}"]`)
		).toBeVisible();

		await panels.splitVertical();

		await expect(paneRegions).toHaveCount(2, { timeout: 10_000 });
	});
});
