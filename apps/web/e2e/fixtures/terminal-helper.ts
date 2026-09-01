/**
 * TerminalHelper — Convenience methods for terminal pane interactions.
 *
 * Terminal panes render onto a canvas through the vendored Ghostty surface, so
 * there is nothing in the DOM to assert against. The pane publishes a narrow
 * test handle on its container in development builds — focus, and the visible
 * rows as text — and this helper is the only thing that reads it.
 *
 * @see apps/web/src/panes/terminal-pane.tsx — where the handle is installed
 * @see PRD-e2e-test-coverage.md — Page Object Pattern
 */

import { expect, type Locator, type Page } from '@playwright/test'

/** The development-only handle the terminal pane exposes on its container. */
interface GhosttyTestHandle {
  focus(): void
  text(): string
}

export class TerminalHelper {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /**
   * Get terminal pane containers.
   * The pane renders into an element with a `data-terminal-id` attribute.
   */
  get terminalPanes(): Locator {
    return this.page.getByTestId('terminal-emulator')
  }

  /**
   * Get the Ghostty surface's hidden textarea input elements.
   * The surface uses an off-screen textarea for key and IME capture.
   */
  get terminalInputs(): Locator {
    return this.page
      .getByTestId('terminal-emulator')
      .getByLabel('Terminal input')
  }

  /** Focus a terminal pane before typing. */
  async focusTerminal(index = 0): Promise<Locator> {
    const terminal = this.terminalPanes.nth(index)
    const focused = await terminal.evaluate((element) => {
      const ghostty = Reflect.get(element, 'ghostty') as
        | GhosttyTestHandle
        | undefined
      if (!ghostty) {
        return false
      }
      ghostty.focus()
      return true
    })
    if (!focused) {
      throw new Error('Terminal Ghostty driver is unavailable')
    }
    return terminal
  }

  /**
   * Type a command into the focused terminal.
   * Uses keyboard.type for character-by-character input matching
   * how a real user types into the terminal.
   */
  async typeCommand(command: string, index = 0): Promise<void> {
    await this.focusTerminal(index)
    await this.page.keyboard.type(command)
    await this.page.keyboard.press('Enter')
  }

  /**
   * Wait for specific text to appear in the terminal output.
   * Uses a generous timeout since PTY initialization can be slow.
   */
  async waitForOutput(text: string, timeoutMs = 10_000): Promise<Locator> {
    const terminal = this.terminalPanes.first()
    await expect
      .poll(() => this.bufferText(terminal), { timeout: timeoutMs })
      .toContain(text)
    return terminal
  }

  /**
   * Read the terminal's visible rows.
   *
   * Ghostty keeps its scrollback in WASM and only the painted viewport is
   * readable from the host, so this is the visible screen rather than the whole
   * buffer. Every assertion built on it checks output the command just
   * produced, which is on screen by definition.
   */
  bufferText(terminal = this.terminalPanes.first()): Promise<string> {
    return terminal.evaluate((element) => {
      const ghostty = Reflect.get(element, 'ghostty') as
        | GhosttyTestHandle
        | undefined
      return ghostty ? ghostty.text() : ''
    })
  }
}
