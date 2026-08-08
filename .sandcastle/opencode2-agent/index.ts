import type { AgentProvider } from "@ai-hero/sandcastle";

export interface OpenCode2AgentOptions {
  readonly agent?: string;
  readonly env?: Record<string, string>;
  readonly maxAttempts?: number;
  readonly retryDelaySeconds?: number;
  readonly variant?: string;
}

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

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

  return {
    name: "opencode2",
    env: options.env ?? {},
    captureSessions: false,
    buildPrintCommand({ prompt, dangerouslySkipPermissions }) {
      const args = [
        "run",
        "--standalone",
        "--format",
        "json",
        "--model",
        selectedModel,
      ];
      if (options.agent) {
        args.push("--agent", options.agent);
      }
      if (dangerouslySkipPermissions) {
        args.push("--auto");
      }
      const invocation = `opencode2 ${args.map(shellQuote).join(" ")}`;
      return {
        command: [
          'prompt_file="$(mktemp)"',
          'trap \'rm -f "$prompt_file"\' EXIT HUP INT TERM',
          'cat > "$prompt_file"',
          "attempt=1",
          "while :; do",
          "  if [ -f /home/agent/.local/share/opencode/opencode-next.seed.db ]; then cp /home/agent/.local/share/opencode/opencode-next.seed.db /home/agent/.local/share/opencode/opencode-next.db; fi",
          `  ${invocation} < "$prompt_file" && exit 0`,
          "  status=$?",
          `  if [ "$attempt" -ge ${maxAttempts} ]; then exit "$status"; fi`,
          '  printf "opencode2 attempt %s failed; retrying preserved worktree.\\n" "$attempt" >&2',
          `  sleep $((attempt * ${retryDelaySeconds}))`,
          "  attempt=$((attempt + 1))",
          "done",
        ].join("\n"),
        stdin: prompt,
      };
    },
    parseStreamLine: parseOpenCode2StreamLine,
  };
};
