/**
 * Unit tests for getTerminalDisplay — the pure classification function
 * that determines what icon, label, and badge to show for each terminal
 * in the sidebar based on its foreground process.
 *
 * @see apps/web/src/components/terminal-list.tsx — getTerminalDisplay
 */

import { describe, expect, it } from 'vitest'
import { getTerminalDisplay } from '../src/components/terminal-list'

describe('getTerminalDisplay', () => {
  it('shows "stopped" badge for a stopped terminal', () => {
    const result = getTerminalDisplay('/bin/zsh', null, false)

    expect(result.label).toBe('/bin/zsh')
    expect(result.badgeLabel).toBe('stopped')
  })

  it('shows "idle" badge when shell is running with no foreground process', () => {
    const result = getTerminalDisplay('/bin/zsh', null, true)

    expect(result.label).toBe('/bin/zsh')
    expect(result.badgeLabel).toBe('idle')
  })

  it('falls back to "shell" label when command is empty', () => {
    const result = getTerminalDisplay('', null, true)

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
      true
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
      true
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
      true
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
      true
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
      true
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
      true
    )

    expect(result.label).toBe('my-custom-tool')
    expect(result.badgeLabel).toBe('running')
  })
})
