import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Schema } from "effect";

const SAFE_DIRECTORY_OPEN_FLAGS =
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bit masks.
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bit masks.
const SAFE_FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

export class UnsafePathError extends Schema.TaggedErrorClass<UnsafePathError>()(
  "UnsafePathError",
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}

const pathFailure = (operation: string, reason: string): UnsafePathError =>
  UnsafePathError.make({ operation, reason });

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const closeHandle = async (handle: FileHandle): Promise<void> => {
  await handle.close();
};

const currentUserId = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

const assertTrustedDirectoryMetadata = (
  metadata: Awaited<ReturnType<FileHandle["stat"]>>,
  operation: string
): void => {
  const userId = currentUserId();
  if (
    !metadata.isDirectory() ||
    (userId !== null && metadata.uid !== userId && metadata.uid !== 0) ||
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode masks are bit fields.
    (Number(metadata.mode) & 0o022) !== 0
  ) {
    throw pathFailure(operation, "untrusted-directory-owner-or-mode");
  }
};

export interface RetainedDirectory {
  readonly handle: FileHandle;
  readonly path: string;
}

/**
 * Retains and fingerprints a non-writable, same-UID directory. Node does not
 * expose openat/renameat/execveat, so same-UID processes remain inside the
 * trust boundary; this guard removes races available to other local users.
 */
export const retainTrustedDirectory = async (
  path: string,
  operation: string
): Promise<RetainedDirectory> => {
  const canonicalPath = await canonicalDirectory(path, operation);
  const handle = await open(canonicalPath, SAFE_DIRECTORY_OPEN_FLAGS);
  try {
    assertTrustedDirectoryMetadata(await handle.stat(), operation);
    return { handle, path: canonicalPath };
  } catch (error) {
    await closeHandle(handle);
    throw error;
  }
};

export const verifyRetainedDirectory = async (
  retained: RetainedDirectory,
  operation: string
): Promise<void> => {
  const retainedMetadata = await retained.handle.stat();
  assertTrustedDirectoryMetadata(retainedMetadata, operation);
  const pathHandle = await open(retained.path, SAFE_DIRECTORY_OPEN_FLAGS);
  try {
    const pathMetadata = await pathHandle.stat();
    assertTrustedDirectoryMetadata(pathMetadata, operation);
    if (
      pathMetadata.dev !== retainedMetadata.dev ||
      pathMetadata.ino !== retainedMetadata.ino
    ) {
      throw pathFailure(operation, "directory-identity-changed");
    }
  } finally {
    await closeHandle(pathHandle);
  }
};

const inspectDirectory = async (
  path: string,
  operation: string,
  expectedRealPath: string,
  ownerOnly: boolean
): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw pathFailure(operation, "symbolic-link");
  }
  if (!metadata.isDirectory()) {
    throw pathFailure(operation, "not-directory");
  }
  if ((await realpath(path)) !== expectedRealPath) {
    throw pathFailure(operation, "symlink-traversal");
  }
  const handle = await open(path, SAFE_DIRECTORY_OPEN_FLAGS);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isDirectory()) {
      throw pathFailure(operation, "not-directory");
    }
    if (ownerOnly) {
      await handle.chmod(0o700);
    }
  } finally {
    await closeHandle(handle);
  }
  if ((await realpath(path)) !== expectedRealPath) {
    throw pathFailure(operation, "symlink-traversal");
  }
};

const containedSegments = (
  anchor: string,
  target: string,
  operation: string
): readonly string[] => {
  const relativePath = relative(anchor, target);
  if (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  ) {
    return relativePath === "" ? [] : relativePath.split(sep);
  }
  throw pathFailure(operation, "outside-trusted-root");
};

