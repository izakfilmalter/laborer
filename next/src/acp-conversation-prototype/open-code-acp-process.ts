import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { AcpConversationAgentOptions } from "./acp-conversation-agent.ts";

const require = createRequire(import.meta.url);

export const OPEN_CODE_ACP_COMMAND = resolve(
  dirname(require.resolve("opencode-ai/package.json")),
  "bin",
  "opencode.exe"
);
export const OPEN_CODE_ACP_ARGS = ["acp"] as const;

export interface OpenCodeAcpProcessOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export const openCodeAcpProcessOptions = (
  options: OpenCodeAcpProcessOptions
): AcpConversationAgentOptions => ({
  args: OPEN_CODE_ACP_ARGS,
  command: options.command ?? OPEN_CODE_ACP_COMMAND,
  cwd: options.cwd,
  ...(options.environment === undefined
    ? {}
    : { environment: options.environment }),
});
