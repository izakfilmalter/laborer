import koffi from 'koffi'

export class PosixDescriptorError extends Error {
  readonly errno: number

  constructor(operation: string, errno: number) {
    super(`${operation} failed with errno ${errno}`)
    this.name = 'PosixDescriptorError'
    this.errno = errno
  }
}

export interface PosixDescriptorFilesystem {
  readonly isMissing: (error: unknown) => boolean
  readonly mkdirAt: (directoryFd: number, name: string, mode: number) => void
  readonly openAt: (
    directoryFd: number,
    name: string,
    flags: number,
    mode?: number
  ) => number
  readonly readLinkAt: (directoryFd: number, name: string) => string | undefined
}

export const supportsPosixDescriptorFilesystem =
  process.platform === 'darwin' || process.platform === 'linux'

export const makePosixDescriptorFilesystem = (): PosixDescriptorFilesystem => {
  const libc = koffi.load(null)
  const mkdirat = libc.func(
    'int mkdirat(int dirfd, const char *path, unsigned int mode)'
  )
  const openat = libc.func(
    'int openat(int dirfd, const char *path, int flags, ...)'
  )
  const readlinkat = libc.func(
    'long readlinkat(int dirfd, const char *path, _Out_ void *buffer, unsigned long size)'
  )

  const error = (operation: string) =>
    new PosixDescriptorError(operation, koffi.errno())

  return {
    isMissing: (cause) =>
      cause instanceof PosixDescriptorError &&
      (cause.errno === koffi.os.errno.ENOENT ||
        cause.errno === koffi.os.errno.ENOTDIR),
    mkdirAt: (directoryFd, name, mode) => {
      if (mkdirat(directoryFd, name, mode) !== 0) {
        throw error(`mkdirat(${name})`)
      }
    },
    openAt: (directoryFd, name, flags, mode = 0) => {
      const descriptor = openat(directoryFd, name, flags, 'unsigned int', mode)
      if (descriptor < 0) {
        throw error(`openat(${name})`)
      }
      return descriptor
    },
    readLinkAt: (directoryFd, name) => {
      const buffer = Buffer.alloc(4096)
      const length = Number(
        readlinkat(directoryFd, name, buffer, buffer.byteLength)
      )
      if (length < 0) {
        return undefined
      }
      if (length === buffer.byteLength) {
        throw new PosixDescriptorError(
          `readlinkat(${name})`,
          koffi.os.errno.ENAMETOOLONG as number
        )
      }
      return buffer.toString('utf8', 0, length)
    },
  }
}
