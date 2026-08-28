/**
 * Ported from t3code's `fileContentRevision.ts`. Laborer keys editor
 * identity by workspace id where t3 used an environment id, and reuses the
 * app's FNV-1a helper (t3 inlined the same algorithm).
 */

import { fnv1a32 } from '@/lib/fnv1a32'

export function fileContentRevision(contents: string): string {
  return `${contents.length}:${fnv1a32(contents).toString(36)}`
}

export function fileCacheKey(
  workspaceId: string,
  relativePath: string,
  contents: string
): string {
  return `${workspaceId}:${relativePath}:${fileContentRevision(contents)}`
}

interface EditorFileIdentity {
  readonly cacheKey?: string
  readonly contents: string
}

export function fileEditorCacheKey(
  workspaceId: string,
  relativePath: string,
  contents: string,
  editorFile: EditorFileIdentity | undefined
): string {
  if (editorFile?.contents === contents && editorFile.cacheKey) {
    return editorFile.cacheKey
  }
  return `editor:${fileCacheKey(workspaceId, relativePath, contents)}`
}
