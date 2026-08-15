import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AcpConversationAgentOptions } from './acp-conversation-agent.ts'

const require = createRequire(import.meta.url)

export const OPEN_CODE_COMMAND = resolve(
  dirname(require.resolve('@opencode-ai/cli/package.json')),
  'bin',
  'opencode2.exe'
)
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
