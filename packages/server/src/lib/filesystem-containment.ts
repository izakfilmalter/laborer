// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Descriptor traversal and symlink restarts form one resource-owning state machine.
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  type Stats,
  writeSync,
} from 'node:fs'
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Schema } from 'effect'
import {
  makePosixDescriptorFilesystem,
  supportsPosixDescriptorFilesystem,
} from './posix-descriptor-filesystem.js'

export class FilesystemContainmentError extends Schema.TaggedError<FilesystemContainmentError>()(
  'FilesystemContainmentError',
  {
    reason: Schema.Literals([
      'PATH_TRAVERSAL',
      'IO_FAILED',
      'UNSUPPORTED_PLATFORM',
    ]),
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
  mode = 0o666,
  hooks?: { readonly beforeMutation?: () => void | Promise<void> }
): Promise<string> => {
  let rootHandle: FileHandle | undefined
  let directoryFd: number | undefined
  try {
    if (!supportsPosixDescriptorFilesystem) {
      throw new FilesystemContainmentError({
        reason: 'UNSUPPORTED_PLATFORM',
        message: `Descriptor-relative filesystem writes are unsupported on ${process.platform}`,
      })
    }

    const canonicalRoot = await canonicalizeRoot(root)
    const lexicalTarget = resolve(canonicalRoot, requestedPath)
    assertContained(canonicalRoot, lexicalTarget, requestedPath)
    const initialRelativePath = relative(canonicalRoot, lexicalTarget)
    if (initialRelativePath === '') {
      throw new FilesystemContainmentError({
        reason: 'PATH_TRAVERSAL',
        message: `Cannot write to the canonical root: ${requestedPath}`,
      })
    }

    const rootFlags =
      constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW
    const expectedRootStats = await lstat(canonicalRoot)
    rootHandle = await open(canonicalRoot, rootFlags)
    const rootStats = await rootHandle.stat()
    if (!(rootStats.isDirectory() && sameFile(expectedRootStats, rootStats))) {
      throw new FilesystemContainmentError({
        reason: 'PATH_TRAVERSAL',
        message: `Canonical root changed while opening: ${root}`,
      })
    }

    const descriptorFs = makePosixDescriptorFilesystem()
    const rootFd = rootHandle.fd
    let components = initialRelativePath.split(sep)
    let symlinkCount = 0
    await hooks?.beforeMutation?.()

    const resolveLink = (
      parentComponents: readonly string[],
      target: string
    ) => {
      symlinkCount += 1
      if (symlinkCount > 40) {
        throw new FilesystemContainmentError({
          reason: 'PATH_TRAVERSAL',
          message: `Too many symbolic links while writing: ${requestedPath}`,
        })
      }
      const linkTarget = isAbsolute(target)
        ? resolve(target)
        : resolve(canonicalRoot, ...parentComponents, target)
      assertContained(canonicalRoot, linkTarget, requestedPath)
      const nextRelativePath = relative(canonicalRoot, linkTarget)
      return nextRelativePath === '' ? [] : nextRelativePath.split(sep)
    }

    traversal: while (true) {
      if (components.length === 0) {
        throw new FilesystemContainmentError({
          reason: 'PATH_TRAVERSAL',
          message: `Symbolic link resolves to the canonical root: ${requestedPath}`,
        })
      }
      if (directoryFd !== undefined) {
        closeSync(directoryFd)
        directoryFd = undefined
      }
      let currentFd = rootFd

      for (let index = 0; index < components.length - 1; index += 1) {
        const component = components[index] as string
        let childFd: number
        try {
          const flags =
            constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW
          childFd = descriptorFs.openAt(currentFd, component, flags)
        } catch (error) {
          const linkTarget = descriptorFs.readLinkAt(currentFd, component)
          if (linkTarget !== undefined) {
            if (currentFd !== rootFd) {
              closeSync(currentFd)
              directoryFd = undefined
            }
            components = [
              ...resolveLink(components.slice(0, index), linkTarget),
              ...components.slice(index + 1),
            ]
            continue traversal
          }
          if (!descriptorFs.isMissing(error)) {
            throw error
          }
          descriptorFs.mkdirAt(currentFd, component, 0o777)
          // A competing rename can replace the new directory here. Reopening with
          // O_NOFOLLOW either pins that directory or rejects/resolves the replacement.
          try {
            const flags =
              constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW
            childFd = descriptorFs.openAt(currentFd, component, flags)
          } catch (openError) {
            const linkTarget = descriptorFs.readLinkAt(currentFd, component)
            if (linkTarget === undefined) {
              throw openError
            }
            if (currentFd !== rootFd) {
              closeSync(currentFd)
              directoryFd = undefined
            }
            components = [
              ...resolveLink(components.slice(0, index), linkTarget),
              ...components.slice(index + 1),
            ]
            continue traversal
          }
        }
        if (currentFd !== rootFd) {
          closeSync(currentFd)
        }
        currentFd = childFd
        directoryFd = childFd
      }

      directoryFd = currentFd === rootFd ? undefined : currentFd
      const finalName = components.at(-1) as string
      let fileFd: number
      try {
        const flags =
          constants.O_WRONLY + constants.O_CREAT + constants.O_NOFOLLOW
        fileFd = descriptorFs.openAt(currentFd, finalName, flags, mode)
      } catch (error) {
        const linkTarget = descriptorFs.readLinkAt(currentFd, finalName)
        if (linkTarget === undefined) {
          throw error
        }
        components = resolveLink(components.slice(0, -1), linkTarget)
        continue
      }

      try {
        if (!fstatSync(fileFd).isFile()) {
          throw new FilesystemContainmentError({
            reason: 'PATH_TRAVERSAL',
            message: `Write target is not a regular file: ${requestedPath}`,
          })
        }
        ftruncateSync(fileFd, 0)
        const buffer =
          typeof contents === 'string' ? Buffer.from(contents) : contents
        let offset = 0
        while (offset < buffer.byteLength) {
          offset += writeSync(
            fileFd,
            buffer,
            offset,
            buffer.byteLength - offset
          )
        }
      } finally {
        closeSync(fileFd)
      }
      return resolve(canonicalRoot, ...components)
    }
  } catch (error) {
    throw mapError(error, requestedPath)
  } finally {
    if (directoryFd !== undefined) {
      closeSync(directoryFd)
    }
    await rootHandle?.close()
  }
}
