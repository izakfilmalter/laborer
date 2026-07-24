import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeGitWorktreeManager } from "../src/adapters/git-worktree-manager.ts";
import {
  launchOpenCodeServer,
  makeOpenCodeConversationAgent,
  makeOpenCodeImplementationAgent,
  type OpenCodeSessionClient,
} from "../src/adapters/opencode-agents.ts";
import type { ConversationAgentRequest } from "../src/reference-coding-application.ts";

const execFilePromise = promisify(execFile);
const sandboxes = new Set<string>();

const git = async (
  repository: string,
  args: readonly string[]
): Promise<void> => {
  await execFilePromise("git", ["-C", repository, ...args]);
};

const makeRepository = async (): Promise<{
  readonly repository: string;
  readonly sandbox: string;
  readonly sourceDirectory: string;
}> => {
  const sandbox = await mkdtemp(
    join(await realpath(tmpdir()), "laborer-eighth-adapter-")
  );
  sandboxes.add(sandbox);
  const repository = join(sandbox, "laborer");
  const sourceDirectory = join(repository, "next");
  await mkdir(sourceDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(repository, ".gitignore"), "next/.env.local\n"),
    writeFile(join(repository, "README.md"), "fixture\n"),
    writeFile(join(sourceDirectory, "package.json"), "{}\n"),
    writeFile(join(sourceDirectory, ".env.local"), "SECRET=required\n", {
      mode: 0o600,
    }),
  ]);
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Adapter Review"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  return { repository, sandbox, sourceDirectory };
};

const effectFailed = async (
  effect: Effect.Effect<unknown, unknown>
): Promise<boolean> => (await Effect.runPromiseExit(effect))._tag === "Failure";

const conversationRequest = (
  overrides: Partial<ConversationAgentRequest> = {}
): ConversationAgentRequest => ({
  actions: [],
  context: [],
  conversationId: "conversation-1",
  conversationSessionId: "conversation-session-1",
  conversationSessionIsNew: false,
  executionControls: [],
  executions: [],
  input: "Help",
  messages: [],
  promptId: "persisted-prompt-1",
  source: "slack",
  turnId: "turn-1",
  ...overrides,
});

const inertClient = (
  overrides: Partial<OpenCodeSessionClient> = {}
): OpenCodeSessionClient => ({
  createSession: () => Effect.void,
  interrupt: () => Effect.void,
  readMessages: () => Effect.succeed([]),
  sessionExists: () => Effect.succeed(true),
  submitPrompt: () => Effect.void,
  wait: () => Effect.void,
  ...overrides,
});

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for adapter test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

afterEach(async () => {
  await Promise.all(
    [...sandboxes].map((sandbox) =>
      rm(sandbox, { force: true, recursive: true })
    )
  );
  sandboxes.clear();
});

