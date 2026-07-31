import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { OPEN_CODE_COMMAND } from "../src/acp-conversation-prototype/open-code-acp-process.ts";
import { preflightEffectiveOpenCodeMcpNames } from "../src/acp-conversation-prototype/opencode-config-preflight.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const fakeOpenCodePath = resolve(
  process.cwd(),
  "tests/fixtures/fake-opencode-acp.sh"
);

const prepareIsolatedOpenCodeEnvironment = Effect.fnUntraced(function* (
  root: string,
  additions: NodeJS.ProcessEnv = {}
) {
  const home = join(root, "home");
  const xdgCache = join(root, "xdg-cache");
  const xdgConfig = join(root, "xdg-config");
  const xdgData = join(root, "xdg-data");
  const xdgState = join(root, "xdg-state");
  yield* Effect.promise(() =>
    Promise.all(
      [home, xdgCache, xdgConfig, xdgData, xdgState].map((path) =>
        mkdir(path, { mode: 0o700, recursive: true })
      )
    )
  );
  return {
    HOME: home,
    PATH: process.env.PATH,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    ...additions,
  };
});

describe("authoritative OpenCode effective-config preflight", () => {
  it.live(
    "accepts clean config and rejects a local collision with pinned OpenCode",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const collision of [false, true]) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-opencode-config-${collision ? "collision" : "clean"}-`
            );
            const reservedName = "laborer-actions-pinned-collision";
            yield* Effect.promise(() =>
              writeFile(
                join(root, "opencode.json"),
                JSON.stringify(
                  collision
                    ? {
                        mcp: {
                          [reservedName]: {
                            command: ["/usr/bin/true"],
                            disabled: true,
                            type: "local",
                          },
                        },
                      }
                    : { permissions: [] }
                ),
                { mode: 0o600 }
              )
            );
            const environment = yield* prepareIsolatedOpenCodeEnvironment(root);
            const result = yield* Effect.exit(
              preflightEffectiveOpenCodeMcpNames({
                command: OPEN_CODE_COMMAND,
                cwd: root,
                environment,
                reservedNames: [reservedName],
              })
            );
            assert.strictEqual(result._tag, collision ? "Failure" : "Success");
          }
        })
      )
  );

  it.effect(
    "rejects collisions merged from remote, account, and OS-managed seams",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const source of [
            {
              environmentName: "FAKE_OPENCODE_WELL_KNOWN_CONFIG_JSON",
              name: "remote-well-known",
            },
            {
              environmentName: "FAKE_OPENCODE_ACCOUNT_CONFIG_JSON",
              name: "active-account",
            },
            {
              environmentName: "FAKE_OPENCODE_OS_MANAGED_CONFIG_JSON",
              name: "os-managed",
            },
          ] as const) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-opencode-config-${source.name}-`
            );
            const reservedName = `laborer-memory-${source.name}`;
            const environment = yield* prepareIsolatedOpenCodeEnvironment(
              root,
              {
                FAKE_ACP_RUNTIME: process.execPath,
                [source.environmentName]: JSON.stringify({
                  mcp: { [reservedName]: { enabled: true } },
                }),
              }
            );
            const result = yield* Effect.exit(
              preflightEffectiveOpenCodeMcpNames({
                command: fakeOpenCodePath,
                cwd: root,
                environment,
                reservedNames: [reservedName],
              })
            );
            assert.strictEqual(result._tag, "Failure", source.name);
          }
        })
      )
  );

  it.live(
    "fails closed on timeout, nonzero, malformed, and oversized probes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const secret = "probe-secret-must-not-escape-246";
          for (const mode of [
            "timeout",
            "nonzero",
            "malformed",
            "oversize",
          ] as const) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-opencode-config-${mode}-`
            );
            const environment = yield* prepareIsolatedOpenCodeEnvironment(
              root,
              {
                FAKE_ACP_RUNTIME: process.execPath,
                FAKE_OPENCODE_CONFIG_PROBE_BYTES: "1024",
                FAKE_OPENCODE_CONFIG_PROBE_MODE: mode,
                FAKE_OPENCODE_CONFIG_PROBE_SECRET: secret,
              }
            );
            const result = yield* Effect.exit(
              preflightEffectiveOpenCodeMcpNames({
                command: fakeOpenCodePath,
                cwd: root,
                environment,
                limits: {
                  maxStderrBytes: 128,
                  maxStdoutBytes: 128,
                  runtimeTimeoutMillis: 50,
                  startupTimeoutMillis: 1000,
                },
                reservedNames: ["laborer-actions-probe-failure"],
              })
            );
            assert.strictEqual(result._tag, "Failure", mode);
            assert.ok(!JSON.stringify(result).includes(secret));
          }
        })
      )
  );

  it.effect("never exposes secret-bearing resolved config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-opencode-config-secret-"
        );
        const secret = "resolved-config-private-credential-246";
        const reservedName = "laborer-actions-secret-collision";
        const cleanEnvironment = yield* prepareIsolatedOpenCodeEnvironment(
          root,
          {
            FAKE_ACP_RUNTIME: process.execPath,
            SCRIPTED_ACP_EFFECTIVE_CONFIG_JSON: JSON.stringify({
              description: reservedName,
              mcp: {
                allowed: {
                  environment: {
                    PRIVATE_TOKEN: secret,
                    RESERVED_NAME_AS_VALUE: reservedName,
                  },
                  type: "remote",
                  url: "https://example.invalid/mcp",
                },
              },
              provider: { private: { apiKey: secret } },
            }),
          }
        );
        yield* preflightEffectiveOpenCodeMcpNames({
          command: fakeOpenCodePath,
          cwd: root,
          environment: cleanEnvironment,
          reservedNames: [reservedName],
        });
        const collisionEnvironment = yield* prepareIsolatedOpenCodeEnvironment(
          root,
          {
            FAKE_ACP_RUNTIME: process.execPath,
            SCRIPTED_ACP_EFFECTIVE_CONFIG_JSON: JSON.stringify({
              mcp: {
                [reservedName]: {
                  environment: { PRIVATE_TOKEN: secret },
                  type: "remote",
                  url: "https://example.invalid/mcp",
                },
              },
              provider: { private: { apiKey: secret } },
            }),
          }
        );
        const result = yield* Effect.exit(
          preflightEffectiveOpenCodeMcpNames({
            command: fakeOpenCodePath,
            cwd: root,
            environment: collisionEnvironment,
            reservedNames: [reservedName],
          })
        );
        assert.strictEqual(result._tag, "Failure");
        const publicSnapshot = JSON.stringify(result);
        assert.ok(!publicSnapshot.includes(secret));
        assert.ok(!publicSnapshot.includes(root));
      })
    )
  );
});
