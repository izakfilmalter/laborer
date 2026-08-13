import type { McpServer } from '@agentclientprotocol/sdk'

/**
 * Execution controls can wait behind an active implementation prompt and then
 * observe a complete follow-up turn. Match OpenCode V2's bounded MCP execution
 * budget rather than its SDK's one-minute request default.
 */
export const ACTION_MCP_EXECUTION_TIMEOUT_MILLIS = 12 * 60 * 60 * 1000

/** Keep the HTTP bridge alive slightly longer than its MCP caller. */
export const ACTION_MCP_CONTROL_TIMEOUT_MILLIS =
  ACTION_MCP_EXECUTION_TIMEOUT_MILLIS + 5000

const ACTION_MCP_SERVER_NAME_PATTERN = /^laborer-actions-[a-f0-9]{16}$/

export const openCodeMcpConfig = (server: McpServer) => {
  const timeout = ACTION_MCP_SERVER_NAME_PATTERN.test(server.name)
    ? { timeout: { execution: ACTION_MCP_EXECUTION_TIMEOUT_MILLIS } }
    : {}
  if ('type' in server) {
    if (server.type === 'acp') {
      throw new Error('MCP-over-ACP is not supported')
    }
    return {
      codemode: false,
      headers: Object.fromEntries(
        server.headers.map((header) => [header.name, header.value])
      ),
      oauth: false as const,
      ...timeout,
      type: 'remote' as const,
      url: server.url,
    }
  }
  return {
    codemode: false,
    command: [server.command, ...server.args],
    environment: Object.fromEntries(
      server.env.map((entry) => [entry.name, entry.value])
    ),
    ...timeout,
    type: 'local' as const,
  }
}
