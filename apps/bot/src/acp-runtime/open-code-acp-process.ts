import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
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
export const OPEN_CODE_ACP_COMMAND =
  process.env.BUN_INSTALL === undefined
    ? 'bun'
    : resolve(process.env.BUN_INSTALL, 'bin', 'bun')
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
