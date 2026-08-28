import { constants, type Stats } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
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

const sameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino

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

const canonicalExistingAncestor = async (
  target: string,
  requestedPath: string
): Promise<{
  readonly ancestor: string
  readonly missing: readonly string[]
}> => {
  const missing: string[] = []
  let candidate = target

  while (true) {
    try {
      return { ancestor: await realpath(candidate), missing: missing.reverse() }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw mapError(error, requestedPath)
      }
      const parent = dirname(candidate)
      if (parent === candidate) {
        throw mapError(error, requestedPath)
      }
      missing.push(basename(candidate))
      candidate = parent
    }
  }
}

const verifyOpenedFile = async (
  handle: FileHandle,
  root: string,
  path: string,
  requestedPath: string
): Promise<void> => {
  const canonicalPath = await realpath(path)
  assertContained(root, canonicalPath, requestedPath)
  const [openedStats, pathStats] = await Promise.all([
    handle.stat(),
    lstat(canonicalPath),
  ])
  if (
    !(
      openedStats.isFile() &&
      pathStats.isFile() &&
      sameFile(openedStats, pathStats)
    )
  ) {
    throw new FilesystemContainmentError({
      reason: 'PATH_TRAVERSAL',
      message: `Path changed while opening: ${requestedPath}`,
    })
  }
}

export interface ContainedRead {
  readonly byteLength: number
  readonly contents: Buffer
}

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

    // biome-ignore lint/suspicious/noBitwiseOperators: Node open flags are bitmasks.
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW
    handle = await open(canonicalTarget, flags)
    await verifyOpenedFile(
      handle,
      canonicalRoot,
      canonicalTarget,
      requestedPath
    )
    const stats = await handle.stat()
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

export const writeContainedFile = async (
  root: string,
  requestedPath: string,
  contents: string | Uint8Array,
  mode = 0o666
): Promise<string> => {
  let handle: FileHandle | undefined
  try {
    const canonicalRoot = await canonicalizeRoot(root)
    const lexicalTarget = resolve(canonicalRoot, requestedPath)
    assertContained(canonicalRoot, lexicalTarget, requestedPath)

    const { ancestor, missing } = await canonicalExistingAncestor(
      lexicalTarget,
      requestedPath
    )
    assertContained(canonicalRoot, ancestor, requestedPath)
    let target = resolve(ancestor, ...missing)
    assertContained(canonicalRoot, target, requestedPath)

    await mkdir(dirname(target), { recursive: true })
    const canonicalParent = await realpath(dirname(target))
    assertContained(canonicalRoot, canonicalParent, requestedPath)
    target = resolve(canonicalParent, basename(target))

    try {
      const canonicalTarget = await realpath(target)
      assertContained(canonicalRoot, canonicalTarget, requestedPath)
      target = canonicalTarget
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    // biome-ignore lint/suspicious/noBitwiseOperators: Node open flags are bitmasks.
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
    handle = await open(target, flags, mode)
    await verifyOpenedFile(handle, canonicalRoot, target, requestedPath)
    await handle.truncate(0)
    await handle.writeFile(contents)
    return target
  } catch (error) {
    throw mapError(error, requestedPath)
  } finally {
    await handle?.close()
  }
}
