/**
 * TerminalHelper — Convenience methods for terminal pane interactions.
 *
 * Provides helpers for typing commands and waiting for output in
 * terminal panes rendered via xterm.js.
 *
 * @see PRD-e2e-test-coverage.md — Page Object Pattern
 */

import { expect, type Locator, type Page } from '@playwright/test'

export class TerminalHelper {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /**
   * Get terminal pane containers.
   * xterm.js renders into elements with `data-terminal-id` attribute.
   */
  get terminalPanes(): Locator {
    return this.page.getByTestId('terminal-emulator')
  }

  /**
   * Get xterm.js's hidden textarea input elements.
   * xterm.js uses a hidden textarea for input capture.
   */
  get terminalInputs(): Locator {
    return this.page.getByTestId('terminal-emulator').locator('textarea')
  }

  /** Focus a terminal pane before typing. */
  async focusTerminal(index = 0): Promise<Locator> {
    const terminal = this.terminalPanes.nth(index)
    const focused = await terminal.evaluate((element) => {
      const xterm = Reflect.get(element, 'xterm') as
        | { focus(): void }
        | undefined
      if (!xterm) {
        return false
      }
      xterm.focus()
      return true
    })
    if (!focused) {
      throw new Error('Terminal xterm driver is unavailable')
    }
    return terminal
  }

  /**
   * Type a command into the focused terminal.
   * Uses keyboard.type for character-by-character input matching
   * how a real user types into an xterm.js terminal.
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

  /** Read the live xterm buffer, independent of its WebGL/canvas renderer. */
  bufferText(terminal = this.terminalPanes.first()): Promise<string> {
    return terminal.evaluate((element) => {
      const xterm = Reflect.get(element, 'xterm') as
        | {
            readonly buffer: {
              readonly active: {
                readonly length: number
                getLine(
                  index: number
                ): { translateToString(trimRight: boolean): string } | undefined
              }
            }
          }
        | undefined
      if (!xterm) {
        return ''
      }
      const lines: string[] = []
      for (let index = 0; index < xterm.buffer.active.length; index += 1) {
        lines.push(
          xterm.buffer.active.getLine(index)?.translateToString(true) ?? ''
        )
      }
      return lines.join('\n')
    })
  }
}
