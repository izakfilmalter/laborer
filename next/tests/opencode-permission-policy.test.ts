import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { makeAcpAuthorityRepository } from "../src/acp-runtime/acp-authority.ts";
import { makeAcpConversationAgent } from "../src/acp-runtime/acp-conversation-agent.ts";
import { makeAcpProcessStateRepository } from "../src/acp-runtime/acp-process-state.ts";
import { makeAcpConversationProcessSupervisor } from "../src/acp-runtime/acp-process-supervisor.ts";
import { makeLaborerActionMcpBridge } from "../src/acp-runtime/action-mcp.ts";
import { prepareAcpAgentContextSources } from "../src/acp-runtime/agent-context.ts";
import { laborerMcpServerLauncherArgs } from "../src/acp-runtime/mcp-server-launcher-config.ts";
import {
  awaitLaborerMemoryMcpReadiness,
  laborerMemoryOpenCodePermission,
  makeLaborerMemoryMcpServerConfiguration,
  observeLaborerMemoryToolCall,
  prepareLaborerMemoryMcpRegistration,
  tryAuthorizeLaborerMemoryPermission,
} from "../src/acp-runtime/memory-mcp.ts";
import {
  OPEN_CODE_ACP_ARGS,
  OPEN_CODE_ACP_COMMAND,
} from "../src/acp-runtime/open-code-acp-process.ts";
import { productionActionCatalog } from "../src/action-catalog.ts";
import { ParticipantInputEvent } from "../src/application.ts";
import {
  MessageId,
  NormalizedMessage,
  ThreadId,
  TurnId,
} from "../src/core/domain.ts";
import {
  type ConversationAction,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  type TrustedActionInvocation,
} from "../src/reference-coding-application.ts";
import { startFakeOpenAiProvider } from "./support/fake-openai-provider.ts";

const execFilePromise = promisify(execFile);
const PROJECT_ROOT = process.cwd();
const OPEN_CODE_EXECUTABLE = resolve(
  PROJECT_ROOT,
  "node_modules/@opencode-ai/cli/bin/opencode2.exe"
);
const MCP_FIXTURE = resolve(
  PROJECT_ROOT,
  "tests/fixtures/acp-permission-policy-mcp.ts"
);
const REQUEST_TIMEOUT_MILLIS = 30_000;
const OPEN_CODE_2_VERSION_PREFIX = /^opencode2 v/;

const pinnedRecoveryEvent = (turn: number): ParticipantInputEvent =>
  ParticipantInputEvent.make({
    attemptNumber: 1,
    channelId: "C252PINNED",
    context: [],
    conversationId: ThreadId.make("C252PINNED:1.0"),
    initializationStatus: "not_applicable",
    messages: [
      NormalizedMessage.make({
        authorKind: "human",
        authorSlackId: "U252PINNED",
        classification: "input",
        id: MessageId.make(`message:252:pinned:${turn}`),
        isActivation: turn === 1,
        slackTs: `252.${turn}`,
        text: `pinned recovery turn ${turn}`,
      }),
    ],
    rootTs: "252.1",
    source: "slack",
    turnId: TurnId.make(`turn:252:pinned:${turn}`),
    workingDirectory: null,
  });

const withTimeout = async <A>(
  promise: Promise<A>,
  label: string
): Promise<A> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          REQUEST_TIMEOUT_MILLIS
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const isolatedEnvironment = (home: string): NodeJS.ProcessEnv => {
  const temporaryDirectory = join(home, "tmp");
  return {
    HOME: home,
    LANG: "C.UTF-8",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PURE: "1",
    OPENCODE_TEST_HOME: home,
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
};

const projectConfig = (
  baseUrl: string,
  action: "allow" | "ask" | "deny"
): Readonly<Record<string, unknown>> => ({
  agents: {
    build: {
      permissions: [
        { action: "*", effect: "deny", resource: "*" },
        { action: "execute", effect: "allow", resource: "*" },
        { action: "policy_record", effect: action, resource: "*" },
      ],
    },
  },
  formatter: false,
  lsp: false,
  model: "permission-policy/permission-policy-model",
  permissions: [
    { action: "*", effect: "deny", resource: "*" },
    { action: "execute", effect: "allow", resource: "*" },
    { action: "policy_record", effect: action, resource: "*" },
  ],
  providers: {
    "permission-policy": {
      models: {
        "permission-policy-model": {
          capabilities: { input: ["text"], output: ["text"], tools: true },
          cost: { input: 0, output: 0 },
          limit: { context: 100_000, output: 10_000 },
          name: "Permission Policy Model",
          modelID: "permission-policy-model",
        },
      },
      name: "Permission Policy",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: {
        apiKey: "isolated-dummy-key",
        baseURL: baseUrl,
      },
    },
  },
});

const memoryProjectConfig = (
  baseUrl: string,
  memoryPermission: string
): Readonly<Record<string, unknown>> => ({
  ...projectConfig(baseUrl, "deny"),
  agents: {
    build: {
      permissions: [
        { action: "*", effect: "deny", resource: "*" },
        { action: "execute", effect: "allow", resource: "*" },
        { action: memoryPermission, effect: "ask", resource: "*" },
      ],
    },
  },
  permissions: [
    { action: "*", effect: "deny", resource: "*" },
    { action: "execute", effect: "allow", resource: "*" },
    { action: memoryPermission, effect: "ask", resource: "*" },
  ],
});

const actionProjectConfig = (
  baseUrl: string,
  actionPermissions: readonly string[],
  policy: "allow" | "ask"
): Readonly<Record<string, unknown>> => ({
  ...projectConfig(baseUrl, "deny"),
  agents: {
    build: {
      permissions: [
        { action: "*", effect: "deny", resource: "*" },
        { action: "execute", effect: "allow", resource: "*" },
        ...actionPermissions.map((permission) => ({
          action: permission,
          effect: policy,
          resource: "*",
        })),
      ],
    },
  },
  permissions: [
    { action: "*", effect: "deny", resource: "*" },
    { action: "execute", effect: "allow", resource: "*" },
    ...actionPermissions.map((permission) => ({
      action: permission,
      effect: policy,
      resource: "*",
    })),
  ],
});

const closeChild = async (
  child: ReturnType<typeof spawn>,
  connection: { readonly close: () => void }
): Promise<void> => {
  connection.close();
  child.stdin?.end();
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) =>
      child.once("close", () => resolveExit())
    ),
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
};

