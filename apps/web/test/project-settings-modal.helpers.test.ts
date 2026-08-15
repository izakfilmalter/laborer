import { describe, expect, it } from 'vitest'
import {
  buildConfigUpdates,
  getSettingsLoadErrorMessage,
  normalizeSetupScripts,
} from '../src/components/project-settings-modal.helpers'

describe('project settings modal helpers', () => {
  it('normalizes setup scripts by trimming and dropping empty values', () => {
    const result = normalizeSetupScripts([
      { id: '1', value: ' bun install ' },
      { id: '2', value: '' },
      { id: '3', value: '   ' },
      { id: '4', value: 'cp .env.example .env' },
    ])

    expect(result).toEqual(['bun install', 'cp .env.example .env'])
  })

  it('preserves special characters and long commands in setup scripts', () => {
    const longCommand =
      'bun x ultracite check && bun test --runInBand --reporter=verbose'
    const result = normalizeSetupScripts([
      { id: '1', value: 'bash -lc "echo $PATH && ls -la"' },
      { id: '2', value: longCommand },
    ])

    expect(result).toEqual(['bash -lc "echo $PATH && ls -la"', longCommand])
  })

  it('builds update payload with only changed config fields', () => {
    const result = buildConfigUpdates({
      agent: 'opencode2',
      resolvedConfig: {
        agent: 'claude',
        shortName: 'OLD',
        setupScripts: ['bun install'],
        worktreeDir: '/tmp/worktrees',
      },
      setupScripts: [
        { id: '1', value: 'bun install' },
        { id: '2', value: 'bun test' },
      ],
      shortName: 'lab',
      worktreeDir: '~/worktrees',
    })

    expect(result).toEqual({
      agent: 'opencode2',
      shortName: 'LAB',
      setupScripts: ['bun install', 'bun test'],
      worktreeDir: '~/worktrees',
    })
  })

  it('builds an OpenCode 2 agent update', () => {
    const result = buildConfigUpdates({
      agent: 'opencode2',
      resolvedConfig: {
        agent: 'claude',
        shortName: 'LAB',
        setupScripts: [],
        worktreeDir: '/tmp/worktrees',
      },
      setupScripts: [],
      shortName: 'LAB',
      worktreeDir: '/tmp/worktrees',
    })

    expect(result).toEqual({ agent: 'opencode2' })
  })

  it('returns empty updates when normalized values match resolved config', () => {
    const result = buildConfigUpdates({
      agent: 'claude',
      resolvedConfig: {
        agent: 'claude',
        shortName: 'LAB',
        setupScripts: ['bun install'],
        worktreeDir: '/tmp/worktrees',
      },
      setupScripts: [
        { id: '1', value: ' bun install ' },
        { id: '2', value: '' },
      ],
      shortName: ' lab ',
      worktreeDir: '   /tmp/worktrees ',
    })

    expect(result).toEqual({})
  })

  it('maps malformed laborer.json parse failures to user-friendly copy', () => {
    expect(
      getSettingsLoadErrorMessage(
        'Failed to parse /repo/laborer.json: Unexpected token } in JSON'
      )
    ).toBe(
      'Could not read laborer.json. Fix the JSON syntax and reopen project settings.'
    )
  })

  it('includes raw error message in fallback for unrecognized failures', () => {
    expect(getSettingsLoadErrorMessage('request timeout')).toBe(
      'Failed to load project settings: request timeout'
    )
  })
})
