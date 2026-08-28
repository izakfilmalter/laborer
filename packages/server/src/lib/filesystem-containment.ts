import {
  type FileHandle,
  mkdir,
  open,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Schema } from 'effect'

export class FilesystemContainmentError extends Schema.TaggedError<FilesystemContainmentError>()(
  'FilesystemContainmentError',
  {
    reason: Schema.Literals(['PATH_TRAVERSAL', 'IO_FAILED']),
    message: Schema.String,
  }
) {}

const isContained = (root: string, target: string): boolean => {
  const pathFromRoot = relative(root, target)
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`))
  )
}

const assertContained = (
  root: string,
  target: string,
  requestedPath: string
) => {
  if (!isContained(root, target)) {
    throw new FilesystemContainmentError({
      reason: 'PATH_TRAVERSAL',
      message: `Path escapes canonical root: ${requestedPath}`,
    })
  }
}

const mapError = (error: unknown, requestedPath: string) =>
  error instanceof FilesystemContainmentError
    ? error
    : new FilesystemContainmentError({
        reason: 'IO_FAILED',
        message: `Filesystem operation failed for ${requestedPath}: ${String(error)}`,
      })

export const canonicalizeRoot = async (root: string): Promise<string> => {
  try {
    return await realpath(root)
  } catch (error) {
    throw mapError(error, root)
  }
}

export interface ContainedRead {
  readonly byteLength: number
  readonly contents: Buffer
}

/**
 * Read a file addressed relative to `root`.
 *
 * Both the root and the target are canonicalized before the containment check,
 * so a symlink pointing outside the root is rejected rather than followed.
 */
export const readContainedFile = async (
  root: string,
  requestedPath: string,
  maxBytes: number
): Promise<ContainedRead> => {
  let handle: FileHandle | undefined
  try {
    const canonicalRoot = await canonicalizeRoot(root)
    const lexicalTarget = resolve(canonicalRoot, requestedPath)
    assertContained(canonicalRoot, lexicalTarget, requestedPath)
    const canonicalTarget = await realpath(lexicalTarget)
    assertContained(canonicalRoot, canonicalTarget, requestedPath)

    handle = await open(canonicalTarget, 'r')
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new FilesystemContainmentError({
        reason: 'PATH_TRAVERSAL',
        message: `Path is not a regular file: ${requestedPath}`,
      })
    }
    const bytesToRead = Math.min(stats.size, maxBytes)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    return {
      contents: buffer.subarray(0, bytesRead),
      byteLength: stats.size,
    }
  } catch (error) {
    throw mapError(error, requestedPath)
  } finally {
    await handle?.close()
  }
}

/**
 * Write a file addressed relative to `root`, creating parent directories.
 *
 * Containment is checked lexically against the canonical root, matching the
 * upstream editor save path this was ported from.
 */
export const writeContainedFile = async (
  root: string,
  requestedPath: string,
  contents: string | Uint8Array,
  mode = 0o666
): Promise<string> => {
  try {
    const canonicalRoot = await canonicalizeRoot(root)
    const target = resolve(canonicalRoot, requestedPath)
    assertContained(canonicalRoot, target, requestedPath)
    if (relative(canonicalRoot, target) === '') {
      throw new FilesystemContainmentError({
        reason: 'PATH_TRAVERSAL',
        message: `Cannot write to the canonical root: ${requestedPath}`,
      })
    }

    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents, { mode })
    return target
  } catch (error) {
    throw mapError(error, requestedPath)
  }
}
