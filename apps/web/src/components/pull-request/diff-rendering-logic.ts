// biome-ignore-all lint/suspicious/noBitwiseOperators: FNV-1a is defined over 32-bit XOR and unsigned wraparound arithmetic — the operators are the algorithm.
/**
 * Parsing and keying the pull request's multi-file unified patch, ported
 * from the parts of t3code's `diffRendering.ts` the Code tab reads.
 * Laborer's own `@/lib/file-diff` parses one file per entry; the PR diff
 * arrives as whole slices of many files, which is what this handles.
 */
import type { FileDiffMetadata } from '@pierre/diffs'
import { parsePatchFiles } from '@pierre/diffs'

const FNV_OFFSET_BASIS_32 = 0x81_1c_9d_c5
const FNV_PRIME_32 = 0x01_00_01_93
const SECONDARY_HASH_SEED = 0x9e_37_79_b9
const SECONDARY_HASH_MULTIPLIER = 0x85_eb_ca_6b

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32
): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, multiplier) >>> 0
  }
  return hash >>> 0
}

export function buildPatchCacheKey(
  patch: string,
  scope = 'diff-panel'
): string {
  const normalizedPatch = patch.trim()
  const primary = fnv1a32(
    normalizedPatch,
    FNV_OFFSET_BASIS_32,
    FNV_PRIME_32
  ).toString(36)
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER
  ).toString(36)
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`
}

export type RenderablePatch =
  | { kind: 'files'; files: FileDiffMetadata[] }
  | { kind: 'raw'; text: string; reason: string }

export interface DiffLineStat {
  additions: number
  deletions: number
}

export function getDiffLineStat(
  files: readonly FileDiffMetadata[]
): DiffLineStat {
  return files.reduce<DiffLineStat>(
    (total, file) => {
      for (const hunk of file.hunks) {
        total.additions += hunk.additionLines
        total.deletions += hunk.deletionLines
      }
      return total
    },
    { additions: 0, deletions: 0 }
  )
}

/**
 * Pierre's partial-patch parser keeps hunk render starts in source-file
 * coordinates; its virtualizer iterates partial patches as compact rows,
 * so PR diffs need compact render starts while retaining collapsedBefore
 * for the "N unmodified lines" separator.
 */
export function compactPartialHunkOffsets(
  file: FileDiffMetadata
): FileDiffMetadata {
  if (!file.isPartial) {
    return file
  }

  let splitLineStart = 0
  let unifiedLineStart = 0
  const hunks = file.hunks.map((hunk) => {
    const compactHunk = {
      ...hunk,
      splitLineStart,
      unifiedLineStart,
    }
    splitLineStart += hunk.splitLineCount
    unifiedLineStart += hunk.unifiedLineCount
    return compactHunk
  })

  return {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:compact-partial` } : {}),
  }
}

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = 'diff-panel'
): RenderablePatch | null {
  if (!patch) {
    return null
  }
  const normalizedPatch = patch.trim()
  if (normalizedPatch.length === 0) {
    return null
  }

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope)
    )
    const files = parsedPatches.flatMap((parsedPatch) =>
      parsedPatch.files.map(compactPartialHunkOffsets)
    )
    if (files.length > 0) {
      return { kind: 'files', files }
    }
    return {
      kind: 'raw',
      text: normalizedPatch,
      reason: 'Unsupported diff format. Showing raw patch.',
    }
  } catch {
    return {
      kind: 'raw',
      text: normalizedPatch,
      reason: 'Failed to parse patch. Showing raw patch.',
    }
  }
}

export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? ''
  if (raw.startsWith('a/') || raw.startsWith('b/')) {
    return raw.slice(2)
  }
  return raw
}

/**
 * What the file was called before the change. Only a rename makes it
 * differ from the current path.
 */
export function resolveFileDiffPreviousPath(
  fileDiff: FileDiffMetadata
): string {
  const raw = fileDiff.prevName ?? fileDiff.name ?? ''
  if (raw.startsWith('a/') || raw.startsWith('b/')) {
    return raw.slice(2)
  }
  return raw
}

export function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  const cacheKey = fileDiff.cacheKey
  if (!cacheKey) {
    return `${fileDiff.prevName ?? 'none'}:${fileDiff.name}`
  }
  return cacheKey.endsWith(':hydrated')
    ? cacheKey.slice(0, -':hydrated'.length)
    : cacheKey
}
