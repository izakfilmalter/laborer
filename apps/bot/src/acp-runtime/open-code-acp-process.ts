import { accessSync, constants } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AcpConversationAgentOptions } from './acp-conversation-agent.ts'
import { resolveInstalledOpenCode } from './installed-opencode.ts'

/** The machine's installed OpenCode 2 executable, resolved on first use. */
export const openCodeCommand = (
  environment: NodeJS.ProcessEnv = process.env
): string => resolveInstalledOpenCode(environment).command
export const OPEN_CODE_ACP_ADAPTER = fileURLToPath(
  new URL('./opencode-v2-acp-adapter.ts', import.meta.url)
)

const resolveBunExecutable = (): string => {
  const executableName = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const candidates = [
    ...(process.versions.bun === undefined ? [] : [process.execPath]),
    ...(process.env.BUN_INSTALL === undefined
      ? []
      : [resolve(process.env.BUN_INSTALL, 'bin', executableName)]),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter((directory) => directory.length > 0)
      .map((directory) => resolve(directory, executableName)),
  ]

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue until an executable Bun installation is found.
    }
  }

  return executableName
}

export const OPEN_CODE_ACP_COMMAND = resolveBunExecutable()
export const OPEN_CODE_ACP_ARGS = [OPEN_CODE_ACP_ADAPTER] as const

export interface OpenCodeAcpProcessOptions {
  readonly command?: string
  readonly cwd: string
  readonly environment?: NodeJS.ProcessEnv
}

export const openCodeAcpProcessOptions = (
  options: OpenCodeAcpProcessOptions
): AcpConversationAgentOptions => ({
  args: options.command === undefined ? OPEN_CODE_ACP_ARGS : ['acp'],
  command: options.command ?? OPEN_CODE_ACP_COMMAND,
  cwd: options.cwd,
  ...(options.environment === undefined
    ? {}
    : { environment: options.environment }),
})
