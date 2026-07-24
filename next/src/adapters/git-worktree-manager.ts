import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Effect, Array as EffectArray } from "effect";
import { HandlerFailure } from "../prototype/errors.ts";
import {
  type WorktreeManagerShape,
  WorktreeProvisioningUncertain,
  type WorktreeRequest,
  type WorktreeValidationRequest,
} from "../reference-coding-application.ts";

const GIT_MAX_BUFFER_BYTES = 256 * 1024;
const GIT_TIMEOUT_MILLIS = 30_000;
const ENVIRONMENT_MAX_BYTES = 1024 * 1024;
const SAFE_WORKTREE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

interface RegisteredWorktree {
  readonly branch: string | null;
  readonly path: string;
}

interface RepositoryContext {
  readonly environmentRelativePath: string;
  readonly repository: string;
  readonly sourceDirectory: string;
  readonly sourceRelativePath: string;
  readonly worktreeRoot: string;
}

interface EnvironmentCopy {
  readonly bytes: Buffer;
  readonly relativePath: string;
}

export interface GitWorktreeManagerOptions {
  /** Any canonicalizable directory inside the source Git worktree. */
  readonly repository: string;
}

const worktreeFailure = (safeDetail: string): HandlerFailure =>
  HandlerFailure.make({ category: "protocol", safeDetail });

const isHandlerFailure = (error: unknown): error is HandlerFailure =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "HandlerFailure";

const isUncertainProvisioning = (
  error: unknown
): error is WorktreeProvisioningUncertain =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "WorktreeProvisioningUncertain";

const mapProvisioningFailure = (
  error: unknown,
  fallback: string
): HandlerFailure | WorktreeProvisioningUncertain => {
  if (isHandlerFailure(error) || isUncertainProvisioning(error)) {
    return error;
  }
  return worktreeFailure(fallback);
};

const mapHandlerFailure = (error: unknown, fallback: string): HandlerFailure =>
  isHandlerFailure(error) ? error : worktreeFailure(fallback);

const terminateProcessGroup = (child: ChildProcess): void => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child if its process group is unavailable.
    }
  }
  child.kill("SIGKILL");
};

const runGit = async (
  directory: string,
  args: readonly string[],
  signal: AbortSignal
): Promise<string> =>
  await new Promise<string>((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(new Error("Git command interrupted"));
      return;
    }
    const child = spawn("git", ["-C", directory, ...args], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let pendingError: Error | null = null;
    let settled = false;
    const requestTermination = (error: Error): void => {
      pendingError ??= error;
      terminateProcessGroup(child);
    };
    const acceptOutput = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > GIT_MAX_BUFFER_BYTES) {
        requestTermination(new Error("Git command output exceeded the limit"));
        return;
      }
      stdout.push(bytes);
    };
    const onAbort = (): void => {
      requestTermination(new Error("Git command interrupted"));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error: Error | null, output?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === null && output !== undefined) {
        resolvePromise(output);
      } else {
        rejectPromise(error ?? new Error("Git command failed"));
      }
    };
    const timeout = setTimeout(
      () => requestTermination(new Error("Git command timed out")),
      GIT_TIMEOUT_MILLIS
    );
    child.stdout?.on("data", acceptOutput);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > GIT_MAX_BUFFER_BYTES) {
        requestTermination(new Error("Git command output exceeded the limit"));
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (pendingError !== null) {
        finish(pendingError);
        return;
      }
      if (code !== 0) {
        finish(new Error("Git command failed"));
        return;
      }
      finish(null, Buffer.concat(stdout).toString("utf8"));
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const metadataIfPresent = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
};

const canonicalDirectory = async (path: string): Promise<string> => {
  const canonicalPath = await realpath(resolve(path));
  const metadata = await lstat(canonicalPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw worktreeFailure("Git repository path is unsafe");
  }
  return canonicalPath;
};

const isContained = (anchor: string, target: string): boolean => {
  const relativePath = relative(anchor, target);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
};

