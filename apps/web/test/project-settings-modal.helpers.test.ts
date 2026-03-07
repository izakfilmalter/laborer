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
      devServerImage: 'node:22',
      devServerStartCommand: 'npm run dev',
      rlphConfig: '.rlph/config.toml',
      resolvedConfig: {
        devServerImage: 'oven/bun:latest',
        devServerStartCommand: null,
        rlphConfig: null,
        setupScripts: ['bun install'],
        worktreeDir: '/tmp/worktrees',
      },
      setupScripts: [
        { id: '1', value: 'bun install' },
        { id: '2', value: 'bun test' },
      ],
      worktreeDir: '~/worktrees',
    })

    expect(result).toEqual({
      devServer: {
        image: 'node:22',
        startCommand: 'npm run dev',
      },
      rlphConfig: '.rlph/config.toml',
      setupScripts: ['bun install', 'bun test'],
      worktreeDir: '~/worktrees',
    })
  })

  it('returns empty updates when normalized values match resolved config', () => {
    const result = buildConfigUpdates({
      devServerImage: 'oven/bun:latest',
      devServerStartCommand: '',
      rlphConfig: '  ',
      resolvedConfig: {
        devServerImage: 'oven/bun:latest',
        devServerStartCommand: null,
        rlphConfig: null,
        setupScripts: ['bun install'],
        worktreeDir: '/tmp/worktrees',
      },
      setupScripts: [
        { id: '1', value: ' bun install ' },
        { id: '2', value: '' },
      ],
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

  it('falls back to generic message for unrelated failures', () => {
    expect(getSettingsLoadErrorMessage('request timeout')).toBe(
      'Failed to load project settings.'
    )
  })
})
