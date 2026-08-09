import { lstat, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
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
  readonly acpProcessState: string;
  readonly applicationState: string;
  readonly attachments: string;
  readonly root: string;
  readonly runtimeDatabase: string;
}

const RETIRED_RUNTIME_ENTRY_LIMIT = 100_000;

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const popPendingDirectory = (pending: string[]): string => {
  const directory = pending.pop();
  if (directory === undefined) {
    throw new Error("retired runtime inventory underflow");
  }
  return directory;
};

const removeRetiredRuntimeDirectory = async (
  projectRoot: string
): Promise<void> => {
  const retiredRoot = resolve(projectRoot, ".laborer-runtime");
  let rootMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    rootMetadata = await lstat(retiredRoot);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("retired runtime root is unsafe");
  }
  const pending = [retiredRoot];
  let entries = 0;
  while (pending.length > 0) {
    const directory = popPendingDirectory(pending);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > RETIRED_RUNTIME_ENTRY_LIMIT || entry.isSymbolicLink()) {
        throw new Error("retired runtime tree is unsafe or oversized");
      }
      if (entry.isDirectory()) {
        pending.push(resolve(directory, entry.name));
      } else if (!(entry.isFile() || entry.isSocket())) {
        throw new Error("retired runtime tree has an unsupported entry");
      }
    }
  }
  await rm(retiredRoot, { recursive: true });
};

/** One-way cutover: remove the obsolete root-local Runner state in place. */
export const deleteRetiredSlackRuntimeState = (
  projectRoot: string
): Effect.Effect<void, SlackStartupError> =>
  Effect.tryPromise({
    try: () => removeRetiredRuntimeDirectory(projectRoot),
    catch: () =>
      SlackStartupError.make({
        operation: "delete-retired-runtime-state",
        reason: "retired-state-unsafe-or-unavailable",
      }),
  });

export const prepareSlackRuntimePaths = (
  workspaceId: string,
  environment: NodeJS.ProcessEnv = process.env
): Effect.Effect<SlackRuntimePaths, SlackStartupError> =>
  Effect.gen(function* () {
    const configured = environment.XDG_STATE_HOME?.trim();
    const stateHome =
      configured !== undefined && isAbsolute(configured)
        ? configured
        : resolve(homedir(), ".local", "state");
    const globalRoot = resolve(stateHome, "laborer");
    const root = resolve(
      globalRoot,
      "workspaces",
      encodeURIComponent(workspaceId)
    );
    const canonicalStateHome = yield* Effect.tryPromise({
      try: async () => {
        await ensureOwnerOnlyDirectoryTree({
          anchor: dirname(stateHome),
          operation: "prepare-runtime-directory",
          target: stateHome,
        });
        return canonicalDirectory(stateHome, "prepare-runtime-directory");
      },
      catch: () =>
        SlackStartupError.make({
          operation: "prepare-runtime-directory",
          reason: "directory-unsafe-or-unavailable",
        }),
    });
    yield* Effect.tryPromise({
      try: async () => {
        await ensureOwnerOnlyDirectoryTree({
          anchor: canonicalStateHome,
          operation: "prepare-runtime-directory",
          target: resolve(root, "attachments"),
        });
      },
      catch: () =>
        SlackStartupError.make({
          operation: "prepare-runtime-directory",
          reason: "directory-unsafe-or-unavailable",
        }),
    });
    return {
      acpActionAuthorityState: resolve(root, "acp-action-capabilities.json"),
      acpActionBootstrap: resolve(root, "acp-action-bootstrap"),
      acpAuthorityKey: resolve(root, "acp-authority.key"),
      acpAuthorityState: resolve(root, "acp-authority.json"),
      acpProcessState: resolve(root, "acp-process-state.json"),
      applicationState: resolve(root, "application-state.json"),
      attachments: resolve(root, "attachments"),
      root,
      runtimeDatabase: resolve(root, "runtime.sqlite"),
    };
  });
