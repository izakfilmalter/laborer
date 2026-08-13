/**
 * Worker pool provider for @pierre/diffs syntax highlighting.
 *
 * Without this provider, Pierre's `FileDiff` falls back to an
 * in-process shiki highlighter that tokenizes every line on the main
 * thread — for large diffs this blocks the UI long enough to crash the
 * pane. Mounting `WorkerPoolContextProvider` moves parsing and
 * highlighting into a pool of Web Workers.
 *
 * The underlying pool is a ref-counted module singleton
 * (`getOrCreateWorkerPoolSingleton`), so mounting this provider from
 * multiple DiffPane instances shares one pool.
 *
 * Modeled on t3code's `DiffWorkerPoolProvider`.
 */

import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'
import type { ReactNode } from 'react'
import { useMemo } from 'react'

/** Pool size bounds — at least 2 workers, at most 6. */
const MIN_POOL_SIZE = 2
const MAX_POOL_SIZE = 6
const DEFAULT_CORES = 4

/** Skip syntax highlighting for pathologically long lines (minified code). */
const TOKENIZE_MAX_LINE_LENGTH = 1000

/** Bound the per-pool highlighted-AST LRU cache. */
const TOTAL_AST_LRU_CACHE_SIZE = 240

const computePoolSize = (): number => {
  const cores = Math.max(1, navigator.hardwareConcurrency || DEFAULT_CORES)
  return Math.max(MIN_POOL_SIZE, Math.min(MAX_POOL_SIZE, Math.floor(cores / 2)))
}

export function DiffWorkerPoolProvider({
  children,
}: {
  readonly children: ReactNode
}) {
  const poolOptions = useMemo(
    () => ({
      workerFactory: () => new DiffsWorker(),
      poolSize: computePoolSize(),
      totalASTLRUCacheSize: TOTAL_AST_LRU_CACHE_SIZE,
    }),
    []
  )

  const highlighterOptions = useMemo(
    () => ({
      theme: {
        dark: 'pierre-dark' as const,
        light: 'pierre-light' as const,
      },
      tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
    }),
    []
  )

  return (
    <WorkerPoolContextProvider
      highlighterOptions={highlighterOptions}
      poolOptions={poolOptions}
    >
      {children}
    </WorkerPoolContextProvider>
  )
}
