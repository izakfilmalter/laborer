/**
 * THROWAWAY PROTOTYPE: configured per-thread workspace initializer.
 *
 * Creates one deterministic sibling Git worktree and copies next/.env.local.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rmdir,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { assertNoSymlinkPathComponents } from "../prototype/path-safety.ts";

interface InitializerEnvelope {
  readonly protocolVersion: 1;
  readonly turnId: string;
  readonly workThreadId: string;
}

interface RegisteredWorktree {
  readonly branch: string | null;
  readonly path: string;
}

const execFilePromise = promisify(execFile);
const WORKTREE_HASH_LENGTH = 16;

const git = async (
  repository: string,
  args: readonly string[]
): Promise<string> => {
  const result = await execFilePromise("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
};

const parseWorktrees = (source: string): readonly RegisteredWorktree[] => {
  const records: RegisteredWorktree[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  for (const line of source.split("\n")) {
    if (line.length === 0) {
      if (path !== null) {
        records.push({ branch, path });
      }
      path = null;
      branch = null;
    } else if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    }
  }
  if (path !== null) {
    records.push({ branch, path });
  }
  return records;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const localBranchExists = async (
  repository: string,
  branch: string
): Promise<boolean> => {
  try {
    await git(repository, ["show-ref", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
};

const ensureWorktree = async (options: {
  readonly branch: string;
  readonly path: string;
  readonly repository: string;
}): Promise<string> => {
  const expectedPath = resolve(options.path);
  const worktrees = parseWorktrees(
    await git(options.repository, ["worktree", "list", "--porcelain"])
  );
  const branchWorktree = worktrees.find(
    (candidate) => candidate.branch === options.branch
  );
  if (branchWorktree !== undefined) {
    const registeredPath = await realpath(branchWorktree.path);
    if (registeredPath !== expectedPath) {
      throw new Error("thread branch is attached to another worktree");
    }
    return registeredPath;
  }
  if (await pathExists(expectedPath)) {
    try {
      const [candidateBranch, candidateCommonDirectory, sourceCommonDirectory] =
        await Promise.all([
          git(expectedPath, ["branch", "--show-current"]),
          git(expectedPath, ["rev-parse", "--git-common-dir"]),
          git(options.repository, ["rev-parse", "--git-common-dir"]),
        ]);
      const candidateCommonPath = await realpath(
        resolve(expectedPath, candidateCommonDirectory)
      );
      const sourceCommonPath = await realpath(
        resolve(options.repository, sourceCommonDirectory)
      );
      if (
        candidateBranch === options.branch &&
        candidateCommonPath === sourceCommonPath
      ) {
        return await realpath(expectedPath);
      }
    } catch {
      // An interrupted `git worktree add` can leave its empty destination.
    }
    if ((await readdir(expectedPath)).length === 0) {
      await rmdir(expectedPath);
    } else {
      throw new Error("thread worktree path exists but is not registered");
    }
  }
  await mkdir(dirname(expectedPath), { recursive: true, mode: 0o700 });
  if (await localBranchExists(options.repository, options.branch)) {
    await git(options.repository, [
      "worktree",
      "add",
      expectedPath,
      options.branch,
    ]);
  } else {
    await git(options.repository, [
      "worktree",
      "add",
      "-b",
      options.branch,
      expectedPath,
      "HEAD",
    ]);
  }
  return await realpath(expectedPath);
};

const readEnvelope = async (): Promise<InitializerEnvelope> => {
  const input = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of input) {
    const value = JSON.parse(line) as Partial<InitializerEnvelope>;
    if (
      value.protocolVersion !== 1 ||
      typeof value.turnId !== "string" ||
      typeof value.workThreadId !== "string"
    ) {
      throw new Error("invalid initializer envelope");
    }
    return value as InitializerEnvelope;
  }
  throw new Error("initializer envelope missing");
};

const envelope = await readEnvelope();
const repository = await git(process.cwd(), ["rev-parse", "--show-toplevel"]);
const repositoryName = repository.slice(repository.lastIndexOf("/") + 1);
const worktreeRoot = join(dirname(repository), `${repositoryName}.worktrees`);
const identity = createHash("sha256")
  .update(envelope.workThreadId)
  .digest("hex")
  .slice(0, WORKTREE_HASH_LENGTH);
const worktreeName = `thread-${identity}`;
const branch = `laborer/${worktreeName}`;
const workingDirectory = await ensureWorktree({
  branch,
  path: join(worktreeRoot, worktreeName),
  repository,
});
const sourceEnvironment = join(repository, "next", ".env.local");
const targetEnvironment = join(workingDirectory, "next", ".env.local");
await mkdir(dirname(targetEnvironment), { recursive: true, mode: 0o700 });
await assertNoSymlinkPathComponents(
  sourceEnvironment,
  "copy-thread-environment-source"
);
await assertNoSymlinkPathComponents(
  dirname(targetEnvironment),
  "copy-thread-environment-target"
);
const sourceMetadata = await lstat(sourceEnvironment);
if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
  throw new Error("thread environment source is not a regular file");
}
if (await pathExists(targetEnvironment)) {
  const targetMetadata = await lstat(targetEnvironment);
  if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()) {
    throw new Error("thread environment target is not a regular file");
  }
}
await copyFile(sourceEnvironment, targetEnvironment);
await chmod(targetEnvironment, 0o600);

process.stdout.write(
  `${JSON.stringify({
    protocolVersion: 1,
    replyId: `initializer:${envelope.turnId}:worktree`,
    text: `Workspace ready on branch \`${branch}\`.`,
    type: "public_reply",
  })}\n`
);
process.stdout.write(
  `${JSON.stringify({
    protocolVersion: 1,
    type: "initialized",
    workingDirectory,
  })}\n`
);
