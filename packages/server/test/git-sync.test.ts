/**
 * Tests for git sync helpers — Issue 15
 *
 * Unit tests for pure functions that construct SSH remote URLs, git remote
 * names, and shell commands for pushing worktree code to Daytona sandboxes.
 * These are pure string operations with no external dependencies.
 */

import { describe, expect, it } from '@effect/vitest'

import {
  buildAddRemoteArgs,
  buildPushArgs,
  buildRemoteName,
  buildRemoveRemoteArgs,
  buildSandboxCheckoutCommand,
  buildSandboxInitCommand,
  buildSshGitEnv,
  buildSshRemoteUrl,
  DAYTONA_PROJECT_DIR,
  DAYTONA_SSH_HOST,
  isSandboxRemoteName,
} from '../../server/src/lib/git-sync.js'

describe('git-sync helpers', () => {
  describe('buildRemoteName', () => {
    it('produces sandbox-{workspaceId} format', () => {
      expect(buildRemoteName('ws-abc-123')).toBe('sandbox-ws-abc-123')
    })

    it('handles UUID-style workspace IDs', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
      expect(buildRemoteName(uuid)).toBe(`sandbox-${uuid}`)
    })
  })

  describe('isSandboxRemoteName', () => {
    it('matches laborer sandbox remotes', () => {
      expect(isSandboxRemoteName('sandbox-ws-abc-123')).toBe(true)
    })

    it('does not match normal repository remotes', () => {
      expect(isSandboxRemoteName('origin')).toBe(false)
      expect(isSandboxRemoteName('upstream')).toBe(false)
    })
  })

  describe('buildSshRemoteUrl', () => {
    it('constructs SSH URL with token, default host, and default project dir', () => {
      const url = buildSshRemoteUrl('my-token-123')
      expect(url).toBe(
        `ssh://my-token-123@${DAYTONA_SSH_HOST}${DAYTONA_PROJECT_DIR}`
      )
    })

    it('uses custom host when provided', () => {
      const url = buildSshRemoteUrl('token', 'custom.host.io')
      expect(url).toBe(`ssh://token@custom.host.io${DAYTONA_PROJECT_DIR}`)
    })

    it('uses custom project dir when provided', () => {
      const url = buildSshRemoteUrl('token', DAYTONA_SSH_HOST, '/workspace')
      expect(url).toBe(`ssh://token@${DAYTONA_SSH_HOST}/workspace`)
    })

    it('includes the token as the SSH user', () => {
      const url = buildSshRemoteUrl('abc-token-xyz')
      expect(url).toContain('abc-token-xyz@')
    })
  })

  describe('buildAddRemoteArgs', () => {
    it('produces git remote add command args', () => {
      const args = buildAddRemoteArgs(
        'sandbox-ws-1',
        'ssh://token@host/project'
      )
      expect(args).toEqual([
        'remote',
        'add',
        'sandbox-ws-1',
        'ssh://token@host/project',
      ])
    })
  })

  describe('buildPushArgs', () => {
    it('produces git push command args with force flag', () => {
      const args = buildPushArgs('sandbox-ws-1')
      expect(args).toEqual(['push', 'sandbox-ws-1', 'HEAD:main', '--force'])
    })
  })

  describe('buildRemoveRemoteArgs', () => {
    it('produces git remote remove command args', () => {
      const args = buildRemoveRemoteArgs('sandbox-ws-1')
      expect(args).toEqual(['remote', 'remove', 'sandbox-ws-1'])
    })
  })

  describe('buildSandboxInitCommand', () => {
    it('initializes git repo and configures receive.denyCurrentBranch', () => {
      const cmd = buildSandboxInitCommand()
      expect(cmd).toContain(`git init ${DAYTONA_PROJECT_DIR}`)
      expect(cmd).toContain('git config receive.denyCurrentBranch ignore')
    })

    it('uses custom project dir when provided', () => {
      const cmd = buildSandboxInitCommand('/custom/path')
      expect(cmd).toContain('git init /custom/path')
      expect(cmd).toContain('cd /custom/path')
    })
  })

  describe('buildSandboxCheckoutCommand', () => {
    it('checks out main branch with force flag', () => {
      const cmd = buildSandboxCheckoutCommand()
      expect(cmd).toContain(`cd ${DAYTONA_PROJECT_DIR}`)
      expect(cmd).toContain('git checkout -f main')
    })

    it('uses custom project dir when provided', () => {
      const cmd = buildSandboxCheckoutCommand('/workspace')
      expect(cmd).toContain('cd /workspace')
      expect(cmd).toContain('git checkout -f main')
    })
  })

  describe('buildSshGitEnv', () => {
    it('sets GIT_SSH_COMMAND with strict host key checking disabled', () => {
      const env = buildSshGitEnv()
      expect(env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=no')
    })

    it('sets GIT_SSH_COMMAND with known hosts file disabled', () => {
      const env = buildSshGitEnv()
      expect(env.GIT_SSH_COMMAND).toContain('UserKnownHostsFile=/dev/null')
    })

    it('sets SSH port to 2222 (Daytona SSH gateway port)', () => {
      const env = buildSshGitEnv()
      expect(env.GIT_SSH_COMMAND).toContain('-p 2222')
    })
  })
})
