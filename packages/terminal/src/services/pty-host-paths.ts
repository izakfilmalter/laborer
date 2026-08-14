import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const PTY_HOST_PROTOCOL_VERSION = '1'
export const PTY_HOST_REGISTRATION_FILE = 'pty-host.json'
export const PTY_HOST_SOCKET_FILE = 'pty-host.sock'
const MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 103

/** Content identity captured at host boot so a later dev rebuild is visible. */
export const resolvePtyHostVersion = (entryPath: string): string =>
  `${PTY_HOST_PROTOCOL_VERSION}-${createHash('sha256').update(readFileSync(entryPath)).digest('hex').slice(0, 12)}`

export const resolveLaborerStateRoot = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const configured = environment.XDG_STATE_HOME?.trim()
  const stateHome =
    configured !== undefined && isAbsolute(configured)
      ? configured
      : join(homedir(), '.local', 'state')
  return resolve(stateHome, 'laborer')
}

export const resolvePtyHostPaths = (
  environment: NodeJS.ProcessEnv = process.env
) => {
  const stateDir = join(resolveLaborerStateRoot(environment), 'pty-host')
  const stateSocketPath = join(stateDir, PTY_HOST_SOCKET_FILE)
  if (
    Buffer.byteLength(stateSocketPath, 'utf8') <=
    MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES
  ) {
    return {
      registrationPath: join(stateDir, PTY_HOST_REGISTRATION_FILE),
      socketPath: stateSocketPath,
      stateDir,
    }
  }
  const identity = createHash('sha256')
    .update(stateDir)
    .digest('hex')
    .slice(0, 24)
  const aliasRoot = join(
    '/tmp',
    `laborer-pty-host-${String(process.getuid?.() ?? 'user')}`
  )
  const socketAliasPath = join(aliasRoot, identity)
  return {
    registrationPath: join(stateDir, PTY_HOST_REGISTRATION_FILE),
    socketAliasPath,
    socketPath: join(socketAliasPath, PTY_HOST_SOCKET_FILE),
    stateDir,
  }
}

/**
 * macOS limits Unix socket path names to 103 bytes. For a longer worktree
 * state path, bind through an owner-only deterministic symlink so the socket
 * inode still lives in the required state directory.
 */
export const preparePtyHostSocketPath = (
  paths: ReturnType<typeof resolvePtyHostPaths>
): void => {
  mkdirSync(paths.stateDir, { mode: 0o700, recursive: true })
  if (!('socketAliasPath' in paths)) {
    return
  }
  const aliasRoot = resolve(paths.socketAliasPath, '..')
  mkdirSync(aliasRoot, { mode: 0o700, recursive: true })
  chmodSync(aliasRoot, 0o700)
  try {
    const metadata = lstatSync(paths.socketAliasPath)
    if (
      !metadata.isSymbolicLink() ||
      resolve(aliasRoot, readlinkSync(paths.socketAliasPath)) !== paths.stateDir
    ) {
      throw new Error(`Unsafe PTY host socket alias: ${paths.socketAliasPath}`)
    }
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null
        ? Reflect.get(error, 'code')
        : undefined
    if (code !== 'ENOENT') {
      throw error
    }
    symlinkSync(paths.stateDir, paths.socketAliasPath, 'dir')
  }
}
