import type { FileInfo } from '@laborer/shared/rpc'
import type { FileDiffMetadata } from '@pierre/diffs'
import { parseDiffFromFile, parsePatchFiles } from '@pierre/diffs'

interface FileReadResult {
  readonly content: string
  readonly diff?: string
  readonly type: string
}

/**
 * Convert a `file.read` response into Pierre's metadata format. Untracked files
 * do not have a git patch, so we synthesize one from an empty file.
 */
export const parseFileDiff = ({
  filePath,
  result,
  status,
}: {
  readonly filePath: string
  readonly result: FileReadResult
  readonly status?: FileInfo['status'] | undefined
}): FileDiffMetadata | null => {
  if (result.diff) {
    const parsed = parsePatchFiles(result.diff)
    return parsed.flatMap((entry) => entry.files)[0] ?? null
  }

  if (result.type !== 'text' || status !== 'added') {
    return null
  }

  return parseDiffFromFile(
    { name: filePath, contents: '' },
    { name: filePath, contents: result.content }
  )
}