export const canonicalDirectory = async (
  path: string,
  operation: string
): Promise<string> => {
  const resolvedPath = resolve(path);
  const metadata = await lstat(resolvedPath);
  if (metadata.isSymbolicLink()) {
    throw pathFailure(operation, "symbolic-link");
  }
  if (!metadata.isDirectory()) {
    throw pathFailure(operation, "not-directory");
  }
  const canonicalPath = await realpath(resolvedPath);
  await inspectDirectory(resolvedPath, operation, canonicalPath, false);
  return canonicalPath;
};

export const assertNoSymlinkPathComponents = async (
  path: string,
  operation: string
): Promise<void> => {
  const resolvedPath = resolve(path);
  let component = resolvedPath;
  while (true) {
    const componentMetadata = await lstat(component);
    if (componentMetadata.isSymbolicLink()) {
      throw pathFailure(operation, "symbolic-link-component");
    }
    const parent = dirname(component);
    if (parent === component) {
      break;
    }
    component = parent;
  }
};

export const ensureOwnerOnlyDirectoryTree = async (options: {
  readonly anchor: string;
  readonly operation: string;
  readonly target: string;
}): Promise<string> => {
  const canonicalAnchor = await canonicalDirectory(
    options.anchor,
    options.operation
  );
  const resolvedTarget = resolve(options.target);
  const segments = containedSegments(
    canonicalAnchor,
    resolvedTarget,
    options.operation
  );
  let current = canonicalAnchor;
  for (const segment of segments) {
    current = resolve(current, segment);
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
    await inspectDirectory(current, options.operation, current, true);
  }
  return resolvedTarget;
};

const assertSafeLeafPath = async (
  options: {
    readonly anchor?: string;
    readonly operation: string;
    readonly path: string;
  },
  leafKind: "file" | "socket"
): Promise<void> => {
  const resolvedPath = resolve(options.path);
  const lexicalParent = dirname(resolvedPath);
  const anchorInput = options.anchor ?? lexicalParent;
  const canonicalAnchor = await canonicalDirectory(
    anchorInput,
    options.operation
  );
  const relativeFromInput = relative(resolve(anchorInput), resolvedPath);
  const canonicalTarget = resolve(canonicalAnchor, relativeFromInput);
  const canonicalParent = dirname(canonicalTarget);
  const parentSegments = containedSegments(
    canonicalAnchor,
    canonicalParent,
    options.operation
  );
  let current = canonicalAnchor;
  for (const segment of parentSegments) {
    current = resolve(current, segment);
    await inspectDirectory(current, options.operation, current, false);
  }
  try {
    const metadata = await lstat(canonicalTarget);
    if (metadata.isSymbolicLink()) {
      throw pathFailure(options.operation, "symbolic-link");
    }
    const hasExpectedKind =
      leafKind === "file" ? metadata.isFile() : metadata.isSocket();
    if (!hasExpectedKind) {
      throw pathFailure(options.operation, `not-${leafKind}`);
    }
    if (leafKind === "file") {
      const handle = await open(canonicalTarget, SAFE_FILE_OPEN_FLAGS);
      try {
        if (!(await handle.stat()).isFile()) {
          throw pathFailure(options.operation, "not-regular-file");
        }
      } finally {
        await closeHandle(handle);
      }
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
};

export const assertSafeFilePath = (options: {
  readonly anchor?: string;
  readonly operation: string;
  readonly path: string;
}): Promise<void> => assertSafeLeafPath(options, "file");

export const assertSafeSocketPath = (options: {
  readonly anchor?: string;
  readonly operation: string;
  readonly path: string;
}): Promise<void> => assertSafeLeafPath(options, "socket");

export const openRegularFileNoFollow = async (
  path: string,
  operation: string
): Promise<FileHandle> => {
  const handle = await open(path, SAFE_FILE_OPEN_FLAGS);
  try {
    if ((await handle.stat()).isFile()) {
      return handle;
    }
  } catch (error) {
    await closeHandle(handle);
    throw error;
  }
  await closeHandle(handle);
  throw pathFailure(operation, "not-regular-file");
};
