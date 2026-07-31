import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type ContentBlock,
  client,
  type InitializeResponse,
  type McpServer,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  assertSupportedOpenCodeInitialization,
  SUPPORTED_ACP_RUNTIME_MATRIX,
} from "../../src/acp-compatibility/runtime-matrix.ts";
import {
  OPEN_CODE_ACP_ARGS,
  OPEN_CODE_ACP_COMMAND,
} from "../../src/acp-conversation-prototype/open-code-acp-process.ts";
import { superviseSubprocess } from "./subprocess-supervisor.ts";

const PROJECT_ROOT = process.cwd();
const OPEN_CODE_EXECUTABLE = resolve(
  PROJECT_ROOT,
  "node_modules/@opencode-ai/cli/bin/opencode2.exe"
);
const REQUEST_TIMEOUT_MILLIS = 30_000;
const STDERR_TAIL_CHARACTERS = 8000;
const DUMMY_PROVIDER_KEY = "laborer-acp-compatibility-dummy-key";
const OPEN_CODE_2_VERSION_PREFIX = /^opencode2 v/;

export const OPEN_CODE_COMPATIBILITY_PERMISSION_POLICY = {
  "*": "deny",
  compat_record: "ask",
} as const;

export interface OpenCodeAcpHarnessOptions {
  readonly cwd: string;
  readonly home: string;
  readonly providerBaseUrl: string;
}

export interface OpenCodeAcpHarness {
  readonly cancelSession: (sessionId: string) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly diagnostic: () => string;
  readonly initialize: () => Promise<InitializeResponse>;
  readonly newSession: (
    mcpServers?: readonly McpServer[]
  ) => Promise<{ readonly sessionId: string }>;
  readonly permissionRequests: readonly RequestPermissionRequest[];
  readonly prompt: (
    sessionId: string,
    content: string | readonly ContentBlock[]
  ) => Promise<PromptResponse>;
  readonly resumeSession: (sessionId: string) => Promise<void>;
  readonly updates: readonly SessionNotification[];
}

