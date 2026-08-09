/**
 * PanelHelper — Convenience methods for panel/pane interactions.
 *
 * Uses keyboard shortcuts instead of clicking toolbar buttons, since the
 * split/close buttons are in a hover-only overlay toolbar (opacity-0 until
 * group-hover). Keyboard shortcuts are more reliable in e2e tests.
 *
 * Split shortcuts show a PanelTypePicker dialog — we press the number key
 * for the desired pane type (1=Agent, 2=Terminal, 3=Diff).
 *
 * @see apps/web/src/panels/panel-hotkeys.tsx — Keyboard shortcut definitions
 * @see apps/web/src/components/ui/panel-type-picker.tsx — Type picker
 * @see PRD-e2e-test-coverage.md — Page Object Pattern
 */

import { expect, type Locator, type Page } from '@playwright/test'

export class PanelHelper {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /**
   * Blur the terminal by clicking the sidebar status bar and pressing Escape.
   * This ensures xterm.js doesn't swallow subsequent keyboard shortcuts.
   */
  private async blurTerminal(): Promise<void> {
    await this.page.getByText('Server', { exact: true }).click({ force: true })
    await this.page.keyboard.press('Escape')
  }

  /** Get the terminal panels view toggle button. */
  get terminalPanelsButton(): Locator {
    return this.page.getByRole('button', {
      name: 'Terminal panels',
      exact: true,
    })
  }

  /** Get the dashboard view toggle button. */
  get dashboardButton(): Locator {
    return this.page.getByRole('button', {
      name: 'Dashboard',
      exact: true,
    })
  }

  /**
   * Split the active pane horizontally (side-by-side) with a Terminal pane.
   *
   * Uses Ctrl+B then H to trigger the type picker, then presses "2" to
   * select Terminal from the picker.
   */
  async splitHorizontal(): Promise<void> {
    // Retry the Ctrl+B sequence if the type picker doesn't appear.
    // Click the sidebar status bar to blur xterm.js before each attempt,
    // preventing the terminal from swallowing the Ctrl+B keystroke.
    const picker = this.page.locator('[data-testid="panel-type-picker"]')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.blurTerminal()
      await this.page.keyboard.press('Control+b')
      await this.page.keyboard.press('h')
      try {
        await picker.waitFor({ state: 'visible', timeout: 2000 })
        break
      } catch {
        // Picker didn't appear — retry
      }
    }
    await expect(picker).toBeVisible({ timeout: 2000 })
    await this.page.keyboard.press('2')
  }

  /**
   * Split the active pane vertically (stacked) with a Terminal pane.
   *
   * Uses Ctrl+B then V to trigger the type picker, then presses "2" to
   * select Terminal from the picker.
   */
  async splitVertical(): Promise<void> {
    // Retry the Ctrl+B sequence if the type picker doesn't appear.
    // Click the sidebar status bar to blur xterm.js before each attempt.
    const picker = this.page.locator('[data-testid="panel-type-picker"]')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.blurTerminal()
      await this.page.keyboard.press('Control+b')
      await this.page.keyboard.press('v')
      try {
        await picker.waitFor({ state: 'visible', timeout: 2000 })
        break
      } catch {
        // Picker didn't appear — retry
      }
    }
    await expect(picker).toBeVisible({ timeout: 2000 })
    await this.page.keyboard.press('2')
  }

  /**
   * Close the active pane.
   *
   * Uses Ctrl+B then X (progressive close — same as Cmd+W).
   */
  async closePane(): Promise<void> {
    // Don't call blurTerminal() here — clicking the sidebar would change
    // which pane is active. Just press Escape to blur xterm.js, keeping
    // the target pane focused for Ctrl+B + X.
    await this.page.keyboard.press('Escape')
    await this.page.keyboard.press('Control+b')
    await this.page.keyboard.press('x')
  }

  /** Run a tmux-style Ctrl+B panel shortcut sequence. */
  async runShortcut(actionKey: string): Promise<void> {
    await this.blurTerminal()
    await this.page.keyboard.press('Control+b')
    await this.page.keyboard.press(actionKey)
  }

  /** Move focus to an adjacent pane with Ctrl+B then arrow key. */
  async navigate(direction: 'left' | 'right' | 'up' | 'down'): Promise<void> {
    const actionKeyByDirection = {
      left: 'ArrowLeft',
      right: 'ArrowRight',
      up: 'ArrowUp',
      down: 'ArrowDown',
    } as const

    await this.runShortcut(actionKeyByDirection[direction])
  }

  /** Resize the active pane with Ctrl+B then Shift+arrow key. */
  async resize(direction: 'left' | 'right' | 'up' | 'down'): Promise<void> {
    const actionKeyByDirection = {
      left: 'ArrowLeft',
      right: 'ArrowRight',
      up: 'ArrowUp',
      down: 'ArrowDown',
    } as const

    await this.blurTerminal()
    await this.page.keyboard.press('Control+b')
    await this.page.keyboard.down('Shift')
    await this.page.keyboard.press(actionKeyByDirection[direction])
    await this.page.keyboard.up('Shift')
  }

  /** Switch to the dashboard view. */
  async switchToDashboard(): Promise<void> {
    await this.dashboardButton.click()
  }

  /** Switch to the terminal panels view. */
  async switchToPanels(): Promise<void> {
    await this.terminalPanelsButton.click()
  }
}
