/**
 * Query + optimistic-content state behind the Files surface.
 *
 * Ported from t3code's `projectFilesQueryState.ts`, adapted to Laborer's
 * AtomRpc client: entries come from `file.listEntries`, file text from
 * `file.readText`, and the optimistic layer shadows a file's server read
 * with locally edited contents while a debounced save is pending.
 *
 * t3 kept the optimistic values in a module-level atom registry; Laborer's
 * registry is created by `RegistryProvider`, so the imperative helpers take
 * the registry as an argument and components pass the one from context.
 */

import { useAtomRefresh, useAtomValue } from '@effect/atom-react/Hooks'
import type { FileEntriesResult, FileTextContent } from '@laborer/shared/rpc'
import { RpcError } from '@laborer/shared/rpc'
import { Cause, Effect, Option } from 'effect'
import {
  AsyncResult,
  Atom,
  type AtomRegistry,
} from 'effect/unstable/reactivity'
import { useCallback } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'

/** Per-attempt timeout so a dead connection can never hang the surface. */
const FILE_QUERY_TIMEOUT = '30 seconds'

const withTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: FILE_QUERY_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new RpcError({
            message: 'Timed out reading workspace files',
            code: 'TIMEOUT',
          })
        ),
    })
  )

export const fileEntriesQueryAtom = Atom.family((workspaceId: string) =>
  LaborerClient.runtime.atom(
    withTimeout(
      Effect.flatMap(LaborerClient, (client) =>
        client('file.listEntries', { workspaceId })
      )
    )
  )
)

/**
 * `Atom.family` keys by identity, so compound keys are strings. The newline
 * separator cannot appear in either half.
 */
const fileQueryKey = (workspaceId: string, relativePath: string): string =>
  `${workspaceId}\n${relativePath}`

const splitFileQueryKey = (key: string): [string, string] => {
  const separator = key.indexOf('\n')
  return [key.slice(0, separator), key.slice(separator + 1)]
}

export const fileTextQueryAtom = Atom.family((key: string) => {
  const [workspaceId, relativePath] = splitFileQueryKey(key)
  return LaborerClient.runtime.atom(
    withTimeout(
      Effect.flatMap(LaborerClient, (client) =>
        client('file.readText', { workspaceId, filePath: relativePath })
      )
    )
  )
})

/** A query atom that stays Initial forever, for disabled reads. */
const EMPTY_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<FileTextContent, RpcError>(false)
)

/**
 * Locally edited contents shadowing the server read. `confirmed` means the
 * server acknowledged this exact text and the shadow is only waiting for
 * the refetch to catch up before it clears.
 */
interface OptimisticFile {
  readonly confirmed: boolean
  readonly data: FileTextContent
}

const optimisticFileAtom = Atom.family((_key: string) =>
  Atom.make<OptimisticFile | null>(null)
)

const optimisticData = (
  contents: string,
  relativePath: string
): FileTextContent => ({
  relativePath,
  contents,
  byteLength: new TextEncoder().encode(contents).byteLength,
  truncated: false,
})

export function setFileQueryData(
  registry: AtomRegistry.AtomRegistry,
  workspaceId: string,
  relativePath: string,
  contents: string
): void {
  registry.set(optimisticFileAtom(fileQueryKey(workspaceId, relativePath)), {
    confirmed: false,
    data: optimisticData(contents, relativePath),
  })
}

export function getOptimisticFileQueryData(
  registry: AtomRegistry.AtomRegistry,
  workspaceId: string,
  relativePath: string
): FileTextContent | null {
  return (
    registry.get(optimisticFileAtom(fileQueryKey(workspaceId, relativePath)))
      ?.data ?? null
  )
}

/**
 * Mark the optimistic contents as server-acknowledged, then refetch the
 * real read and drop the shadow once the refetch reports the same text.
 * Returns false when the optimistic value has already moved past the
 * confirmed contents (a newer edit is pending).
 */
export function confirmFileQueryData(
  registry: AtomRegistry.AtomRegistry,
  workspaceId: string,
  relativePath: string,
  contents: string
): boolean {
  const key = fileQueryKey(workspaceId, relativePath)
  const atom = optimisticFileAtom(key)
  const optimisticFile = registry.get(atom)
  if (optimisticFile?.data.contents !== contents) {
    return false
  }

  const confirmed: OptimisticFile = { ...optimisticFile, confirmed: true }
  registry.set(atom, confirmed)

  const queryAtom = fileTextQueryAtom(key)
  const unsubscribe = registry.subscribe(queryAtom, (result) => {
    if (result.waiting || result._tag === 'Initial') {
      return
    }
    unsubscribe()
    if (
      result._tag === 'Success' &&
      result.value.contents === contents &&
      registry.get(atom) === confirmed
    ) {
      registry.set(atom, null)
    }
  })
  registry.refresh(queryAtom)
  return true
}

export function clearFileQueryData(
  registry: AtomRegistry.AtomRegistry,
  workspaceId: string,
  relativePath: string
): void {
  registry.set(
    optimisticFileAtom(fileQueryKey(workspaceId, relativePath)),
    null
  )
}

interface FileQueryState<A> {
  readonly data: A | null
  readonly error: string | null
  readonly isPending: boolean
  readonly refresh: () => void
}

function errorMessage<A>(
  result: AsyncResult.AsyncResult<A, unknown>
): string | null {
  if (result._tag !== 'Failure') {
    return null
  }
  const cause = Cause.squash(result.cause)
  return cause instanceof Error ? cause.message : 'Workspace query failed.'
}

export function useFileEntriesQuery(
  workspaceId: string
): FileQueryState<FileEntriesResult> {
  const atom = fileEntriesQueryAtom(workspaceId)
  const result = useAtomValue(atom)
  const refreshAtom = useAtomRefresh(atom)
  const refresh = useCallback(() => refreshAtom(), [refreshAtom])
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  }
}

export function useFileTextQuery(
  workspaceId: string,
  relativePath: string | null,
  enabled = true
): FileQueryState<FileTextContent> {
  const key = fileQueryKey(workspaceId, relativePath ?? '')
  const atom =
    enabled && relativePath !== null
      ? fileTextQueryAtom(key)
      : EMPTY_FILE_QUERY_ATOM
  const result = useAtomValue(atom)
  const refreshAtom = useAtomRefresh(atom)
  const refresh = useCallback(() => refreshAtom(), [refreshAtom])
  const data = Option.getOrNull(AsyncResult.value(result))
  const optimisticResult = useAtomValue(optimisticFileAtom(key))
  const optimisticFile = relativePath === null ? null : optimisticResult

  return {
    data: optimisticFile?.data ?? data,
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  }
}