const timeout = async <Value>(
  promise: Promise<Value>,
  label: string,
  timeoutMillis = REQUEST_TIMEOUT_MILLIS
): Promise<Value> => {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMillis}ms`)),
      timeoutMillis
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const platformPath = (): string => {
  const executableDirectory = dirname(process.execPath);
  const systemDirectories =
    process.platform === "win32"
      ? [resolve(process.env.SystemRoot ?? "C:\\Windows", "System32")]
      : ["/usr/bin", "/bin"];
  return [executableDirectory, ...systemDirectories].join(delimiter);
};

export const makeOpenCodeCompatibilityConfig = (
  baseUrl: string
): Readonly<Record<string, unknown>> => ({
  agents: {
    build: {
      permissions: [
        { action: "*", effect: "deny", resource: "*" },
        { action: "execute", effect: "allow", resource: "*" },
        { action: "compat_record", effect: "ask", resource: "*" },
      ],
    },
  },
  formatter: false,
  lsp: false,
  model: "compatibility/compatibility-model",
  permissions: [
    { action: "*", effect: "deny", resource: "*" },
    { action: "execute", effect: "allow", resource: "*" },
    { action: "compat_record", effect: "ask", resource: "*" },
  ],
  providers: {
    compatibility: {
      models: {
        "compatibility-model": {
          capabilities: {
            input: ["text", "image"],
            output: ["text"],
            tools: true,
          },
          cost: { input: 0, output: 0 },
          limit: { context: 100_000, output: 10_000 },
          modelID: "compatibility-model",
          name: "ACP Compatibility Model",
        },
      },
      name: "ACP Compatibility",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { apiKey: DUMMY_PROVIDER_KEY, baseURL: baseUrl },
    },
  },
});

const isolatedEnvironment = (
  options: OpenCodeAcpHarnessOptions
): NodeJS.ProcessEnv => {
  const temporaryDirectory = join(options.home, "tmp");
  const environment: NodeJS.ProcessEnv = {
    HOME: options.home,
    LANG: "C.UTF-8",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      makeOpenCodeCompatibilityConfig(options.providerBaseUrl)
    ),
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_TEST_HOME: options.home,
    PATH: platformPath(),
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    XDG_CACHE_HOME: join(options.home, ".cache"),
    XDG_CONFIG_HOME: join(options.home, ".config"),
    XDG_DATA_HOME: join(options.home, ".local", "share"),
    XDG_STATE_HOME: join(options.home, ".local", "state"),
  };
  if (process.platform === "win32") {
    environment.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
  }
  return environment;
};

const collectOutput = (
  child: ChildProcessWithoutNullStreams,
  stream: "stderr" | "stdout"
): Promise<string> => {
  let output = "";
  child[stream].on("data", (chunk: Uint8Array) => {
    output = `${output}${Buffer.from(chunk).toString("utf8")}`.slice(
      -STDERR_TAIL_CHARACTERS
    );
  });
  return new Promise((resolveOutput) => {
    let resolved = false;
    const finish = (): void => {
      if (!resolved) {
        resolved = true;
        resolveOutput(output);
      }
    };
    child[stream].once("end", finish);
    child[stream].once("close", finish);
  });
};

export const readLocalOpenCodeVersion = async (
  options: OpenCodeAcpHarnessOptions
): Promise<string> => {
  await mkdir(join(options.home, "tmp"), { recursive: true, mode: 0o700 });
  const child = spawn(OPEN_CODE_EXECUTABLE, ["--version"], {
    cwd: options.cwd,
    env: isolatedEnvironment(options),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const supervisor = superviseSubprocess(child, {
    label: "local OpenCode version process",
  });
  const stdout = collectOutput(child, "stdout");
  const stderr = collectOutput(child, "stderr");
  try {
    child.stdin.end();
    const result = await supervisor.waitForExit(REQUEST_TIMEOUT_MILLIS);
    if (result === null) {
      throw new Error("local OpenCode version check timed out");
    }
    const [capturedStdout, capturedStderr] = await Promise.all([
      stdout,
      stderr,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `local OpenCode version check exited with ${String(result.code)}: ${capturedStderr.slice(-2000)}`
      );
    }
    return capturedStdout.trim().replace(OPEN_CODE_2_VERSION_PREFIX, "");
  } finally {
    await supervisor.terminate();
  }
};

export const startOpenCodeAcpHarness = async (
  options: OpenCodeAcpHarnessOptions
): Promise<OpenCodeAcpHarness> => {
  await mkdir(join(options.home, "tmp"), { recursive: true, mode: 0o700 });
  const child = spawn(OPEN_CODE_ACP_COMMAND, [...OPEN_CODE_ACP_ARGS], {
    cwd: options.cwd,
    env: isolatedEnvironment(options),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const supervisor = superviseSubprocess(child, {
    label: "OpenCode ACP process",
  });
  let stderrTail = "";
  child.stderr.on("data", (chunk: Uint8Array) => {
    stderrTail = `${stderrTail}${Buffer.from(chunk).toString("utf8")}`.slice(
      -STDERR_TAIL_CHARACTERS
    );
  });
  const permissionRequests: RequestPermissionRequest[] = [];
  const updates: SessionNotification[] = [];
  const application = client({ name: "laborer-open-code-acp-compatibility" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params);
      const allowOnce = params.options.find(
        (option) => option.kind === "allow_once"
      );
      if (allowOnce === undefined) {
        throw new Error("OpenCode permission request omitted allow_once");
      }
      return {
        outcome: { optionId: allowOnce.optionId, outcome: "selected" },
      };
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params);
    });
  let connection: ReturnType<typeof application.connect>;
  try {
    connection = application.connect(
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
    );
  } catch (cause) {
    await supervisor.terminate();
    throw cause;
  }
  connection.closed.catch(() => undefined);
  const diagnostic = (): string =>
    `command=${OPEN_CODE_EXECUTABLE} expectedVersion=${SUPPORTED_ACP_RUNTIME_MATRIX.openCodeCli}\nstderr tail:\n${stderrTail}`;
  const request = async <Value>(
    operation: Promise<Value>,
    label: string
  ): Promise<Value> => {
    try {
      return await timeout(operation, label);
    } catch (cause) {
      connection.close();
      await supervisor.terminate();
      throw new Error(
        `${label} failed\npermission requests: ${permissionRequests.length}\n${diagnostic()}`,
        { cause }
      );
    }
  };
  return {
    cancelSession: (sessionId) =>
      request(
        connection.agent.notify(methods.agent.session.cancel, { sessionId }),
        "session/cancel"
      ),
    close: async () => {
      connection.close();
      await supervisor.terminate();
    },
    diagnostic,
    initialize: async () => {
      const initialized = await request(
        connection.agent.request(methods.agent.initialize, {
          clientCapabilities: {},
          clientInfo: {
            name: "laborer-open-code-acp-compatibility",
            version: "1.0.0",
          },
          protocolVersion: PROTOCOL_VERSION,
        }),
        "initialize"
      );
      assertSupportedOpenCodeInitialization(initialized);
      return initialized;
    },
    newSession: async (mcpServers = []) =>
      request(
        connection.agent.request(methods.agent.session.new, {
          cwd: options.cwd,
          mcpServers: [...mcpServers],
        }),
        "session/new"
      ),
    permissionRequests,
    prompt: (sessionId, content) =>
      request(
        connection.agent.request(methods.agent.session.prompt, {
          prompt:
            typeof content === "string"
              ? [{ text: content, type: "text" }]
              : [...content],
          sessionId,
        }),
        `session/prompt (${typeof content === "string" ? content : "content blocks"})`
      ),
    resumeSession: async (sessionId) => {
      await request(
        connection.agent.request(methods.agent.session.resume, {
          cwd: options.cwd,
          mcpServers: [],
          sessionId,
        }),
        "session/resume"
      );
    },
    updates,
  };
};