describe("eighth adapter review regressions", () => {
  it("does not validate a checkout missing its required environment copy and repairs only its exact registration", async () => {
    const fixture = await makeRepository();
    const worktreePath = join(
      fixture.sandbox,
      "laborer.worktrees",
      "interrupted-create"
    );
    await mkdir(dirname(worktreePath), { recursive: true });
    await git(fixture.repository, [
      "worktree",
      "add",
      "-b",
      "laborer/interrupted-create",
      worktreePath,
      "HEAD",
    ]);
    const manager = makeGitWorktreeManager({
      repository: fixture.sourceDirectory,
    });
    const request = {
      conversationId: "conversation-1",
      executionId: "execution-1",
      worktreeName: "interrupted-create",
    } as const;
    const workingDirectory = join(worktreePath, "next");

    expect(manager.validate).toBeDefined();
    expect(manager.recover).toBeDefined();
    if (manager.validate === undefined || manager.recover === undefined) {
      throw new Error("Worktree recovery interfaces are unavailable");
    }
    expect(
      await effectFailed(manager.validate({ ...request, workingDirectory }))
    ).toBe(true);

    await Effect.runPromise(manager.recover(request));

    expect(await readFile(join(workingDirectory, ".env.local"), "utf8")).toBe(
      "SECRET=required\n"
    );
    expect(
      (await stat(join(workingDirectory, ".env.local"))).mode % 0o1000
    ).toBe(0o600);
    await Effect.runPromise(manager.validate({ ...request, workingDirectory }));
  });

  it("terminates the whole Git process group when an Effect is interrupted", async () => {
    const sandbox = await mkdtemp(
      join(await realpath(tmpdir()), "laborer-git-interrupt-")
    );
    sandboxes.add(sandbox);
    const repository = join(sandbox, "repository");
    const executableDirectory = join(sandbox, "bin");
    const parentPidPath = join(sandbox, "parent.pid");
    const childPidPath = join(sandbox, "child.pid");
    await Promise.all([
      mkdir(repository, { recursive: true }),
      mkdir(executableDirectory, { recursive: true }),
    ]);
    await writeFile(
      join(executableDirectory, "git"),
      `#!/bin/sh
if [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then
  printf '%s\n' "$FAKE_REPOSITORY"
  exit 0
fi
if [ "$3" = "for-each-ref" ]; then
  exit 0
fi
if [ "$3" = "worktree" ] && [ "$4" = "list" ]; then
  exit 0
fi
if [ "$3" = "worktree" ] && [ "$4" = "add" ]; then
  trap '' TERM
  /bin/sh -c 'trap "" TERM; printf "%s" "$$" > "$CHILD_PID_PATH"; while :; do /bin/sleep 1; done' &
  printf '%s' "$$" > "$PARENT_PID_PATH"
  while :; do /bin/sleep 1; done
fi
exit 1
`,
      { mode: 0o700 }
    );
    const previousPath = process.env.PATH;
    process.env.PATH = executableDirectory;
    process.env.FAKE_REPOSITORY = repository;
    process.env.PARENT_PID_PATH = parentPidPath;
    process.env.CHILD_PID_PATH = childPidPath;
    try {
      const manager = makeGitWorktreeManager({ repository });
      const fiber = Effect.runFork(
        manager.create({
          conversationId: "conversation-1",
          executionId: "execution-1",
          worktreeName: "interrupt-me",
        })
      );
      await waitFor(async () => {
        try {
          await Promise.all([readFile(parentPidPath), readFile(childPidPath)]);
          return true;
        } catch {
          return false;
        }
      });
      const parentPid = Number(await readFile(parentPidPath, "utf8"));
      const childPid = Number(await readFile(childPidPath, "utf8"));

      await Effect.runPromise(Fiber.interrupt(fiber));
      await waitFor(
        async () => !(processExists(parentPid) || processExists(childPid))
      );
    } finally {
      process.env.PATH = previousPath;
      process.env.FAKE_REPOSITORY = undefined;
      process.env.PARENT_PID_PATH = undefined;
      process.env.CHILD_PID_PATH = undefined;
    }
  });

  it("fails closed instead of consuming stale Conversation recovery messages", async () => {
    let actionCalls = 0;
    const agent = makeOpenCodeConversationAgent({
      client: inertClient({
        readMessages: () =>
          Effect.succeed([
            {
              id: "stale-assistant-action",
              role: "assistant",
              text: JSON.stringify({
                action: "create-feature",
                input: { prompt: "stale" },
                type: "action",
              }),
            },
          ]),
      }),
      repositoryDirectory: "/repo",
    });

    expect(agent.recover).toBeDefined();
    if (agent.recover === undefined) {
      throw new Error("Conversation recovery is unavailable");
    }
    const failed = await effectFailed(
      agent.recover(
        conversationRequest({
          actions: [
            {
              description: "Create a feature",
              invoke: () =>
                Effect.sync(() => {
                  actionCalls += 1;
                  return { executionId: "execution-1", status: "running" };
                }),
              name: "create-feature",
            },
          ],
        })
      )
    );

    expect(failed).toBe(true);
    expect(actionCalls).toBe(0);
  });

  it("fails closed instead of accepting stale Implementation recovery output", async () => {
    let accepted = 0;
    const agent = makeOpenCodeImplementationAgent({
      client: inertClient({
        readMessages: () =>
          Effect.succeed([
            { id: "old-prompt", role: "user", text: "old" },
            { id: "stale-output", role: "assistant", text: "stale" },
          ]),
      }),
    });
    expect(agent.recover).toBeDefined();
    if (agent.recover === undefined) {
      throw new Error("Implementation recovery is unavailable");
    }
    const session = await Effect.runPromise(
      agent.recover(
        {
          actionName: "deal-with-bug",
          conversationId: "conversation-1",
          executionId: "execution-1",
          implementationSessionId: "implementation-session-1",
          prompt: "Fix it",
          promptId: "persisted-prompt-1",
          promptKind: "initial",
          workingDirectory: "/repo/worktree",
        },
        () =>
          Effect.sync(() => {
            accepted += 1;
          })
      )
    );

    expect(await effectFailed(session.completion)).toBe(true);
    expect(accepted).toBe(0);
  });

  it("creates a missing Conversation session only for an explicit first prompt", async () => {
    let createCalls = 0;
    const agent = makeOpenCodeConversationAgent({
      client: inertClient({
        createSession: () =>
          Effect.sync(() => {
            createCalls += 1;
          }),
        readMessages: () =>
          Effect.succeed([
            {
              id: "assistant-reply",
              role: "assistant",
              text: JSON.stringify({ text: "hello", type: "reply" }),
            },
          ]),
        sessionExists: () => Effect.succeed(false),
      }),
      repositoryDirectory: "/repo",
    });

    expect(await effectFailed(agent.handle(conversationRequest()))).toBe(true);
    expect(createCalls).toBe(0);

    await Effect.runPromise(
      agent.handle(conversationRequest({ conversationSessionIsNew: true }))
    );
    expect(createCalls).toBe(1);
  });

  it("awaits OpenCode exit and escalates an ignored TERM to KILL", async () => {
    const sandbox = await mkdtemp(
      join(await realpath(tmpdir()), "laborer-opencode-stop-")
    );
    sandboxes.add(sandbox);
    const pidPath = join(sandbox, "server.pid");
    await writeFile(
      join(sandbox, "opencode"),
      `#!/bin/sh
trap '' TERM
printf '%s' "$$" > "$PID_PATH"
printf 'opencode server listening on http://127.0.0.1:43210\n'
while :; do /bin/sleep 1; done
`,
      { mode: 0o700 }
    );
    const server = await launchOpenCodeServer({
      environment: { PATH: sandbox, PID_PATH: pidPath },
      hostname: "127.0.0.1",
      port: 0,
      timeoutMs: 2000,
    });
    const pid = Number(await readFile(pidPath, "utf8"));

    await server.close();

    expect(processExists(pid)).toBe(false);
  });
});
