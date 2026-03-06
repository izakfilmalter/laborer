/**
 * TerminalHelper — Convenience methods for terminal pane interactions.
 *
 * Provides helpers for typing commands and waiting for output in
 * terminal panes rendered via xterm.js.
 *
 * @see PRD-e2e-test-coverage.md — Page Object Pattern
 */

import { expect, type Locator, type Page } from "@playwright/test";

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
		return this.page.locator("[data-terminal-id]");
	}

	/** Get xterm's accessible hidden textarea inputs. */
	get terminalInputs(): Locator {
		return this.page.getByRole("textbox", { name: "Terminal input" });
	}

	/** Focus a terminal pane before typing. */
	async focusTerminal(index = 0): Promise<Locator> {
		const terminalInput = this.terminalInputs.nth(index);
		if ((await terminalInput.count()) > 0) {
			await terminalInput.focus();
			return terminalInput;
		}

		const terminal = this.terminalPanes.nth(index);
		await terminal.click();
		return terminal;
	}

	/**
	 * Type a command into the focused terminal.
	 * Uses keyboard.type for character-by-character input matching
	 * how a real user types into an xterm.js terminal.
	 */
	async typeCommand(command: string, index = 0): Promise<void> {
		await this.focusTerminal(index);
		await this.page.keyboard.type(command);
		await this.page.keyboard.press("Enter");
	}

	/**
	 * Wait for specific text to appear in the terminal output.
	 * Uses a generous timeout since PTY initialization can be slow.
	 */
	async waitForOutput(text: string, timeoutMs = 10_000): Promise<Locator> {
		const output = this.page.getByText(text, { exact: false }).first();
		await expect(output).toBeVisible({
			timeout: timeoutMs,
		});
		return output;
	}
}