const parseWorktrees = (source: string): readonly RegisteredWorktree[] => {
  const records: RegisteredWorktree[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  for (const field of source.split("\0")) {
    if (field === "") {
      if (path !== null) {
        records.push({ branch, path });
      }
      path = null;
      branch = null;
    } else if (field.startsWith("worktree ")) {
      path = field.slice("worktree ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      branch = field.slice("branch refs/heads/".length);
    }
  }
  if (path !== null) {
    records.push({ branch, path });
  }
  return records;
};

const repositoryContext = async (
  configuredDirectory: string,
  signal: AbortSignal
): Promise<RepositoryContext> => {
  const sourceDirectory = await canonicalDirectory(configuredDirectory);
  const reportedRepository = (
    await runGit(sourceDirectory, ["rev-parse", "--show-toplevel"], signal)
  ).trim();
  const repository = await canonicalDirectory(reportedRepository);
  if (!isContained(repository, sourceDirectory)) {
    throw worktreeFailure("Git repository path is unsafe");
  }
  const sourceRelativePath = relative(repository, sourceDirectory);
  return {
    environmentRelativePath: join(sourceRelativePath, ".env.local"),
    repository,
    sourceRelativePath,
    sourceDirectory,
    worktreeRoot: join(
      dirname(repository),
      `${basename(repository)}.worktrees`
    ),
  };
};

const workingDirectoryInWorktree = async (
  context: RepositoryContext,
  worktreePath: string
): Promise<string> => {
  const expected = resolve(worktreePath, context.sourceRelativePath);
  if (!isContained(worktreePath, expected)) {
    throw worktreeFailure("Laborer working directory is unsafe");
  }
  const canonical = await canonicalDirectory(expected);
  if (canonical !== expected) {
    throw worktreeFailure("Laborer working directory identity conflicts");
  }
  return canonical;
};

const validateWorktreeName = (name: string): void => {
  if (
    !SAFE_WORKTREE_NAME.test(name) ||
    name.includes("..") ||
    name.toLowerCase().endsWith(".lock")
  ) {
    throw worktreeFailure("worktree name is invalid");
  }
};

const branchExists = async (
  repository: string,
  branch: string,
  signal: AbortSignal
): Promise<boolean> => {
  const refs = await runGit(
    repository,
    ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`],
    signal
  );
  return EffectArray.some(
    refs.split("\n"),
    (ref) => ref === `refs/heads/${branch}`
  );
};

const readRegisteredWorktrees = async (
  repository: string,
  signal: AbortSignal
): Promise<readonly RegisteredWorktree[]> =>
  parseWorktrees(
    await runGit(repository, ["worktree", "list", "--porcelain", "-z"], signal)
  );

const readEnvironmentCopy = async (
  context: RepositoryContext
): Promise<EnvironmentCopy | null> => {
  const sourcePath = join(context.repository, context.environmentRelativePath);
  const metadata = await metadataIfPresent(sourcePath);
  if (metadata === null) {
    return null;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > ENVIRONMENT_MAX_BYTES
  ) {
    throw worktreeFailure("source .env.local is unsafe");
  }
  const source = await open(sourcePath, constants.O_NOFOLLOW);
  try {
    const openedMetadata = await source.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino ||
      openedMetadata.size > ENVIRONMENT_MAX_BYTES
    ) {
      throw worktreeFailure("source .env.local is unsafe");
    }
    const bytes = await source.readFile();
    if (bytes.byteLength > ENVIRONMENT_MAX_BYTES) {
      throw worktreeFailure("source .env.local is unsafe");
    }
    return {
      bytes,
      relativePath: context.environmentRelativePath,
    };
  } finally {
    await source.close();
  }
};

const ensureTargetDirectory = async (
  worktreePath: string,
  relativeDirectory: string
): Promise<string> => {
  let current = await canonicalDirectory(worktreePath);
  const target = resolve(current, relativeDirectory);
  if (!isContained(current, target)) {
    throw worktreeFailure("target .env.local path is unsafe");
  }
  const segments = EffectArray.filter(
    relative(current, target).split(sep),
    (segment) => segment.length > 0
  );
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )
      ) {
        throw error;
      }
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw worktreeFailure("target .env.local path is unsafe");
    }
    if ((await realpath(current)) !== current) {
      throw worktreeFailure("target .env.local path is unsafe");
    }
  }
  return current;
};

const environmentTargetIsValid = async (
  targetPath: string,
  environment: EnvironmentCopy
): Promise<boolean> => {
  const metadata = await metadataIfPresent(targetPath);
  if (
    metadata === null ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > ENVIRONMENT_MAX_BYTES ||
    metadata.mode % 0o1000 !== 0o600
  ) {
    return false;
  }
  const target = await open(
    targetPath,
    constants.O_RDONLY + constants.O_NOFOLLOW
  ).catch(() => null);
  if (target === null) {
    return false;
  }
  try {
    const openedMetadata = await target.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino ||
      openedMetadata.size > ENVIRONMENT_MAX_BYTES
    ) {
      return false;
    }
    return (await target.readFile()).equals(environment.bytes);
  } finally {
    await target.close();
  }
};

const assertEnvironmentCopy = async (
  worktreePath: string,
  environment: EnvironmentCopy | null
): Promise<void> => {
  if (
    environment !== null &&
    !(await environmentTargetIsValid(
      join(worktreePath, environment.relativePath),
      environment
    ))
  ) {
    throw worktreeFailure("required .env.local copy is unavailable");
  }
};

const copyEnvironment = async (
  worktreePath: string,
  environment: EnvironmentCopy | null,
  repair: boolean
): Promise<void> => {
  if (environment === null) {
    return;
  }
  const targetPath = join(worktreePath, environment.relativePath);
  const targetDirectory = await ensureTargetDirectory(
    worktreePath,
    dirname(environment.relativePath)
  );
  if (dirname(targetPath) !== targetDirectory) {
    throw worktreeFailure("target .env.local path is unsafe");
  }
  if (await environmentTargetIsValid(targetPath, environment)) {
    return;
  }
  const existing = await metadataIfPresent(targetPath);
  if (existing !== null && !repair) {
    throw worktreeFailure("target .env.local already exists");
  }
  if (existing?.isDirectory()) {
    throw worktreeFailure("target .env.local path is unsafe");
  }
  const temporaryPath = join(
    targetDirectory,
    `.env.local.laborer-${randomUUID()}.tmp`
  );
  const flags =
    constants.O_WRONLY +
    constants.O_CREAT +
    constants.O_EXCL +
    constants.O_NOFOLLOW;
  const temporary = await open(temporaryPath, flags, 0o600);
  try {
    await temporary.writeFile(environment.bytes);
    await temporary.chmod(0o600);
    await temporary.sync();
  } finally {
    await temporary.close();
  }
  try {
    if (existing === null) {
      await link(temporaryPath, targetPath);
    } else {
      await rename(temporaryPath, targetPath);
    }
    if (existing === null) {
      await unlink(temporaryPath);
    }
    const directory = await open(targetDirectory, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if ((await metadataIfPresent(temporaryPath)) !== null) {
      await unlink(temporaryPath);
    }
  }
  if (!(await environmentTargetIsValid(targetPath, environment))) {
    throw worktreeFailure("required .env.local copy is unavailable");
  }
};

const assertExactCheckout = async (
  context: RepositoryContext,
  worktreePath: string,
  branch: string,
  signal: AbortSignal
): Promise<string> => {
  const canonicalPath = await canonicalDirectory(worktreePath);
  if (canonicalPath !== worktreePath) {
    throw worktreeFailure("created worktree path is unsafe");
  }
  const [reportedTopLevel, reportedBranch, sourceCommon, targetCommon] =
    await Promise.all([
      runGit(canonicalPath, ["rev-parse", "--show-toplevel"], signal),
      runGit(canonicalPath, ["branch", "--show-current"], signal),
      runGit(
        context.repository,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        signal
      ),
      runGit(
        canonicalPath,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        signal
      ),
    ]);
  if (
    (await canonicalDirectory(reportedTopLevel.trim())) !== canonicalPath ||
    reportedBranch.trim() !== branch ||
    (await realpath(sourceCommon.trim())) !==
      (await realpath(targetCommon.trim()))
  ) {
    throw worktreeFailure("created worktree identity conflicts");
  }
  return canonicalPath;
};

const assertSafeWorktreeRoot = async (
  worktreeRoot: string,
  createIfMissing: boolean
): Promise<void> => {
  let metadata = await metadataIfPresent(worktreeRoot);
  if (metadata === null && createIfMissing) {
    try {
      await mkdir(worktreeRoot, { mode: 0o700 });
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )
      ) {
        throw error;
      }
    }
    metadata = await lstat(worktreeRoot);
  }
  const userId = typeof process.getuid === "function" ? process.getuid() : null;
  const groupWritable =
    metadata !== null && Math.floor(metadata.mode / 0o20) % 2 === 1;
  const worldWritable =
    metadata !== null && Math.floor(metadata.mode / 0o2) % 2 === 1;
  if (
    metadata === null ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (userId !== null && metadata.uid !== userId) ||
    groupWritable ||
    worldWritable ||
    (await realpath(worktreeRoot)) !== worktreeRoot
  ) {
    throw worktreeFailure("worktree root is unsafe");
  }
};

const createWorktree = async (
  options: GitWorktreeManagerOptions,
  request: WorktreeRequest,
  signal: AbortSignal
): Promise<{ readonly workingDirectory: string }> => {
  validateWorktreeName(request.worktreeName);
  const context = await repositoryContext(options.repository, signal);
  const environment = await readEnvironmentCopy(context);
  const worktreePath = join(context.worktreeRoot, request.worktreeName);
  const branch = `laborer/${request.worktreeName}`;
  const [pathMetadata, branchIsPresent, registered] = await Promise.all([
    metadataIfPresent(worktreePath),
    branchExists(context.repository, branch, signal),
    readRegisteredWorktrees(context.repository, signal),
  ]);
  const hasRegisteredCollision = EffectArray.some(
    registered,
    (candidate) =>
      resolve(candidate.path) === worktreePath || candidate.branch === branch
  );
  if (pathMetadata !== null || branchIsPresent || hasRegisteredCollision) {
    throw worktreeFailure("worktree name already exists");
  }
  await assertSafeWorktreeRoot(context.worktreeRoot, true);
  try {
    await runGit(
      context.repository,
      ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
      signal
    );
    const checkoutDirectory = await assertExactCheckout(
      context,
      worktreePath,
      branch,
      signal
    );
    await copyEnvironment(checkoutDirectory, environment, false);
    return {
      workingDirectory: await workingDirectoryInWorktree(context, worktreePath),
    };
  } catch {
    throw WorktreeProvisioningUncertain.make({
      failure: worktreeFailure(
        "Git worktree provisioning outcome is uncertain"
      ),
    });
  }
};

const recoverWorktree = async (
  options: GitWorktreeManagerOptions,
  request: WorktreeRequest,
  signal: AbortSignal
): Promise<{ readonly workingDirectory: string }> => {
  validateWorktreeName(request.worktreeName);
  const context = await repositoryContext(options.repository, signal);
  const worktreePath = join(context.worktreeRoot, request.worktreeName);
  const branch = `laborer/${request.worktreeName}`;
  const registered = await readRegisteredWorktrees(context.repository, signal);
  const exact = EffectArray.filter(
    registered,
    (candidate) =>
      resolve(candidate.path) === worktreePath && candidate.branch === branch
  );
  const pathMatches = EffectArray.filter(
    registered,
    (candidate) => resolve(candidate.path) === worktreePath
  );
  const branchMatches = EffectArray.filter(
    registered,
    (candidate) => candidate.branch === branch
  );
  if (
    exact.length === 1 &&
    pathMatches.length === 1 &&
    branchMatches.length === 1
  ) {
    await assertSafeWorktreeRoot(context.worktreeRoot, false);
    if (!(await branchExists(context.repository, branch, signal))) {
      throw worktreeFailure("worktree recovery state conflicts");
    }
    const checkoutDirectory = await assertExactCheckout(
      context,
      worktreePath,
      branch,
      signal
    );
    await copyEnvironment(
      checkoutDirectory,
      await readEnvironmentCopy(context),
      true
    );
    return {
      workingDirectory: await workingDirectoryInWorktree(context, worktreePath),
    };
  }
  const [pathMetadata, branchIsPresent] = await Promise.all([
    metadataIfPresent(worktreePath),
    branchExists(context.repository, branch, signal),
  ]);
  if (
    exact.length === 0 &&
    pathMatches.length === 0 &&
    branchMatches.length === 0 &&
    pathMetadata === null &&
    !branchIsPresent
  ) {
    return await createWorktree(options, request, signal);
  }
  throw worktreeFailure("worktree recovery state conflicts");
};

const validateWorktree = async (
  options: GitWorktreeManagerOptions,
  request: WorktreeValidationRequest,
  signal: AbortSignal
): Promise<void> => {
  validateWorktreeName(request.worktreeName);
  const context = await repositoryContext(options.repository, signal);
  const worktreePath = join(context.worktreeRoot, request.worktreeName);
  const expectedWorkingDirectory = resolve(
    worktreePath,
    context.sourceRelativePath
  );
  const branch = `laborer/${request.worktreeName}`;
  if (
    !isAbsolute(request.workingDirectory) ||
    request.workingDirectory !== expectedWorkingDirectory
  ) {
    throw worktreeFailure("persisted worktree path conflicts");
  }
  const registered = await readRegisteredWorktrees(context.repository, signal);
  const pathMatches = EffectArray.filter(
    registered,
    (candidate) => resolve(candidate.path) === worktreePath
  );
  const branchMatches = EffectArray.filter(
    registered,
    (candidate) => candidate.branch === branch
  );
  if (
    pathMatches.length !== 1 ||
    branchMatches.length !== 1 ||
    pathMatches[0] !== branchMatches[0]
  ) {
    throw worktreeFailure("persisted worktree registration conflicts");
  }
  await assertSafeWorktreeRoot(context.worktreeRoot, false);
  if (!(await branchExists(context.repository, branch, signal))) {
    throw worktreeFailure("persisted worktree registration conflicts");
  }
  const checkoutDirectory = await assertExactCheckout(
    context,
    worktreePath,
    branch,
    signal
  );
  await assertEnvironmentCopy(
    checkoutDirectory,
    await readEnvironmentCopy(context)
  );
  if (
    (await workingDirectoryInWorktree(context, worktreePath)) !==
    request.workingDirectory
  ) {
    throw worktreeFailure("persisted worktree path conflicts");
  }
};

export const makeGitWorktreeManager = (
  options: GitWorktreeManagerOptions
): WorktreeManagerShape => ({
  create: (request) =>
    Effect.tryPromise({
      catch: (error) =>
        mapProvisioningFailure(error, "Git worktree creation failed"),
      try: (signal) => createWorktree(options, request, signal),
    }),
  recover: (request) =>
    Effect.tryPromise({
      catch: (error) =>
        mapProvisioningFailure(error, "Git worktree recovery failed"),
      try: (signal) => recoverWorktree(options, request, signal),
    }),
  validate: (request) =>
    Effect.tryPromise({
      catch: (error) =>
        mapHandlerFailure(error, "Git worktree validation failed"),
      try: (signal) => validateWorktree(options, request, signal),
    }),
});
