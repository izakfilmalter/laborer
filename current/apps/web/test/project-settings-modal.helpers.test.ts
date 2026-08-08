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
      devServerImage: 'node:22',
      devServerInstallCommand: 'yarn install --frozen-lockfile',
      devServerNetwork: 'myproject_default',
      devServerProvider: null,
      devServerAutoOpen: true,
      devServerSetupScripts: [{ id: '1', value: 'apt-get install -y curl' }],
      devServerStartCommand: 'npm run dev',
      resolvedConfig: {
        agent: 'claude',
        devServerImage: 'node:lts',
        devServerInstallCommand: null,
        devServerNetwork: null,
        devServerProvider: null,
        devServerAutoOpen: false,
        devServerSetupScripts: ['corepack enable'],
        devServerStartCommand: null,
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
      agent: 'opencode2',
      devServer: {
        image: 'node:22',
        installCommand: 'yarn install --frozen-lockfile',
        network: 'myproject_default',
        autoOpen: true,
        setupScripts: ['apt-get install -y curl'],
        startCommand: 'npm run dev',
      },
      setupScripts: ['bun install', 'bun test'],
      worktreeDir: '~/worktrees',
    })
  })

  it('builds an OpenCode 2 agent update', () => {
    const result = buildConfigUpdates({
      agent: 'opencode2',
      devServerImage: '',
      devServerInstallCommand: '',
      devServerNetwork: '',
      devServerProvider: null,
      devServerAutoOpen: false,
      devServerSetupScripts: [],
      devServerStartCommand: '',
      resolvedConfig: {
        agent: 'claude',
        devServerImage: null,
        devServerInstallCommand: null,
        devServerNetwork: null,
        devServerProvider: null,
        devServerAutoOpen: false,
        devServerSetupScripts: [],
        devServerStartCommand: null,
        setupScripts: [],
        worktreeDir: '/tmp/worktrees',
      },
      setupScripts: [],
      worktreeDir: '/tmp/worktrees',
    })

    expect(result).toEqual({ agent: 'opencode2' })
  })

  it('returns empty updates when normalized values match resolved config', () => {
    const result = buildConfigUpdates({
      agent: 'claude',
      devServerImage: 'node:lts',
      devServerInstallCommand: '',
      devServerNetwork: '',
      devServerProvider: null,
      devServerAutoOpen: false,
      devServerSetupScripts: [
        { id: '1', value: ' corepack enable ' },
        { id: '2', value: '' },
      ],
      devServerStartCommand: '',
      resolvedConfig: {
        agent: 'claude',
        devServerImage: 'node:lts',
        devServerInstallCommand: null,
        devServerNetwork: null,
        devServerProvider: null,
        devServerAutoOpen: false,
        devServerSetupScripts: ['corepack enable'],
        devServerStartCommand: null,
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

  it('maps devServer mutual exclusion errors to user-friendly copy', () => {
    expect(
      getSettingsLoadErrorMessage(
        'devServer.image and devServer.dockerfile are mutually exclusive. image from /repo/laborer.json, dockerfile from /global/laborer.json'
      )
    ).toBe(
      'devServer.image and devServer.dockerfile cannot both be set. Remove one from your laborer.json.'
    )
  })

  it('includes raw error message in fallback for unrecognized failures', () => {
    expect(getSettingsLoadErrorMessage('request timeout')).toBe(
      'Failed to load project settings: request timeout'
    )
  })
})