describe("issue #245 real pinned OpenCode permission policy", () => {
  it("scrubs the actual Action MCP subprocess environment after OpenCode merges secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-246-real-action-env-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const bootstrapPath = join(root, "action-bootstrap");
    const bootstrap = "pinned-action-bootstrap-246";
    let resolveEnvironmentNames:
      | ((names: readonly string[]) => void)
      | undefined;
    const environmentNames = new Promise<readonly string[]>((resolveNames) => {
      resolveEnvironmentNames = resolveNames;
    });
    const controlServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        try {
          assert.strictEqual(
            request.headers.authorization,
            `Bearer ${bootstrap}`
          );
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            readonly environmentNames?: unknown;
          };
          assert.ok(Array.isArray(body.environmentNames));
          assert.ok(
            body.environmentNames.every((name) => typeof name === "string")
          );
          resolveEnvironmentNames?.(body.environmentNames as string[]);
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ready":true}');
        } catch {
          response.writeHead(409, { "content-type": "application/json" });
          response.end('{"error":"rejected"}');
        }
      });
    });
    let child: ReturnType<typeof spawn> | undefined;
    let connection:
      | ReturnType<ReturnType<typeof client>["connect"]>
      | undefined;
    try {
      await Promise.all([
        mkdir(join(home, "tmp"), { mode: 0o700, recursive: true }),
        mkdir(workspace, { mode: 0o700 }),
        writeFile(bootstrapPath, bootstrap, { mode: 0o600 }),
      ]);
      await new Promise<void>((resolveListen, rejectListen) => {
        controlServer.once("error", rejectListen);
        controlServer.listen(0, "127.0.0.1", () => resolveListen());
      });
      const address = controlServer.address();
      assert.ok(address !== null && typeof address !== "string");
      await writeFile(
        join(workspace, "opencode.json"),
        JSON.stringify({ formatter: false, lsp: false }),
        { mode: 0o600 }
      );
      child = spawn(OPEN_CODE_ACP_COMMAND, [...OPEN_CODE_ACP_ARGS], {
        cwd: workspace,
        env: {
          ...isolatedEnvironment(home),
          ANTHROPIC_API_KEY: "must-not-reach-action-server",
          GITHUB_TOKEN: "must-not-reach-action-server",
          LABORER_CANARY_SECRET: "must-not-reach-action-server",
          OPENAI_API_KEY: "must-not-reach-action-server",
          SLACK_BOT_TOKEN: "must-not-reach-action-server",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const childInput = child.stdin;
      const childOutput = child.stdout;
      if (childInput === null || childOutput === null) {
        throw new Error(
          "OpenCode Action environment fixture pipes unavailable"
        );
      }
      const application = client({ name: "laborer-action-environment-proof" })
        .onRequest(methods.client.session.requestPermission, () => ({
          outcome: { outcome: "cancelled" as const },
        }))
        .onNotification(methods.client.session.update, () => undefined);
      connection = application.connect(
        ndJsonStream(
          Writable.toWeb(childInput),
          Readable.toWeb(childOutput) as ReadableStream<Uint8Array>
        )
      );
      connection.closed.catch(() => undefined);
      await withTimeout(
        connection.agent.request(methods.agent.initialize, {
          clientCapabilities: {},
          clientInfo: {
            name: "laborer-action-environment-proof",
            version: "1",
          },
          protocolVersion: PROTOCOL_VERSION,
        }),
        "initialize Action environment"
      );
      await withTimeout(
        connection.agent.request(methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [
            {
              args: [...laborerMcpServerLauncherArgs("action")],
              command: process.execPath,
              env: [
                {
                  name: "LABORER_ACTION_BOOTSTRAP_PATH",
                  value: bootstrapPath,
                },
                {
                  name: "LABORER_ACTION_CONTROL_URL",
                  value: `http://127.0.0.1:${address.port}`,
                },
                { name: "LABORER_ACTION_SERVER_GENERATION", value: "246" },
                {
                  name: "LABORER_ACTION_SERVER_NAME",
                  value: "laborer-actions-pinned-246",
                },
              ],
              name: "laborer-actions-pinned-246",
            },
          ],
        }),
        "session/new Action environment"
      );
      const observedNames = await withTimeout(
        environmentNames,
        "Action environment attestation"
      );
      for (const forbiddenName of [
        "ANTHROPIC_API_KEY",
        "GITHUB_TOKEN",
        "HOME",
        "LABORER_CANARY_SECRET",
        "OPENAI_API_KEY",
        "OPENCODE_AUTH_CONTENT",
        "SLACK_BOT_TOKEN",
        "XDG_CONFIG_HOME",
      ]) {
        assert.ok(!observedNames.includes(forbiddenName));
      }
    } finally {
      if (child !== undefined && connection !== undefined) {
        await closeChild(child, connection);
      } else {
        child?.kill("SIGKILL");
      }
      await new Promise<void>((resolveClose) =>
        controlServer.close(() => resolveClose())
      );
      await rm(root, { force: true, recursive: true });
    }
  }, 120_000);

  it("invokes feature and bug Actions through real pinned OpenCode sessions under allow and ask policies", async () => {
    for (const policy of ["allow", "ask"] as const) {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), `laborer-246-real-action-${policy}-`))
      );
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const provider = await startFakeOpenAiProvider();
      let child: ReturnType<typeof spawn> | undefined;
      let connection:
        | ReturnType<ReturnType<typeof client>["connect"]>
        | undefined;
      let closeBridge: (() => Promise<void>) | undefined;
      try {
        await Promise.all([
          mkdir(join(home, "tmp"), { mode: 0o700, recursive: true }),
          mkdir(workspace, { mode: 0o700 }),
        ]);
        const authority = await Effect.runPromise(
          makeAcpAuthorityRepository({
            keyPath: join(root, "authority.key"),
            statePath: join(root, "authority.json"),
            trustedRoot: root,
          })
        );
        const ownedBridge = await Effect.runPromise(
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            const bridge = yield* makeLaborerActionMcpBridge({
              authorityRepository: authority,
              bootstrapPath: join(root, "action-bootstrap"),
              processGeneration: 246,
              root: workspace,
              rootAuthority: "pinned-open-code-root-authority",
              statePath: join(root, "action-capabilities.json"),
              trustedRuntimeRoot: root,
              workspaceId: "T246PINNEDACTION",
            }).pipe(Effect.provideService(Scope.Scope, scope));
            return { bridge, scope };
          })
        );
        const bridge = ownedBridge.bridge;
        closeBridge = () =>
          Effect.runPromise(Scope.close(ownedBridge.scope, Exit.void));
        const actionPermissions = {
          "create-feature": `${bridge.serverName}_create-feature`,
          "deal-with-bug": `${bridge.serverName}_deal-with-bug`,
        } as const;
        await writeFile(
          join(workspace, "opencode.json"),
          JSON.stringify(
            actionProjectConfig(
              provider.baseUrl,
              Object.values(actionPermissions),
              policy
            )
          ),
          { mode: 0o600 }
        );
        const trustedInvocations: TrustedActionInvocation[] = [];
        const invokedActionNames: ConversationAction["name"][] = [];
        const actions: readonly ConversationAction[] = (
          ["create-feature", "deal-with-bug"] as const
        ).map((actionName) => ({
          description:
            productionActionCatalog.tools.find(
              (tool) => tool.name === actionName
            )?.description ?? "",
          invoke: (_input, trustedInvocation) =>
            Effect.sync(() => {
              assert.ok(trustedInvocation);
              trustedInvocations.push(trustedInvocation);
              invokedActionNames.push(actionName);
              return {
                actionName,
                deduplicated: false,
                executionId: `execution:pinned:${policy}:${actionName}`,
                status: "running" as const,
              };
            }),
          name: actionName,
        }));
        let genericPermissionRequests = 0;
        let internalAllows = 0;
        const permissionRequests: RequestPermissionRequest[] = [];
        const sessionUpdates: unknown[] = [];
        child = spawn(OPEN_CODE_ACP_COMMAND, [...OPEN_CODE_ACP_ARGS], {
          cwd: workspace,
          env: isolatedEnvironment(home),
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Uint8Array) => {
          stderr = `${stderr}${Buffer.from(chunk).toString("utf8")}`.slice(
            -4000
          );
        });
        const childInput = child.stdin;
        const childOutput = child.stdout;
        if (childInput === null || childOutput === null) {
          throw new Error("OpenCode Action fixture pipes are unavailable");
        }
        const application = client({ name: "laborer-action-permission-proof" })
          .onRequest(
            methods.client.session.requestPermission,
            async ({ params }) => {
              permissionRequests.push(params);
              const decision = await Effect.runPromise(
                bridge.tryAuthorizePermission(params)
              );
              if (decision === null) {
                genericPermissionRequests += 1;
                return { outcome: { outcome: "cancelled" as const } };
              }
              if (decision.outcome.outcome === "selected") {
                internalAllows += 1;
              }
              return decision;
            }
          )
          .onNotification(methods.client.session.update, ({ params }) => {
            sessionUpdates.push(params);
            bridge.observeToolCall(params);
          });
        connection = application.connect(
          ndJsonStream(
            Writable.toWeb(childInput),
            Readable.toWeb(childOutput) as ReadableStream<Uint8Array>
          )
        );
        connection.closed.catch(() => undefined);
        const initialized = await withTimeout(
          connection.agent.request(methods.agent.initialize, {
            clientCapabilities: {},
            clientInfo: {
              name: "laborer-action-permission-proof",
              version: "1",
            },
            protocolVersion: PROTOCOL_VERSION,
          }),
          `initialize Action ${policy}`
        );
        assert.strictEqual(initialized.agentInfo?.version, "0.0.0-next-17055");

        const sessionIds: string[] = [];
        for (const { actionName, attempt } of [
          { actionName: "create-feature", attempt: 1 },
          { actionName: "deal-with-bug", attempt: 2 },
        ] as const) {
          const registration = await Effect.runPromise(
            bridge.prepareRegistration
          );
          const session = await withTimeout(
            connection.agent.request(methods.agent.session.new, {
              cwd: workspace,
              mcpServers: [registration.server],
            }),
            `session/new Action ${policy} ${attempt}`
          );
          const sessionId = session.sessionId;
          sessionIds.push(sessionId);
          await Effect.runPromise(bridge.awaitReadiness(registration));
          const closeTurn = await Effect.runPromise(
            bridge.activateTurn({
              actionServerGeneration: registration.actionServerGeneration,
              actions,
              scope: {
                bindingGeneration: attempt,
                channelId: "C246PINNEDACTION",
                conversationId: "workspace:T246PINNEDACTION:C246:1.0",
                processGeneration: 246,
                promptId: `prompt:pinned:${policy}:${attempt}`,
                rootTs: "1.0",
                sessionId,
                turnId: `turn:pinned:${policy}:${attempt}`,
                workspaceId: "T246PINNEDACTION",
              },
            })
          );
          const input = {
            prompt: `Invoke ${actionName} attempt ${attempt} under ${policy}.`,
            worktreeName: `pinned-${policy}-${attempt}`,
          };
          provider.enqueue({
            input,
            kind: "tool",
            name: actionPermissions[actionName],
          });
          await withTimeout(
            connection.agent.request(methods.agent.session.prompt, {
              prompt: [
                {
                  text: `exercise ${actionName} ${attempt} under ${policy}`,
                  type: "text",
                },
              ],
              sessionId,
            }),
            `session/prompt Action ${policy} ${attempt}; stderr=${stderr}`
          );
          await Effect.runPromise(closeTurn);
        }

        assert.strictEqual(
          trustedInvocations.length,
          2,
          `Action calls were not observed; stderr=${stderr}; generic=${genericPermissionRequests}; internal=${internalAllows}; permissions=${JSON.stringify(permissionRequests)}; updates=${JSON.stringify(sessionUpdates)}`
        );
        assert.notStrictEqual(
          trustedInvocations[0]?.operationId,
          trustedInvocations[1]?.operationId
        );
        assert.deepStrictEqual(invokedActionNames, [
          "create-feature",
          "deal-with-bug",
        ]);
        assert.strictEqual(new Set(sessionIds).size, 2);
        assert.strictEqual(genericPermissionRequests, 0);
        assert.strictEqual(permissionRequests.length, policy === "ask" ? 2 : 0);
        assert.strictEqual(internalAllows, policy === "ask" ? 2 : 0);
      } finally {
        if (child !== undefined && connection !== undefined) {
          await closeChild(child, connection);
        } else {
          child?.kill("SIGKILL");
        }
        await provider.close();
        await closeBridge?.();
        await rm(root, { force: true, recursive: true });
      }
    }
  }, 120_000);

  it("places ordinary, feature, and bug intent selection in the pinned Conversation model", async () => {
    const ordinaryUtterance =
      "Selection case ordinary: discuss the words feature and bug, but only reply conversationally.";
    const featureUtterance =
      "Selection case feature: please add export support to the product.";
    const bugUtterance =
      "Selection case bug: the existing export crashes and needs diagnosis.";
    let actionPermissions:
      | Readonly<Record<"create-feature" | "deal-with-bug", string>>
      | undefined;
    const modelSelections: string[] = [];
    // This deterministic model proves ownership of the selection seam, not model quality.
    const provider = await startFakeOpenAiProvider({
      selectReply: (request) => {
        const serialized = JSON.stringify(request);
        if (
          serialized.includes('"role":"tool"') ||
          serialized.includes('"tool_call_id"')
        ) {
          return { kind: "text", text: "Selected coding work is underway." };
        }
        if (serialized.includes(ordinaryUtterance)) {
          modelSelections.push("ordinary");
          return { kind: "text", text: "This is only a conversation reply." };
        }
        if (serialized.includes(featureUtterance)) {
          modelSelections.push("create-feature");
          return {
            input: {
              prompt: "Implement model-selected export support.",
              worktreeName: "model-selected-feature",
            },
            kind: "tool",
            name: actionPermissions?.["create-feature"] ?? "missing-feature",
          };
        }
        if (serialized.includes(bugUtterance)) {
          modelSelections.push("deal-with-bug");
          return {
            input: {
              prompt: "Diagnose and fix the model-selected export crash.",
              worktreeName: "model-selected-bug",
            },
            kind: "tool",
            name: actionPermissions?.["deal-with-bug"] ?? "missing-bug",
          };
        }
        return undefined;
      },
    });
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "laborer-248-model-intent-selection-"))
    );
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    let child: ReturnType<typeof spawn> | undefined;
    let connection:
      | ReturnType<ReturnType<typeof client>["connect"]>
      | undefined;
    let closeBridge: (() => Promise<void>) | undefined;
    try {
      await Promise.all([
        mkdir(join(home, "tmp"), { mode: 0o700, recursive: true }),
        mkdir(workspace, { mode: 0o700 }),
      ]);
      const authority = await Effect.runPromise(
        makeAcpAuthorityRepository({
          keyPath: join(root, "authority.key"),
          statePath: join(root, "authority.json"),
          trustedRoot: root,
        })
      );
      const ownedBridge = await Effect.runPromise(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const bridge = yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(root, "action-bootstrap"),
            processGeneration: 248,
            root: workspace,
            rootAuthority: "pinned-model-selection-authority",
            statePath: join(root, "action-capabilities.json"),
            trustedRuntimeRoot: root,
            workspaceId: "T248MODELSELECTION",
          }).pipe(Effect.provideService(Scope.Scope, scope));
          return { bridge, scope };
        })
      );
      const bridge = ownedBridge.bridge;
      closeBridge = () =>
        Effect.runPromise(Scope.close(ownedBridge.scope, Exit.void));
      actionPermissions = {
        "create-feature": `${bridge.serverName}_create-feature`,
        "deal-with-bug": `${bridge.serverName}_deal-with-bug`,
      };
      await writeFile(
        join(workspace, "opencode.json"),
        JSON.stringify(
          actionProjectConfig(
            provider.baseUrl,
            Object.values(actionPermissions),
            "allow"
          )
        ),
        { mode: 0o600 }
      );
      const invokedActions: ConversationAction["name"][] = [];
      const actions: readonly ConversationAction[] = (
        ["create-feature", "deal-with-bug"] as const
      ).map((actionName) => ({
        description:
          productionActionCatalog.tools.find((tool) => tool.name === actionName)
            ?.description ?? "",
        invoke: (_input, trustedInvocation) =>
          Effect.sync(() => {
            assert.ok(trustedInvocation);
            invokedActions.push(actionName);
            return {
              actionName,
              deduplicated: false,
              executionId: `execution:model-selected:${actionName}`,
              status: "running" as const,
            };
          }),
        name: actionName,
      }));
      const observedTools: string[] = [];
      child = spawn(OPEN_CODE_ACP_COMMAND, [...OPEN_CODE_ACP_ARGS], {
        cwd: workspace,
        env: isolatedEnvironment(home),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const childInput = child.stdin;
      const childOutput = child.stdout;
      if (childInput === null || childOutput === null) {
        throw new Error("OpenCode model-selection fixture pipes unavailable");
      }
      const application = client({ name: "laborer-model-selection-proof" })
        .onRequest(
          methods.client.session.requestPermission,
          async ({ params }) =>
            (await Effect.runPromise(
              bridge.tryAuthorizePermission(params)
            )) ?? {
              outcome: { outcome: "cancelled" as const },
            }
        )
        .onNotification(methods.client.session.update, ({ params }) => {
          const update = params.update;
          if (
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update"
          ) {
            const identity =
              typeof update.name === "string" ? update.name : update.title;
            if (typeof identity === "string") {
              observedTools.push(identity);
            }
          }
          bridge.observeToolCall(params);
        });
      connection = application.connect(
        ndJsonStream(
          Writable.toWeb(childInput),
          Readable.toWeb(childOutput) as ReadableStream<Uint8Array>
        )
      );
      connection.closed.catch(() => undefined);
      await withTimeout(
        connection.agent.request(methods.agent.initialize, {
          clientCapabilities: {},
          clientInfo: { name: "laborer-model-selection-proof", version: "1" },
          protocolVersion: PROTOCOL_VERSION,
        }),
        "initialize model-selection proof"
      );

      for (const [index, utterance] of [
        ordinaryUtterance,
        featureUtterance,
        bugUtterance,
      ].entries()) {
        const registration = await Effect.runPromise(
          bridge.prepareRegistration
        );
        const session = await withTimeout(
          connection.agent.request(methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [registration.server],
          }),
          `model-selection session ${index}`
        );
        await Effect.runPromise(bridge.awaitReadiness(registration));
        const closeTurn = await Effect.runPromise(
          bridge.activateTurn({
            actionServerGeneration: registration.actionServerGeneration,
            actions,
            scope: {
              bindingGeneration: index + 1,
              channelId: "C248MODELSELECTION",
              conversationId: `workspace:T248MODELSELECTION:C248:${index}`,
              processGeneration: 248,
              promptId: `prompt:model-selection:${index}`,
              rootTs: String(index),
              sessionId: session.sessionId,
              turnId: `turn:model-selection:${index}`,
              workspaceId: "T248MODELSELECTION",
            },
          })
        );
        await withTimeout(
          connection.agent.request(methods.agent.session.prompt, {
            prompt: [{ text: utterance, type: "text" }],
            sessionId: session.sessionId,
          }),
          `model-selection prompt ${index}`
        );
        await Effect.runPromise(closeTurn);
        if (index === 0) {
          assert.deepStrictEqual(invokedActions, []);
          assert.deepStrictEqual(observedTools, []);
        }
      }

      assert.deepStrictEqual(
        [...new Set(modelSelections)],
        ["ordinary", "create-feature", "deal-with-bug"]
      );
      assert.deepStrictEqual(invokedActions, [
        "create-feature",
        "deal-with-bug",
      ]);
      assert.ok(observedTools.includes(actionPermissions["create-feature"]));
      assert.ok(observedTools.includes(actionPermissions["deal-with-bug"]));
      for (const utterance of [
        ordinaryUtterance,
        featureUtterance,
        bugUtterance,
      ]) {
        const modelRequest = provider.requests.find((request) => {
          const serialized = JSON.stringify(request);
          return (
            serialized.includes(utterance) && serialized.includes('"tools"')
          );
        });
        assert.ok(modelRequest);
        const serialized = JSON.stringify(modelRequest);
        assert.ok(serialized.includes(actionPermissions["create-feature"]));
        assert.ok(serialized.includes(actionPermissions["deal-with-bug"]));
      }
    } finally {
      if (child !== undefined && connection !== undefined) {
        await closeChild(child, connection);
      } else {
        child?.kill("SIGKILL");
      }
      await provider.close();
      await closeBridge?.();
      await rm(root, { force: true, recursive: true });
    }
  }, 120_000);

  it("executes project allow and enforces project deny without ACP/Slack interaction", async () => {
    const version = await execFilePromise(OPEN_CODE_EXECUTABLE, ["--version"], {
      env: isolatedEnvironment(
        await mkdtemp(join(tmpdir(), "laborer-245-version-"))
      ),
    });
    assert.strictEqual(
      version.stdout.trim().replace(OPEN_CODE_2_VERSION_PREFIX, ""),
      "0.0.0-next-17055"
    );

    for (const action of ["allow", "deny"] as const) {
      const root = await mkdtemp(join(tmpdir(), `laborer-245-real-${action}-`));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const observationPath = join(root, "mcp-observation.jsonl");
      const provider = await startFakeOpenAiProvider();
      let child: ReturnType<typeof spawn> | undefined;
      let connection:
        | ReturnType<ReturnType<typeof client>["connect"]>
        | undefined;
      try {
        await Promise.all([
          mkdir(join(home, "tmp"), { mode: 0o700, recursive: true }),
          mkdir(workspace, { mode: 0o700 }),
        ]);
        await writeFile(
          join(workspace, "opencode.json"),
          JSON.stringify(projectConfig(provider.baseUrl, action)),
          { mode: 0o600 }
        );
        provider.enqueue({
          input: { value: `${action}-side-effect` },
          kind: "tool",
          name: "policy_record",
        });
        const permissionRequests: RequestPermissionRequest[] = [];
        child = spawn(OPEN_CODE_ACP_COMMAND, [...OPEN_CODE_ACP_ARGS], {
          cwd: workspace,
          env: isolatedEnvironment(home),
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Uint8Array) => {
          stderr = `${stderr}${Buffer.from(chunk).toString("utf8")}`.slice(
            -4000
          );
        });
        const childInput = child.stdin;
        const childOutput = child.stdout;
        if (childInput === null || childOutput === null) {
          throw new Error("OpenCode ACP fixture pipes are unavailable");
        }
        const application = client({ name: "laborer-permission-policy-proof" })
          .onRequest(methods.client.session.requestPermission, ({ params }) => {
            permissionRequests.push(params);
            return { outcome: { outcome: "cancelled" as const } };
          })
          .onNotification(methods.client.session.update, () => undefined);
        connection = application.connect(
          ndJsonStream(
            Writable.toWeb(childInput),
            Readable.toWeb(childOutput) as ReadableStream<Uint8Array>
          )
        );
        connection.closed.catch(() => undefined);
        const initialized = await withTimeout(
          connection.agent.request(methods.agent.initialize, {
            clientCapabilities: {},
            clientInfo: {
              name: "laborer-permission-policy-proof",
              version: "1",
            },
            protocolVersion: PROTOCOL_VERSION,
          }),
          `initialize ${action}`
        );
        assert.strictEqual(initialized.agentInfo?.version, "0.0.0-next-17055");
        const session = await withTimeout(
          connection.agent.request(methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [
              {
                args: [MCP_FIXTURE],
                command: process.execPath,
                env: [
                  {
                    name: "ACP_PERMISSION_POLICY_OBSERVATION",
                    value: observationPath,
                  },
                ],
                name: "policy",
              },
            ],
          }),
          `session/new ${action}`
        );
        await withTimeout(
          connection.agent.request(methods.agent.session.prompt, {
            prompt: [
              { text: `exercise the project ${action} policy`, type: "text" },
            ],
            sessionId: session.sessionId,
          }),
          `session/prompt ${action}; stderr=${stderr}`
        );
        assert.deepStrictEqual(permissionRequests, []);
        let sideEffectExists = true;
        try {
          await stat(observationPath);
        } catch {
          sideEffectExists = false;
        }
        assert.strictEqual(sideEffectExists, action === "allow");
        if (action === "allow") {
          assert.ok(
            (await readFile(observationPath, "utf8")).includes(
              "allow-side-effect"
            )
          );
        }
      } finally {
        if (child !== undefined && connection !== undefined) {
          await closeChild(child, connection);
        } else {
          child?.kill("SIGKILL");
        }
        await provider.close();
        await rm(root, { force: true, recursive: true });
      }
    }
  }, 120_000);

  it("internally allows a real pinned memory MCP invocation without generic approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "laborer-245-real-memory-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const provider = await startFakeOpenAiProvider();
    let child: ReturnType<typeof spawn> | undefined;
    let connection:
      | ReturnType<ReturnType<typeof client>["connect"]>
      | undefined;
    try {
      await Promise.all([
        mkdir(join(home, "tmp"), { mode: 0o700, recursive: true }),
        mkdir(workspace, { mode: 0o700 }),
      ]);
      const sources = await Effect.runPromise(
        prepareAcpAgentContextSources({
          root: workspace,
          workspaceId: "T245PINNEDMEMORY",
        })
      );
      const prepared = await Effect.runPromise(
        prepareLaborerMemoryMcpRegistration(
          makeLaborerMemoryMcpServerConfiguration(sources),
          sources.root
        )
      );
      const memoryPermission = laborerMemoryOpenCodePermission(
        prepared.server.name
      );
      await writeFile(
        join(workspace, "opencode.json"),
        JSON.stringify(memoryProjectConfig(provider.baseUrl, memoryPermission)),
        { mode: 0o600 }
      );
      provider.enqueue({
        input: {
          operation: "add",
          target: "workspace",
          text: "real pinned memory permission proof",
        },
        kind: "tool",
        name: memoryPermission,
      });
      const registrations = new Map<
        string,
        Parameters<
          typeof tryAuthorizeLaborerMemoryPermission
        >[1] extends ReadonlyMap<string, infer Registration>
          ? Registration
          : never
      >();
      let genericPermissionRequests = 0;
      let internalAllows = 0;
      const memoryPermissionRequests: RequestPermissionRequest[] = [];
      const memoryPendingUpdates: Array<{
        readonly kind?: unknown;
        readonly name?: unknown;
        readonly rawInput?: unknown;
        readonly status?: unknown;
        readonly title?: unknown;
        readonly toolCallId: string;
      }> = [];
      child = spawn(OPEN_CODE_ACP_COMMAND, [...OPEN_CODE_ACP_ARGS], {
        cwd: workspace,
        env: {
          ...isolatedEnvironment(home),
          ANTHROPIC_API_KEY: "must-not-reach-memory-server",
          GITHUB_TOKEN: "must-not-reach-memory-server",
          LABORER_CANARY_SECRET: "must-not-reach-memory-server",
          OPENAI_API_KEY: "must-not-reach-memory-server",
          SLACK_BOT_TOKEN: "must-not-reach-memory-server",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Uint8Array) => {
        stderr = `${stderr}${Buffer.from(chunk).toString("utf8")}`.slice(-4000);
      });
      const childInput = child.stdin;
      const childOutput = child.stdout;
      if (childInput === null || childOutput === null) {
        throw new Error("OpenCode ACP fixture pipes are unavailable");
      }
      const application = client({ name: "laborer-memory-permission-proof" })
        .onRequest(methods.client.session.requestPermission, ({ params }) => {
          memoryPermissionRequests.push(params);
          const decision = tryAuthorizeLaborerMemoryPermission(
            params,
            registrations
          );
          if (decision === null) {
            genericPermissionRequests += 1;
            return { outcome: { outcome: "cancelled" as const } };
          }
          if (decision.outcome.outcome === "selected") {
            internalAllows += 1;
          }
          return decision;
        })
        .onNotification(methods.client.session.update, ({ params }) => {
          if (params.update.sessionUpdate === "tool_call") {
            memoryPendingUpdates.push(params.update);
          }
          observeLaborerMemoryToolCall(params, registrations);
        });
      connection = application.connect(
        ndJsonStream(
          Writable.toWeb(childInput),
          Readable.toWeb(childOutput) as ReadableStream<Uint8Array>
        )
      );
      connection.closed.catch(() => undefined);
      const initialized = await withTimeout(
        connection.agent.request(methods.agent.initialize, {
          clientCapabilities: {},
          clientInfo: { name: "laborer-memory-permission-proof", version: "1" },
          protocolVersion: PROTOCOL_VERSION,
        }),
        "initialize memory"
      );
      assert.strictEqual(initialized.agentInfo?.name, "OpenCode");
      assert.strictEqual(initialized.agentInfo?.version, "0.0.0-next-17055");
      const session = await withTimeout(
        connection.agent.request(methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [prepared.server],
        }),
        "session/new memory"
      );
      registrations.set(session.sessionId, {
        consumedToolCallIds: new Set(),
        gate: {
          acceptingCalls: true,
          activeToolCallIds: new Set(),
          safetyDenialObserved: false,
        },
        generation: prepared.readinessNonce,
        observedFingerprints: new Map(),
        observedToolCallIds: new Set(),
        permission: memoryPermission,
        pinnedOpenCodeVersion: "0.0.0-next-17055",
        rejectedToolCallIds: new Set(),
        rejectUncorrelatedPermissions: false,
      });
      const memoryServerEnvironmentNames = await Effect.runPromise(
        awaitLaborerMemoryMcpReadiness(prepared)
      );
      for (const forbiddenName of [
        "ANTHROPIC_API_KEY",
        "GITHUB_TOKEN",
        "HOME",
        "LABORER_CANARY_SECRET",
        "OPENAI_API_KEY",
        "OPENCODE_AUTH_CONTENT",
        "SLACK_BOT_TOKEN",
        "XDG_CONFIG_HOME",
      ]) {
        assert.ok(!memoryServerEnvironmentNames.includes(forbiddenName));
      }
      await withTimeout(
        connection.agent.request(methods.agent.session.prompt, {
          prompt: [{ text: "remember this proof", type: "text" }],
          sessionId: session.sessionId,
        }),
        `session/prompt memory; stderr=${stderr}`
      );
      assert.strictEqual(genericPermissionRequests, 0);
      assert.strictEqual(internalAllows, 1);
      assert.strictEqual(memoryPermissionRequests.length, 1);
      assert.strictEqual(memoryPendingUpdates.length, 1);
      const permissionToolCall = memoryPermissionRequests[0]?.toolCall;
      const pendingToolCall = memoryPendingUpdates[0];
      assert.strictEqual(permissionToolCall?.name, memoryPermission);
      assert.strictEqual(pendingToolCall?.name, memoryPermission);
      assert.strictEqual(permissionToolCall?.title, memoryPermission);
      assert.strictEqual(pendingToolCall?.title, memoryPermission);
      assert.strictEqual(permissionToolCall?.kind, "other");
      assert.strictEqual(pendingToolCall?.kind, "other");
      assert.strictEqual(permissionToolCall?.status, "pending");
      assert.strictEqual(pendingToolCall?.status, "pending");
      assert.strictEqual(
        permissionToolCall?.toolCallId,
        pendingToolCall?.toolCallId
      );
      assert.deepStrictEqual(
        permissionToolCall?.rawInput,
        pendingToolCall?.rawInput
      );
      assert.ok(
        (await readFile(sources.workspaceMemoryPath, "utf8")).includes(
          "real pinned memory permission proof"
        )
      );
    } finally {
      if (child !== undefined && connection !== undefined) {
        await closeChild(child, connection);
      } else {
        child?.kill("SIGKILL");
      }
      await provider.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 120_000);

  it("restarts real pinned OpenCode 0.0.0-next-17055 and resumes with Memory and Action registrations", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const directory = await mkdtemp(
                join(tmpdir(), "laborer-252-pinned-recovery-")
              );
              return await realpath(directory);
            }),
            (directory) =>
              Effect.promise(() =>
                rm(directory, { force: true, recursive: true })
              )
          );
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          yield* Effect.promise(() =>
            Promise.all([
              mkdir(join(home, "tmp"), { mode: 0o700, recursive: true }),
              mkdir(workspace, { mode: 0o700 }),
            ])
          );
          const provider = yield* Effect.acquireRelease(
            Effect.promise(() => startFakeOpenAiProvider()),
            (owned) => Effect.promise(owned.close)
          );
          yield* Effect.promise(() =>
            writeFile(
              join(workspace, "opencode.json"),
              JSON.stringify(projectConfig(provider.baseUrl, "deny")),
              { mode: 0o600 }
            )
          );
          const pidPath = join(root, "opencode.pid");
          const wrapper = join(root, "pinned-opencode");
          yield* Effect.promise(async () => {
            await writeFile(
              wrapper,
              `#!/bin/sh\nprintf '%s' "$$" > "$PINNED_OPENCODE_PID_PATH"\nexec "${OPEN_CODE_EXECUTABLE}" "$@"\n`,
              { mode: 0o700 }
            );
            await chmod(wrapper, 0o700);
          });
          const sources = yield* prepareAcpAgentContextSources({
            root: workspace,
            workspaceId: "T252PINNED",
          });
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(root, "authority.key"),
            statePath: join(root, "authority.json"),
            trustedRoot: root,
          });
          const processState = yield* makeAcpProcessStateRepository({
            path: join(root, "process-state.json"),
            trustedRoot: root,
          });
          const environment = {
            ...isolatedEnvironment(home),
            PINNED_OPENCODE_PID_PATH: pidPath,
          };
          const supervisor = yield* makeAcpConversationProcessSupervisor({
            jitter: () => 0,
            makeGeneration: (generation) =>
              Effect.gen(function* () {
                const actionBridge = yield* makeLaborerActionMcpBridge({
                  authorityRepository: authority,
                  bootstrapPath: join(root, "action-bootstrap"),
                  processGeneration: generation.generation,
                  root: workspace,
                  rootAuthority: `${workspace}:pinned`,
                  statePath: join(root, "action-capabilities.json"),
                  trustedRuntimeRoot: root,
                  workspaceId: "T252PINNED",
                });
                return yield* makeAcpConversationAgent({
                  actionMcpBridge: actionBridge,
                  agentContext: sources,
                  args: ["acp"],
                  authorityRepository: authority,
                  command: wrapper,
                  cwd: workspace,
                  durableSessionMode: true,
                  environment,
                  memoryMcpServer:
                    makeLaborerMemoryMcpServerConfiguration(sources),
                  participantLookup: {
                    lookupVisibleName: () => Effect.succeed("Pinned Human"),
                  },
                  processCleanupObserver: generation.observeCleanup,
                  processExitObserver: (code, signal) =>
                    generation.observeExit({ code, signal }),
                  processFailureObserver:
                    generation.observeFailureClassification,
                  processGeneration: generation.generation,
                  processHealthObserver: generation.observeHealth,
                  requireDurableCapabilitiesAtStartup: true,
                  testHooks: { treatCommandAsOpenCode: true },
                });
              }),
            repository: processState,
            workspaceId: "T252PINNED",
          });
          const applicationRepository = yield* makeFileApplicationRepository(
            join(root, "application.json"),
            root
          );
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: supervisor.agent,
            implementationAgent: {
              start: () => Effect.die(new Error("not used")),
            },
            repository: applicationRepository,
            worktreeManager: {
              create: () => Effect.die(new Error("not used")),
            },
          });
          const acceptEvent = () =>
            Effect.succeed({
              decision: {
                _tag: "Accepted" as const,
                eventId: "accepted:252:pinned",
              },
              scheduling: "Scheduled" as const,
            });
          provider.enqueue({ kind: "text", text: "pinned first complete" });
          yield* application.handle(
            pinnedRecoveryEvent(1),
            () => Effect.void,
            acceptEvent
          );
          const firstPid = Number(
            yield* Effect.promise(() => readFile(pidPath, "utf8"))
          );
          yield* Effect.sync(() => process.kill(firstPid, "SIGKILL"));
          for (let attempt = 0; attempt < 1000; attempt += 1) {
            const health = yield* supervisor.health;
            if (health.health === "ready" && health.generation === 2) {
              break;
            }
            yield* Effect.sleep("10 millis");
          }
          assert.strictEqual((yield* supervisor.health).generation, 2);
          provider.enqueue({ kind: "text", text: "pinned second complete" });
          yield* application.handle(
            pinnedRecoveryEvent(2),
            () => Effect.void,
            acceptEvent
          );
          const state = yield* applicationRepository.load;
          const binding = state.conversations[0]?.agentSessionBinding;
          assert.strictEqual(binding?.lastAttachedProcessGeneration, 2);
          assert.deepStrictEqual(
            binding?.effectiveMetadata?.clientMcpServerNames.length,
            2
          );
          assert.strictEqual(provider.requests.length >= 2, true);
        })
      )
    );
  }, 120_000);
});
