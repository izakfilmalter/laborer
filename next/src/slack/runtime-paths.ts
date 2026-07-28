import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import {
  canonicalDirectory,
  ensureOwnerOnlyDirectoryTree,
} from "../prototype/path-safety.ts";
import { SlackStartupError } from "./errors.ts";

export interface SlackRuntimePaths {
  readonly acpActionAuthorityState: string;
  readonly acpActionBootstrap: string;
  readonly acpAuthorityKey: string;
  readonly acpAuthorityState: string;
  readonly acpPermissionUiOutbox: string;
  readonly acpProcessState: string;
  readonly applicationState: string;
  readonly legacyHandlerState: string;
  readonly lock: string;
  readonly recoverySocket: string;
  readonly root: string;
  readonly runnerState: string;
  readonly runtimeDatabase: string;
  readonly workThreads: string;
}

const recoverySocketPath = (workspaceRoot: string): string => {
  const preferred = resolve(workspaceRoot, "recovery.sock");
  if (Buffer.byteLength(preferred, "utf8") <= 96) {
    return preferred;
  }
  const digest = createHash("sha256")
    .update(workspaceRoot, "utf8")
    .digest("hex")
    .slice(0, 32);
  return resolve(tmpdir(), `laborer-recovery-${digest}.sock`);
};

export const prepareSlackRuntimePaths = (
  projectRoot: string,
  workspaceId?: string
): Effect.Effect<SlackRuntimePaths, SlackStartupError> =>
  Effect.gen(function* () {
    const canonicalProjectRoot = yield* Effect.tryPromise({
      try: () => canonicalDirectory(projectRoot, "prepare-runtime-directory"),
      catch: () =>
        SlackStartupError.make({
          operation: "prepare-runtime-directory",
          reason: "project-root-unsafe",
        }),
    });
    const root = resolve(canonicalProjectRoot, ".laborer-runtime");
    const workspaceRoot =
      workspaceId === undefined
        ? root
        : resolve(root, "slack-workspaces", encodeURIComponent(workspaceId));
    const workThreads = resolve(workspaceRoot, "work-threads");
    yield* Effect.tryPromise({
      try: async () => {
        await ensureOwnerOnlyDirectoryTree({
          anchor: canonicalProjectRoot,
          operation: "prepare-runtime-directory",
          target: root,
        });
        await ensureOwnerOnlyDirectoryTree({
          anchor: root,
          operation: "prepare-runtime-directory",
          target: workspaceRoot,
        });
        await ensureOwnerOnlyDirectoryTree({
          anchor: workspaceRoot,
          operation: "prepare-runtime-directory",
          target: workThreads,
        });
      },
      catch: () =>
        SlackStartupError.make({
          operation: "prepare-runtime-directory",
          reason: "directory-unsafe-or-unavailable",
        }),
    });
    const runnerState = resolve(workspaceRoot, "runner-state.json");
    return {
      acpActionAuthorityState: resolve(
        workspaceRoot,
        "acp-action-capabilities.json"
      ),
      acpActionBootstrap: resolve(workspaceRoot, "acp-action-bootstrap"),
      acpAuthorityKey: resolve(workspaceRoot, "acp-authority.key"),
      acpAuthorityState: resolve(workspaceRoot, "acp-authority.json"),
      acpPermissionUiOutbox: resolve(
        workspaceRoot,
        "acp-permission-ui-outbox.json"
      ),
      acpProcessState: resolve(workspaceRoot, "acp-process-state.json"),
      applicationState: resolve(workspaceRoot, "application-state.json"),
      legacyHandlerState: resolve(workspaceRoot, "state.json"),
      lock: resolve(root, "runner.lock"),
      root,
      recoverySocket: recoverySocketPath(workspaceRoot),
      runnerState,
      runtimeDatabase: resolve(root, "runtime.sqlite"),
      workThreads,
    };
  });
