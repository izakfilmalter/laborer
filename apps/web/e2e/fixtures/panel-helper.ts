/**
 * PanelHelper — Convenience methods for panel/pane interactions.
 *
 * Provides locator-based helpers for splitting, closing, navigating,
 * and resizing panes in the panel system.
 *
 * @see PRD-e2e-test-coverage.md — Page Object Pattern
 */

import type { Locator, Page } from "@playwright/test";

export class PanelHelper {
	readonly page: Page;

	constructor(page: Page) {
		this.page = page;
	}

	/** Get the split-horizontal button. */
	get splitHorizontalButton(): Locator {
		return this.page.getByLabel("Split horizontally");
	}

	/** Get the split-vertical button. */
	get splitVerticalButton(): Locator {
		return this.page.getByLabel("Split vertically");
	}

	/** Get the close-pane button. */
	get closePaneButton(): Locator {
		return this.page.getByLabel("Close pane");
	}

	/** Get the terminal panels view toggle button. */
	get terminalPanelsButton(): Locator {
		return this.page.getByLabel("Terminal panels");
	}

	/** Get the dashboard view toggle button. */
	get dashboardButton(): Locator {
		return this.page.getByLabel("Dashboard");
	}

	/** Split the active pane horizontally. */
	async splitHorizontal(): Promise<void> {
		await this.splitHorizontalButton.click();
	}

	/** Split the active pane vertically. */
	async splitVertical(): Promise<void> {
		await this.splitVerticalButton.click();
	}

	/** Close the active pane. */
	async closePane(): Promise<void> {
		await this.closePaneButton.click();
	}

	/** Switch to the dashboard view. */
	async switchToDashboard(): Promise<void> {
		await this.dashboardButton.click();
	}

	/** Switch to the terminal panels view. */
	async switchToPanels(): Promise<void> {
		await this.terminalPanelsButton.click();
	}
}
