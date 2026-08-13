import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
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
    !markerKeys.every((key) => key in value)
  ) {
    throw new Error('Invalid worktree owner marker')
  }
  const marker = value as Record<(typeof markerKeys)[number], unknown>
  if (
    typeof marker.conversationId !== 'string' ||
    typeof marker.executionId !== 'string' ||
    typeof marker.operationId !== 'string' ||
    typeof marker.rootAuthorityDigest !== 'string' ||
    marker.schemaVersion !== 1 ||
    typeof marker.worktreeName !== 'string'
  ) {
    throw new Error('Invalid worktree owner marker')
  }
  return marker as unknown as WorktreeOwnerMarker
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
    metadata.size > WORKTREE_OWNER_MARKER_MAX_BYTES
  ) {
    throw new Error('Invalid worktree owner marker')
  }
}

const decodeSource = (source: string): WorktreeOwnerMarker =>
  parseWorktreeOwnerMarker(JSON.parse(source) as unknown)

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
  if (pathMetadata.mode % 0o1000 !== 0o600) {
    throw new Error('Invalid worktree owner marker')
  }
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
    return decodeSource(await file.readFile('utf8'))
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
    descriptor = openSync(
      markerPath(worktreePath),
      constants.O_RDONLY + constants.O_NOFOLLOW
    )
    const metadata = fstatSync(descriptor)
    assertReadableMetadata(metadata)
    return decodeSource(readFileSync(descriptor, 'utf8'))
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}
