import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const LABORER_MCP_RESOURCE_DIRECTORY = 'laborer-mcp'
const LABORER_MCP_SCRIPT_NAME = 'laborer-mcp.mjs'

interface InstallLaborerMcpSymlinkOptions {
  readonly homeDirectory?: string
  readonly scriptPath: string
}

interface RefreshLaborerMcpSymlinkOptions
  extends InstallLaborerMcpSymlinkOptions {
  readonly warn?: (message: string) => void
}

/** Resolve the MCP launcher shipped outside the app's asar archive. */
export const laborerMcpBundleScriptPath = (resourcesPath: string): string =>
  join(resourcesPath, LABORER_MCP_RESOURCE_DIRECTORY, LABORER_MCP_SCRIPT_NAME)

/**
 * Atomically install the stable MCP command path.
 *
 * The linked script deliberately uses `#!/usr/bin/env node`, so Node is
 * resolved from the invoking MCP client's PATH rather than Electron's PATH.
 */
export const installLaborerMcpSymlink = (
  options: InstallLaborerMcpSymlinkOptions
): string => {
  const commandPath = join(
    options.homeDirectory ?? homedir(),
    '.local',
    'bin',
    'laborer-mcp'
  )
  mkdirSync(dirname(commandPath), { recursive: true })

  const temporaryPath = `${commandPath}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    symlinkSync(options.scriptPath, temporaryPath)
    renameSync(temporaryPath, commandPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }

  return commandPath
}

/** Best-effort launch integration: installation failures never block startup. */
export const refreshLaborerMcpSymlink = (
  options: RefreshLaborerMcpSymlinkOptions
): void => {
  try {
    installLaborerMcpSymlink(options)
  } catch (cause) {
    const commandPath = join(
      options.homeDirectory ?? homedir(),
      '.local',
      'bin',
      'laborer-mcp'
    )
    ;(options.warn ?? console.warn)(
      `[main] Could not install Laborer MCP command at ${commandPath}: ${String(cause)}`
    )
  }
}
