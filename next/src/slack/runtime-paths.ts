import { resolve } from "node:path";
import { Effect } from "effect";
import {
  canonicalDirectory,
  ensureOwnerOnlyDirectoryTree,
} from "../prototype/path-safety.ts";
import { SlackStartupError } from "./errors.ts";

export interface SlackRuntimePaths {
  readonly lock: string;
  readonly root: string;
  readonly snapshot: string;
  readonly workThreads: string;
}

export const prepareSlackRuntimePaths = (
  projectRoot: string
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
    const workThreads = resolve(root, "work-threads");
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
          target: workThreads,
        });
      },
      catch: () =>
        SlackStartupError.make({
          operation: "prepare-runtime-directory",
          reason: "directory-unsafe-or-unavailable",
        }),
    });
    return {
      lock: resolve(root, "runner.lock"),
      root,
      snapshot: resolve(root, "state.json"),
      workThreads,
    };
  });
