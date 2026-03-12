/**
 * Unit tests for getTerminalDisplay — the pure classification function
 * that determines what icon, label, and badge to show for each terminal
 * in the sidebar based on its foreground process and agent status.
 *
 * @see apps/web/src/components/terminal-list.tsx — getTerminalDisplay
 */

import { describe, expect, it } from 'vitest'
import { getTerminalDisplay } from '../src/components/terminal-list'

describe('getTerminalDisplay', () => {
  it('shows "stopped" badge for a stopped terminal', () => {
    const result = getTerminalDisplay('/bin/zsh', null, false, null)

    expect(result.label).toBe('/bin/zsh')
    expect(result.badgeLabel).toBe('stopped')
  })

  it('shows "idle" badge when shell is running with no foreground process', () => {
    const result = getTerminalDisplay('/bin/zsh', null, true, null)

    expect(result.label).toBe('/bin/zsh')
    expect(result.badgeLabel).toBe('idle')
  })

  it('falls back to "shell" label when command is empty', () => {
    const result = getTerminalDisplay('', null, true, null)

    expect(result.label).toBe('shell')
    expect(result.badgeLabel).toBe('idle')
  })

  it('shows "agent" badge with process label for a known AI agent', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      {
        category: 'agent',
        label: 'Claude',
        rawName: 'claude',
      },
      true,
      'active'
    )

    expect(result.label).toBe('Claude')
    expect(result.badgeLabel).toBe('agent')
  })

  it('shows "agent" badge for an agent without a dedicated icon', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      {
        category: 'agent',
        label: 'Aider',
        rawName: 'aider',
      },
      true,
      'active'
    )

    expect(result.label).toBe('Aider')
    expect(result.badgeLabel).toBe('agent')
  })

  it('shows "editor" badge for an editor process', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      {
        category: 'editor',
        label: 'Neovim',
        rawName: 'nvim',
      },
      true,
      null
    )

    expect(result.label).toBe('Neovim')
    expect(result.badgeLabel).toBe('editor')
  })

  it('shows "running" badge for a dev server process', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      {
        category: 'devServer',
        label: 'Node.js',
        rawName: 'node',
      },
      true,
      null
    )

    expect(result.label).toBe('Node.js')
    expect(result.badgeLabel).toBe('running')
  })

  it('shows "idle" badge when foreground process is a shell', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      {
        category: 'shell',
        label: 'zsh',
        rawName: 'zsh',
      },
      true,
      null
    )

    expect(result.label).toBe('/bin/zsh')
    expect(result.badgeLabel).toBe('idle')
  })

  it('shows "running" badge for an unknown process with raw name as label', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      {
        category: 'unknown',
        label: 'my-custom-tool',
        rawName: 'my-custom-tool',
      },
      true,
      null
    )

    expect(result.label).toBe('my-custom-tool')
    expect(result.badgeLabel).toBe('running')
  })

  // -------------------------------------------------------------------------
  // Agent status: waiting_for_input
  // -------------------------------------------------------------------------

  it('shows "needs input" badge when agent status is waiting_for_input', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      null,
      true,
      'waiting_for_input'
    )

    expect(result.badgeLabel).toBe('needs input')
    expect(result.badgeClassName).toContain('animate-pulse')
  })

  it('uses the command name as label when waiting_for_input with no foreground process', () => {
    const result = getTerminalDisplay('claude', null, true, 'waiting_for_input')

    expect(result.label).toBe('claude')
    expect(result.badgeLabel).toBe('needs input')
  })

  it('does not show needs-input badge for active agents', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      {
        category: 'agent',
        label: 'Claude',
        rawName: 'claude',
      },
      true,
      'active'
    )

    expect(result.badgeLabel).toBe('agent')
    expect(result.badgeClassName).not.toContain('animate-pulse')
  })

  it('does not show needs-input for stopped terminals even with waiting status', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      null,
      false,
      'waiting_for_input'
    )

    expect(result.badgeLabel).toBe('stopped')
  })
})
