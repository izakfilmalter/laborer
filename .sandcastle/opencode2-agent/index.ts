import type { AgentProvider } from "@ai-hero/sandcastle";
import { fileURLToPath } from "node:url";

export interface OpenCode2AgentOptions {
  readonly agent?: string;
  /** Grants unattended OpenCode permissions to a process with full host access. */
  readonly dangerouslyAutoApproveHostPermissions?: boolean;
  readonly env?: Record<string, string>;
  readonly maxAttempts?: number;
  readonly diagnosticsPath?: string;
  readonly initialStaggerSeconds?: number;
  readonly recoveryPollSeconds?: number;
  readonly recoveryTimeoutSeconds?: number;
  readonly retryDelaySeconds?: number;
  readonly retryJitterSeconds?: number;
  readonly runTimeoutSeconds?: number;
  readonly variant?: string;
}

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const runnerPath = fileURLToPath(new URL("./run.ts", import.meta.url));

const toolArgumentFields: Readonly<Record<string, string>> = {
  bash: "command",
  task: "description",
  webfetch: "url",
};

const errorMessage = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.message === "string") {
    return record.message;
  }
  return errorMessage(record.error);
};

const parseCompletedTool = (
  part: Readonly<Record<string, unknown>>
): ReturnType<AgentProvider["parseStreamLine"]> => {
  if (part.type !== "tool" || typeof part.tool !== "string") {
    return [];
  }
  const state = part.state;
  if (typeof state !== "object" || state === null) {
    return [];
  }
  const stateRecord = state as Readonly<Record<string, unknown>>;
  const input = stateRecord.input;
  if (
    stateRecord.status !== "completed" ||
    typeof input !== "object" ||
    input === null
  ) {
    return [];
  }
  const inputRecord = input as Readonly<Record<string, unknown>>;
  const argumentField = toolArgumentFields[part.tool];
  const argument =
    argumentField === undefined ? undefined : inputRecord[argumentField];
  return [
    {
      args: typeof argument === "string" ? argument : JSON.stringify(input),
      name: part.tool,
      type: "tool_call",
    },
  ];
};

const parseOpenCode2StreamLine: AgentProvider["parseStreamLine"] = (line) => {
  if (!line.startsWith("{")) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const event = value as Readonly<Record<string, unknown>>;
  if (event.type === "step_start" && typeof event.sessionID === "string") {
    return [{ sessionId: event.sessionID, type: "session_id" }];
  }
  if (event.type === "error") {
    const message = errorMessage(event);
    return message === null ? [] : [{ result: message, type: "result" }];
  }
  const part = event.part;
  if (typeof part !== "object" || part === null) {
    return [];
  }
  const partRecord = part as Readonly<Record<string, unknown>>;
  if (
    event.type === "text" &&
    partRecord.type === "text" &&
    typeof partRecord.text === "string"
  ) {
    return [
      { text: partRecord.text, type: "text" },
      { result: partRecord.text, type: "result" },
    ];
  }
  if (event.type !== "tool_use") {
    return [];
  }
  return parseCompletedTool(partRecord);
};

export const opencode2Agent = (
  model: string,
  options: OpenCode2AgentOptions = {}
): AgentProvider => {
  const selectedModel = options.variant ? `${model}#${options.variant}` : model;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const retryDelaySeconds = Math.max(
    0,
    Math.floor(options.retryDelaySeconds ?? 15)
  );
  const retryJitterSeconds = Math.max(
    0,
    Math.floor(options.retryJitterSeconds ?? 15)
  );
  const initialStaggerSeconds = Math.max(
    0,
    Math.floor(options.initialStaggerSeconds ?? 15)
  );
  const recoveryPollSeconds = Math.max(
    0,
    Math.floor(options.recoveryPollSeconds ?? 5)
  );
  const recoveryTimeoutSeconds = Math.max(
    0,
    Math.floor(
      options.recoveryTimeoutSeconds ?? options.runTimeoutSeconds ?? 14_400
    )
  );

  return {
    name: "opencode2",
    env: options.env ?? {},
    captureSessions: false,
    buildPrintCommand({ prompt, dangerouslySkipPermissions }) {
      const args = [
        "run",
        "--format",
        "json",
        "--model",
        selectedModel,
      ];
      if (options.agent) {
        args.push("--agent", options.agent);
      }
      if (
        dangerouslySkipPermissions ||
        options.dangerouslyAutoApproveHostPermissions
      ) {
        args.push("--auto");
      }
      const runnerArgs = [
        "--max-attempts",
        String(maxAttempts),
        "--retry-delay-seconds",
        String(retryDelaySeconds),
        "--retry-jitter-seconds",
        String(retryJitterSeconds),
        "--initial-stagger-seconds",
        String(initialStaggerSeconds),
        "--recovery-poll-seconds",
        String(recoveryPollSeconds),
        "--recovery-timeout-seconds",
        String(recoveryTimeoutSeconds),
        ...(options.diagnosticsPath === undefined
          ? []
          : ["--diagnostics-path", options.diagnosticsPath]),
        "--",
        "opencode2",
        ...args,
      ];
      const invocation = `bun ${shellQuote(runnerPath)} ${runnerArgs
        .map(shellQuote)
        .join(" ")}`;
      return {
        command: [
          `# sandcastle-timeout-seconds=${String(
            Math.max(1, Math.floor(options.runTimeoutSeconds ?? 14_400))
          )}`,
          invocation,
        ].join("\n"),
        stdin: prompt,
      };
    },
    parseStreamLine: parseOpenCode2StreamLine,
  };
};
