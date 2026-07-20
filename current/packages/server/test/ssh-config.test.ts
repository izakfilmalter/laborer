/**
 * Tests for SSH config helpers — Issue 22
 *
 * Pure function tests for building, parsing, inserting, and removing
 * laborer-managed SSH config entries for Daytona sandboxes.
 */

import { describe, expect, it } from 'vitest'
import {
  buildHostAlias,
  buildSshConfigEntry,
  buildVsCodeRemoteCommand,
  DAYTONA_SSH_PORT,
  hasSshConfigEntry,
  MARKER_END_PREFIX,
  MARKER_PREFIX,
  removeSshConfigEntry,
  SSH_TOKEN_EXPIRY_MINUTES,
  SSH_TOKEN_REFRESH_MINUTES,
  upsertSshConfigEntry,
} from '../../server/src/lib/ssh-config.js'

describe('ssh-config helpers', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  describe('constants', () => {
    it('DAYTONA_SSH_PORT is 2222', () => {
      expect(DAYTONA_SSH_PORT).toBe(2222)
    })

    it('SSH_TOKEN_EXPIRY_MINUTES is 60', () => {
      expect(SSH_TOKEN_EXPIRY_MINUTES).toBe(60)
    })

    it('SSH_TOKEN_REFRESH_MINUTES is 45', () => {
      expect(SSH_TOKEN_REFRESH_MINUTES).toBe(45)
    })

    it('MARKER_PREFIX is "# laborer-managed:"', () => {
      expect(MARKER_PREFIX).toBe('# laborer-managed:')
    })

    it('MARKER_END_PREFIX is "# laborer-managed-end:"', () => {
      expect(MARKER_END_PREFIX).toBe('# laborer-managed-end:')
    })
  })

  // -----------------------------------------------------------------------
  // buildHostAlias
  // -----------------------------------------------------------------------

  describe('buildHostAlias', () => {
    it('builds laborer-{workspaceId} format', () => {
      expect(buildHostAlias('ws-abc-123')).toBe('laborer-ws-abc-123')
    })

    it('handles UUIDs', () => {
      expect(buildHostAlias('550e8400-e29b-41d4-a716-446655440000')).toBe(
        'laborer-550e8400-e29b-41d4-a716-446655440000'
      )
    })
  })

  // -----------------------------------------------------------------------
  // buildSshConfigEntry
  // -----------------------------------------------------------------------

  describe('buildSshConfigEntry', () => {
    it('builds a complete SSH config entry with markers', () => {
      const entry = buildSshConfigEntry('ws-1', 'my-token-xyz')
      expect(entry).toBe(
        [
          '# laborer-managed: ws-1',
          'Host laborer-ws-1',
          '  HostName ssh.app.daytona.io',
          '  Port 2222',
          '  User my-token-xyz',
          '  StrictHostKeyChecking no',
          '  UserKnownHostsFile /dev/null',
          '# laborer-managed-end: ws-1',
          '',
        ].join('\n')
      )
    })

    it('uses custom host and port', () => {
      const entry = buildSshConfigEntry(
        'ws-2',
        'token-abc',
        'custom.ssh.host',
        3333
      )
      expect(entry).toContain('HostName custom.ssh.host')
      expect(entry).toContain('Port 3333')
    })

    it('includes start and end markers', () => {
      const entry = buildSshConfigEntry('ws-3', 'tok')
      expect(entry).toContain('# laborer-managed: ws-3')
      expect(entry).toContain('# laborer-managed-end: ws-3')
    })

    it('includes StrictHostKeyChecking no', () => {
      const entry = buildSshConfigEntry('ws-4', 'tok')
      expect(entry).toContain('StrictHostKeyChecking no')
    })

    it('includes UserKnownHostsFile /dev/null', () => {
      const entry = buildSshConfigEntry('ws-5', 'tok')
      expect(entry).toContain('UserKnownHostsFile /dev/null')
    })
  })

  // -----------------------------------------------------------------------
  // removeSshConfigEntry
  // -----------------------------------------------------------------------

  describe('removeSshConfigEntry', () => {
    it('removes a managed entry from the config', () => {
      const config = [
        'Host my-server',
        '  HostName example.com',
        '',
        '# laborer-managed: ws-1',
        'Host laborer-ws-1',
        '  HostName ssh.app.daytona.io',
        '  Port 2222',
        '  User token-123',
        '  StrictHostKeyChecking no',
        '  UserKnownHostsFile /dev/null',
        '# laborer-managed-end: ws-1',
        '',
        'Host another-server',
        '  HostName other.com',
      ].join('\n')

      const result = removeSshConfigEntry(config, 'ws-1')
      expect(result).not.toContain('laborer-ws-1')
      expect(result).not.toContain('token-123')
      expect(result).toContain('Host my-server')
      expect(result).toContain('Host another-server')
    })

    it('returns unchanged content when entry does not exist', () => {
      const config = 'Host my-server\n  HostName example.com\n'
      const result = removeSshConfigEntry(config, 'nonexistent')
      expect(result).toBe(config)
    })

    it('handles config with only the managed entry', () => {
      const entry = buildSshConfigEntry('ws-1', 'token')
      const result = removeSshConfigEntry(entry, 'ws-1')
      expect(result.trim()).toBe('')
    })

    it('removes only the targeted entry when multiple managed entries exist', () => {
      const config = [
        buildSshConfigEntry('ws-1', 'token-1'),
        buildSshConfigEntry('ws-2', 'token-2'),
        buildSshConfigEntry('ws-3', 'token-3'),
      ].join('')

      const result = removeSshConfigEntry(config, 'ws-2')
      expect(result).toContain('laborer-ws-1')
      expect(result).not.toContain('laborer-ws-2')
      expect(result).not.toContain('token-2')
      expect(result).toContain('laborer-ws-3')
    })
  })

  // -----------------------------------------------------------------------
  // upsertSshConfigEntry
  // -----------------------------------------------------------------------

  describe('upsertSshConfigEntry', () => {
    it('appends entry to empty config', () => {
      const result = upsertSshConfigEntry('', 'ws-1', 'token-abc')
      expect(result).toContain('Host laborer-ws-1')
      expect(result).toContain('User token-abc')
    })

    it('appends entry to existing config', () => {
      const existing = 'Host my-server\n  HostName example.com\n'
      const result = upsertSshConfigEntry(existing, 'ws-1', 'token-abc')
      expect(result).toContain('Host my-server')
      expect(result).toContain('Host laborer-ws-1')
    })

    it('replaces existing entry with new token', () => {
      const config = ['Host my-server', '  HostName example.com', ''].join('\n')
      const withEntry = upsertSshConfigEntry(config, 'ws-1', 'old-token')
      const updated = upsertSshConfigEntry(withEntry, 'ws-1', 'new-token')

      expect(updated).toContain('User new-token')
      expect(updated).not.toContain('old-token')
      // Should only have one entry for ws-1
      const matches = updated.match(/laborer-managed: ws-1/g)
      expect(matches).toHaveLength(1)
    })

    it('preserves other entries when replacing', () => {
      const config = upsertSshConfigEntry(
        'Host other\n  HostName other.com\n',
        'ws-1',
        'token-1'
      )
      const withSecond = upsertSshConfigEntry(config, 'ws-2', 'token-2')
      const replaced = upsertSshConfigEntry(withSecond, 'ws-1', 'new-token-1')

      expect(replaced).toContain('Host other')
      expect(replaced).toContain('laborer-ws-2')
      expect(replaced).toContain('new-token-1')
      // Verify old token is gone — new-token-1 should be present but not plain token-1
      const userLines = replaced
        .split('\n')
        .filter((l) => l.trim().startsWith('User '))
      expect(userLines).not.toContainEqual(expect.stringContaining('token-1\n'))
      expect(userLines.some((l) => l.trim() === 'User token-1')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // hasSshConfigEntry
  // -----------------------------------------------------------------------

  describe('hasSshConfigEntry', () => {
    it('returns true when entry exists', () => {
      const config = buildSshConfigEntry('ws-1', 'token')
      expect(hasSshConfigEntry(config, 'ws-1')).toBe(true)
    })

    it('returns false when entry does not exist', () => {
      const config = 'Host my-server\n  HostName example.com\n'
      expect(hasSshConfigEntry(config, 'ws-1')).toBe(false)
    })

    it('returns false for empty config', () => {
      expect(hasSshConfigEntry('', 'ws-1')).toBe(false)
    })

    it('distinguishes between different workspace IDs', () => {
      const config = buildSshConfigEntry('ws-1', 'token')
      expect(hasSshConfigEntry(config, 'ws-1')).toBe(true)
      expect(hasSshConfigEntry(config, 'ws-2')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // buildVsCodeRemoteCommand
  // -----------------------------------------------------------------------

  describe('buildVsCodeRemoteCommand', () => {
    it('builds the correct VS Code remote command', () => {
      expect(buildVsCodeRemoteCommand('ws-1')).toBe(
        'code --remote ssh-remote+laborer-ws-1 /home/daytona/project'
      )
    })

    it('uses custom project directory', () => {
      expect(buildVsCodeRemoteCommand('ws-1', '/custom/path')).toBe(
        'code --remote ssh-remote+laborer-ws-1 /custom/path'
      )
    })

    it('handles UUID workspace IDs', () => {
      const cmd = buildVsCodeRemoteCommand(
        '550e8400-e29b-41d4-a716-446655440000'
      )
      expect(cmd).toContain(
        'ssh-remote+laborer-550e8400-e29b-41d4-a716-446655440000'
      )
    })
  })
})
