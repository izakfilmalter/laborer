/**
 * Unit tests for getTerminalDisplay — the pure classification function
 * that determines what icon, label, and badge to show for each terminal
 * in the sidebar based on its foreground process and agent status.
 *
 * @see apps/web/src/components/terminal-list.tsx — getTerminalDisplay
 */

import { describe, expect, it } from 'vitest'
import { getTerminalDisplay } from '../src/components/terminal-list'

const status = (
  value: 'working' | 'needs_input' | 'idle' | 'unknown',
  stale = false
) => ({
  status: value,
  source: 'ps' as const,
  changedAt: 0,
  stale,
})

describe('getTerminalDisplay', () => {
  it.each([
    ['idle', 'idle'],
    ['unknown', 'unknown'],
  ] as const)('shows the semantic %s state', (agentState, label) => {
    const result = getTerminalDisplay('claude', null, true, status(agentState))

    expect(result.badgeLabel).toBe(label)
    expect(result.badgeTitle).toContain('ps')
  })

  it('dims stale status and explains its provenance', () => {
    const result = getTerminalDisplay(
      'claude',
      null,
      true,
      status('working', true)
    )

    expect(result.badgeClassName).toContain('opacity-50')
    expect(result.badgeTitle).toContain('detection stale')
  })

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
      status('working')
    )

    expect(result.label).toBe('Claude')
    expect(result.badgeLabel).toBe('working')
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
      status('working')
    )

    expect(result.label).toBe('Aider')
    expect(result.badgeLabel).toBe('working')
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
  // Agent status: needs_input
  // -------------------------------------------------------------------------

  it('shows "needs input" badge when agent status is needs_input', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      null,
      true,
      status('needs_input')
    )

    expect(result.badgeLabel).toBe('needs input')
    expect(result.badgeClassName).toContain('animate-pulse')
  })

  it('uses the agent display label when needs_input with no foreground process', () => {
    const result = getTerminalDisplay(
      'claude',
      null,
      true,
      status('needs_input')
    )

    expect(result.label).toBe('Claude')
    expect(result.badgeLabel).toBe('needs input')
  })

  it('does not show needs-input badge for working agents', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      {
        category: 'agent',
        label: 'Claude',
        rawName: 'claude',
      },
      true,
      status('working')
    )

    expect(result.badgeLabel).toBe('working')
    expect(result.badgeClassName).not.toContain('animate-pulse')
  })

  it('does not show needs-input for stopped terminals even with waiting status', () => {
    const result = getTerminalDisplay(
      '/bin/zsh',
      null,
      false,
      status('needs_input')
    )

    expect(result.badgeLabel).toBe('stopped')
  })

  // -------------------------------------------------------------------------
  // Process chain display
  // -------------------------------------------------------------------------

  it('shows root process label when chain has a single entry', () => {
    const opencode = {
      category: 'agent' as const,
      label: 'OpenCode',
      rawName: 'opencode',
    }
    const result = getTerminalDisplay(
      '/bin/zsh',
      opencode,
      true,
      status('working'),
      [opencode]
    )

    expect(result.label).toBe('OpenCode')
    expect(result.badgeLabel).toBe('working')
  })

  it('shows chain label with separator when agent spawns a subprocess', () => {
    const opencode = {
      category: 'agent' as const,
      label: 'OpenCode',
      rawName: 'opencode',
    }
    const biome = {
      category: 'unknown' as const,
      label: 'biome',
      rawName: 'biome',
    }
    const result = getTerminalDisplay('/bin/zsh', biome, true, null, [
      opencode,
      biome,
    ])

    expect(result.label).toBe('OpenCode \u203A biome')
    expect(result.badgeLabel).toBe('running')
  })

  it('shows multi-level chain label for deeply nested subprocesses', () => {
    const opencode = {
      category: 'agent' as const,
      label: 'OpenCode',
      rawName: 'opencode',
    }
    const node = {
      category: 'devServer' as const,
      label: 'Node.js',
      rawName: 'node',
    }
    const esbuild = {
      category: 'unknown' as const,
      label: 'esbuild',
      rawName: 'esbuild',
    }
    const result = getTerminalDisplay('/bin/zsh', esbuild, true, null, [
      opencode,
      node,
      esbuild,
    ])

    expect(result.label).toBe('OpenCode \u203A Node.js \u203A esbuild')
  })

  it('uses root process icon when chain has multiple entries', () => {
    const claude = {
      category: 'agent' as const,
      label: 'Claude',
      rawName: 'claude',
    }
    const biome = {
      category: 'unknown' as const,
      label: 'biome',
      rawName: 'biome',
    }
    // Badge comes from the deepest process (unknown -> running)
    const result = getTerminalDisplay('/bin/zsh', biome, true, null, [
      claude,
      biome,
    ])

    expect(result.label).toBe('Claude \u203A biome')
    expect(result.badgeLabel).toBe('running')
  })

  it('shows root process label when needs_input with a process chain', () => {
    const opencode = {
      category: 'agent' as const,
      label: 'OpenCode',
      rawName: 'opencode',
    }
    const result = getTerminalDisplay(
      '/bin/zsh',
      null,
      true,
      status('needs_input'),
      [opencode]
    )

    expect(result.label).toBe('OpenCode')
    expect(result.badgeLabel).toBe('needs input')
  })

  // -------------------------------------------------------------------------
  // Agent command fallback — branding when foregroundProcess is null
  // -------------------------------------------------------------------------

  it('shows agent icon and capitalised label for idle agent terminal', () => {
    const result = getTerminalDisplay('opencode', null, true, null)

    expect(result.label).toBe('OpenCode')
    expect(result.badgeLabel).toBe('idle')
  })

  it('shows agent label for stopped agent terminal', () => {
    const result = getTerminalDisplay('opencode', null, false, null)

    expect(result.label).toBe('OpenCode')
    expect(result.badgeLabel).toBe('stopped')
  })

  it('shows agent label when shell foreground process detected in agent terminal', () => {
    const result = getTerminalDisplay(
      'claude',
      {
        category: 'shell',
        label: 'zsh',
        rawName: 'zsh',
      },
      true,
      null
    )

    expect(result.label).toBe('Claude')
    expect(result.badgeLabel).toBe('idle')
  })

  it('does not use agent fallback for non-agent commands', () => {
    const result = getTerminalDisplay('/bin/zsh', null, true, null)

    expect(result.label).toBe('/bin/zsh')
    expect(result.badgeLabel).toBe('idle')
  })

  it('shows agent label when needs_input with no process chain', () => {
    const result = getTerminalDisplay(
      'opencode',
      null,
      true,
      status('needs_input')
    )

    expect(result.label).toBe('OpenCode')
    expect(result.badgeLabel).toBe('needs input')
  })
})
