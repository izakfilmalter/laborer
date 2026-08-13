import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

export const WORKTREE_OWNER_MARKER_NAME = '.laborer-worktree-owner.json'
export const WORKTREE_OWNER_MARKER_MAX_BYTES = 16 * 1024

export interface WorktreeOwnerMarker {
  readonly conversationId: string
  readonly executionId: string
  readonly operationId: string
  readonly rootAuthorityDigest: string
  readonly schemaVersion: 1
  readonly worktreeName: string
}

const markerKeys = [
  'conversationId',
  'executionId',
  'operationId',
  'rootAuthorityDigest',
  'schemaVersion',
  'worktreeName',
] as const

/** Decode the persisted marker schema, rejecting unknown and malformed fields. */
export const parseWorktreeOwnerMarker = (
  value: unknown
): WorktreeOwnerMarker => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== markerKeys.length ||
    !markerKeys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error('Invalid worktree owner marker')
  }
  const conversationId = Reflect.get(value, 'conversationId')
  const executionId = Reflect.get(value, 'executionId')
  const operationId = Reflect.get(value, 'operationId')
  const rootAuthorityDigest = Reflect.get(value, 'rootAuthorityDigest')
  const schemaVersion = Reflect.get(value, 'schemaVersion')
  const worktreeName = Reflect.get(value, 'worktreeName')
  if (
    typeof conversationId !== 'string' ||
    typeof executionId !== 'string' ||
    typeof operationId !== 'string' ||
    typeof rootAuthorityDigest !== 'string' ||
    schemaVersion !== 1 ||
    typeof worktreeName !== 'string'
  ) {
    throw new Error('Invalid worktree owner marker')
  }
  return {
    conversationId,
    executionId,
    operationId,
    rootAuthorityDigest,
    schemaVersion,
    worktreeName,
  }
}

const serializeMarker = (marker: WorktreeOwnerMarker): string => {
  const source = JSON.stringify(parseWorktreeOwnerMarker(marker))
  if (Buffer.byteLength(source) > WORKTREE_OWNER_MARKER_MAX_BYTES) {
    throw new Error('Worktree owner marker exceeds the size limit')
  }
  return source
}

const markerPath = (worktreePath: string): string =>
  join(worktreePath, WORKTREE_OWNER_MARKER_NAME)

const assertReadableMetadata = (metadata: Stats): void => {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > WORKTREE_OWNER_MARKER_MAX_BYTES ||
    metadata.mode % 0o1000 !== 0o600
  ) {
    throw new Error('Invalid worktree owner marker')
  }
}

const decodeSource = (source: string): WorktreeOwnerMarker =>
  parseWorktreeOwnerMarker(JSON.parse(source) as unknown)

const readBounded = async (
  file: Awaited<ReturnType<typeof open>>
): Promise<string> => {
  const bytes = Buffer.alloc(WORKTREE_OWNER_MARKER_MAX_BYTES + 1)
  let totalBytesRead = 0
  while (totalBytesRead < bytes.byteLength) {
    const { bytesRead } = await file.read(
      bytes,
      totalBytesRead,
      bytes.byteLength - totalBytesRead,
      totalBytesRead
    )
    if (bytesRead === 0) {
      break
    }
    totalBytesRead += bytesRead
  }
  if (totalBytesRead > WORKTREE_OWNER_MARKER_MAX_BYTES) {
    throw new Error('Invalid worktree owner marker')
  }
  return bytes.toString('utf8', 0, totalBytesRead)
}

const readBoundedSync = (descriptor: number): string => {
  const bytes = Buffer.alloc(WORKTREE_OWNER_MARKER_MAX_BYTES + 1)
  let totalBytesRead = 0
  while (totalBytesRead < bytes.byteLength) {
    const bytesRead = readSync(
      descriptor,
      bytes,
      totalBytesRead,
      bytes.byteLength - totalBytesRead,
      totalBytesRead
    )
    if (bytesRead === 0) {
      break
    }
    totalBytesRead += bytesRead
  }
  if (totalBytesRead > WORKTREE_OWNER_MARKER_MAX_BYTES) {
    throw new Error('Invalid worktree owner marker')
  }
  return bytes.toString('utf8', 0, totalBytesRead)
}

/** Create and durably flush a private owner marker without following links. */
export const writeWorktreeOwnerMarker = async (
  worktreePath: string,
  marker: WorktreeOwnerMarker
): Promise<void> => {
  const source = serializeMarker(marker)
  const file = await open(
    markerPath(worktreePath),
    constants.O_WRONLY +
      constants.O_CREAT +
      constants.O_EXCL +
      constants.O_NOFOLLOW,
    0o600
  )
  try {
    await file.writeFile(source)
    await file.chmod(0o600)
    await file.sync()
  } finally {
    await file.close()
  }
  const directory = await open(worktreePath, constants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

/** Securely read a marker and reject replacement between path and handle checks. */
export const readWorktreeOwnerMarker = async (
  worktreePath: string
): Promise<WorktreeOwnerMarker> => {
  const path = markerPath(worktreePath)
  const pathMetadata = await lstat(path)
  assertReadableMetadata(pathMetadata)
  const file = await open(path, constants.O_RDONLY + constants.O_NOFOLLOW)
  try {
    const openedMetadata = await file.stat()
    assertReadableMetadata(openedMetadata)
    if (
      openedMetadata.dev !== pathMetadata.dev ||
      openedMetadata.ino !== pathMetadata.ino
    ) {
      throw new Error('Invalid worktree owner marker')
    }
    return decodeSource(await readBounded(file))
  } finally {
    await file.close()
  }
}

/** Synchronous reader for the mission-control server's passive inspection path. */
export const readWorktreeOwnerMarkerSync = (
  worktreePath: string
): WorktreeOwnerMarker => {
  let descriptor: number | undefined
  try {
    const path = markerPath(worktreePath)
    const pathMetadata = lstatSync(path)
    assertReadableMetadata(pathMetadata)
    descriptor = openSync(path, constants.O_RDONLY + constants.O_NOFOLLOW)
    const metadata = fstatSync(descriptor)
    assertReadableMetadata(metadata)
    if (
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino
    ) {
      throw new Error('Invalid worktree owner marker')
    }
    return decodeSource(readBoundedSync(descriptor))
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}
