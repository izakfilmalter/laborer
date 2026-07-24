import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeOpenCodeWorkspaceSessionClient } from "../src/adapters/opencode-agents.ts";

const sandboxes = new Set<string>();

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  throw new Error("Timed out waiting for the fake OpenCode server");
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

describe("OpenCode server lifecycle", () => {
  it("continuously drains both output streams after startup and completes bounded shutdown", async () => {
    const sandbox = await mkdtemp(
      join(await realpath(tmpdir()), "laborer-high-opencode-output-")
    );
    sandboxes.add(sandbox);
    const outputDrainedPath = join(sandbox, "output-drained");
    const pidPath = join(sandbox, "server.pid");
    await writeFile(
      join(sandbox, "opencode"),
      `#!/bin/sh
trap '' TERM
printf '%s' "$$" > "$PID_PATH"
printf 'opencode server listening on http://127.0.0.1:43210\n'
/usr/bin/yes stdout | /usr/bin/head -c 1048576
/usr/bin/yes stderr | /usr/bin/head -c 1048576 >&2
printf 'drained' > "$OUTPUT_DRAINED_PATH"
while :; do /bin/sleep 1; done
`,
      { mode: 0o700 }
    );
    const lifecycleStartedAt = Date.now();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeOpenCodeWorkspaceSessionClient({
            environment: {
              OUTPUT_DRAINED_PATH: outputDrainedPath,
              PATH: sandbox,
              PID_PATH: pidPath,
            },
            hostname: "127.0.0.1",
            port: 0,
            serverTimeoutMs: 2000,
            workspaceDirectory: sandbox,
          });
          yield* Effect.promise(() => waitForFile(outputDrainedPath));
        })
      )
    );
    const pid = Number(await readFile(pidPath, "utf8"));

    expect(await readFile(outputDrainedPath, "utf8")).toBe("drained");
    expect(processExists(pid)).toBe(false);
    expect(Date.now() - lifecycleStartedAt).toBeLessThan(4000);
  });
});
