/**
 * TerminalHelper — Convenience methods for terminal pane interactions.
 *
 * Provides helpers for typing commands and waiting for output in
 * terminal panes rendered via xterm.js.
 *
 * @see PRD-e2e-test-coverage.md — Page Object Pattern
 */

import type { Locator, Page } from "@playwright/test";

export class TerminalHelper {
	readonly page: Page;

	constructor(page: Page) {
		this.page = page;
	}

	/**
	 * Get terminal pane containers.
	 * xterm.js renders into elements with class "xterm".
	 */
	get terminalPanes(): Locator {
		return this.page.locator(".xterm");
	}

	/**
	 * Type a command into the focused terminal.
	 * Uses keyboard.type for character-by-character input matching
	 * how a real user types into an xterm.js terminal.
	 */
	async typeCommand(command: string): Promise<void> {
		await this.page.keyboard.type(command);
		await this.page.keyboard.press("Enter");
	}

	/**
	 * Wait for specific text to appear in the terminal output.
	 * Uses a generous timeout since PTY initialization can be slow.
	 */
	async waitForOutput(text: string, timeoutMs = 10_000): Promise<Locator> {
		const terminal = this.terminalPanes.first();
		await terminal.getByText(text, { exact: false }).waitFor({
			timeout: timeoutMs,
		});
		return terminal;
	}
}
