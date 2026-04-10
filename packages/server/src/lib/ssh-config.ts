/**
 * SSH config helpers for managing `~/.ssh/config` entries for Daytona sandboxes.
 *
 * Pure functions for building, parsing, inserting, and removing laborer-managed
 * SSH config entries. These helpers are used by `DaytonaSandboxProvider` to
 * automate VS Code Remote SSH configuration for cloud sandboxes.
 *
 * Each managed entry is bracketed by marker comments:
 *   `# laborer-managed: {workspaceId}`
 *   `# laborer-managed-end: {workspaceId}`
 *
 * This makes entries easy to locate and remove without disturbing other
 * entries in the user's SSH config.
 *
 * @see packages/server/src/services/daytona-sandbox-provider.ts
 * @see docs/daytona-sandbox-provider/issues.md (Issue 22)
 */

import { DAYTONA_SSH_HOST } from './git-sync.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SSH port used by the Daytona SSH gateway. */
const DAYTONA_SSH_PORT = 2222

/** Marker comment prefix used to identify laborer-managed SSH config entries. */
const MARKER_PREFIX = '# laborer-managed:'

/** End marker comment prefix used to delimit the end of a managed entry. */
const MARKER_END_PREFIX = '# laborer-managed-end:'

/** SSH token expiry in minutes for VS Code sessions. */
const SSH_TOKEN_EXPIRY_MINUTES = 60

/** Interval in minutes at which the SSH token should be refreshed. */
const SSH_TOKEN_REFRESH_MINUTES = 45

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * Build the SSH `Host` alias name for a workspace.
 *
 * Format: `laborer-{workspaceId}`
 */
const buildHostAlias = (workspaceId: string): string => `laborer-${workspaceId}`

/**
 * Build a complete SSH config entry for a Daytona sandbox.
 *
 * The entry is wrapped in marker comments so it can be located and
 * removed later without disturbing other entries in the user's config.
 *
 * @param workspaceId - The workspace ID (used in Host alias and markers)
 * @param token - SSH access token from `sandbox.createSshAccess()`
 * @param host - SSH gateway hostname (defaults to Daytona's gateway)
 * @param port - SSH gateway port (defaults to 2222)
 */
const buildSshConfigEntry = (
  workspaceId: string,
  token: string,
  host = DAYTONA_SSH_HOST,
  port = DAYTONA_SSH_PORT
): string =>
  [
    `${MARKER_PREFIX} ${workspaceId}`,
    `Host ${buildHostAlias(workspaceId)}`,
    `  HostName ${host}`,
    `  Port ${String(port)}`,
    `  User ${token}`,
    '  StrictHostKeyChecking no',
    '  UserKnownHostsFile /dev/null',
    `${MARKER_END_PREFIX} ${workspaceId}`,
    '',
  ].join('\n')

/**
 * Remove a laborer-managed SSH config entry for a specific workspace.
 *
 * Finds the entry by its marker comments and removes everything between
 * (and including) the start and end markers. Returns the updated config
 * content. If no entry is found, returns the content unchanged.
 *
 * @param content - The full SSH config file content
 * @param workspaceId - The workspace ID to remove
 */
const removeSshConfigEntry = (content: string, workspaceId: string): string => {
  const startMarker = `${MARKER_PREFIX} ${workspaceId}`
  const endMarker = `${MARKER_END_PREFIX} ${workspaceId}`

  const lines = content.split('\n')
  const result: string[] = []
  let insideBlock = false

  for (const line of lines) {
    if (line.trim() === startMarker) {
      insideBlock = true
      continue
    }
    if (line.trim() === endMarker) {
      insideBlock = false
      // Skip the blank line after the end marker (if present) to avoid
      // accumulating blank lines on repeated add/remove cycles.
      continue
    }
    if (!insideBlock) {
      result.push(line)
    }
  }

  // Clean up trailing blank lines that might accumulate
  let cleaned = result.join('\n')
  // Remove runs of 3+ newlines down to 2 (single blank line)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
  return cleaned
}

/**
 * Insert or replace a laborer-managed SSH config entry.
 *
 * If an entry for the given workspace already exists, it is removed first.
 * The new entry is appended at the end of the config.
 *
 * @param content - The current SSH config file content
 * @param workspaceId - The workspace ID
 * @param token - SSH access token
 * @param host - SSH gateway hostname
 * @param port - SSH gateway port
 */
const upsertSshConfigEntry = (
  content: string,
  workspaceId: string,
  token: string,
  host = DAYTONA_SSH_HOST,
  port = DAYTONA_SSH_PORT
): string => {
  // Remove existing entry if present
  let updated = removeSshConfigEntry(content, workspaceId)

  // Ensure the content ends with a newline before appending
  if (updated.length > 0 && !updated.endsWith('\n')) {
    updated += '\n'
  }

  // Append the new entry
  updated += buildSshConfigEntry(workspaceId, token, host, port)

  return updated
}

/**
 * Check if a laborer-managed SSH config entry exists for a workspace.
 *
 * @param content - The full SSH config file content
 * @param workspaceId - The workspace ID to check
 */
const hasSshConfigEntry = (content: string, workspaceId: string): boolean => {
  const startMarker = `${MARKER_PREFIX} ${workspaceId}`
  return content.includes(startMarker)
}

/**
 * Build the VS Code Remote SSH command to open a workspace.
 *
 * Format: `code --remote ssh-remote+laborer-{workspaceId} /home/daytona/project`
 *
 * @param workspaceId - The workspace ID
 * @param projectDir - Working directory inside the sandbox
 */
const buildVsCodeRemoteCommand = (
  workspaceId: string,
  projectDir = '/home/daytona/project'
): string =>
  `code --remote ssh-remote+${buildHostAlias(workspaceId)} ${projectDir}`

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
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
}
