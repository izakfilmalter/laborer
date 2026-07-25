import { resolve } from "node:path";
import { Effect } from "effect";
import {
  canonicalDirectory,
  ensureOwnerOnlyDirectoryTree,
} from "../prototype/path-safety.ts";
import { SlackStartupError } from "./errors.ts";

export interface SlackRuntimePaths {
  readonly acpRunnerState: string;
  readonly applicationState: string;
  readonly legacyHandlerState: string;
  readonly lock: string;
  readonly root: string;
  readonly runnerState: string;
  readonly workThreads: string;
}

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
      acpRunnerState: resolve(workspaceRoot, "acp-runner-state.json"),
      applicationState: resolve(workspaceRoot, "application-state.json"),
      legacyHandlerState: resolve(workspaceRoot, "state.json"),
      lock: resolve(root, "runner.lock"),
      root,
      runnerState,
      workThreads,
    };
  });
