/**
 * Hunk-context expansion for the diff pane: the loader behind it, the words
 * for what it is doing, and the one place that asks the viewer what it is
 * actually painting.
 *
 * A patch carries the changed lines and a few lines either side. Everything
 * else in the file is a collapsed gap the viewer will expand into — but only
 * if it is given a `loadDiffFiles` loader, because expansion needs the whole
 * file and a patch does not contain it. Without a loader the library's
 * `canHydrateCollapsedContext` is false and the separator paints no control
 * at all, which is where this pane was until now.
 *
 * ## Three jobs, one hook
 *
 * 1. **The loader.** One `file.diffContents` round trip per file, scoped to
 *    the pane's current target and cached by the request plus the patch's
 *    content hash, so a watcher refetch that changed the file misses and an
 *    identical redelivery hits. See `@/lib/diff-contents`.
 *
 * 2. **Saying what happened.** Expanding is a round trip, and a round trip
 *    can come back refused — a binary file, a path the base revision never
 *    had, a file too large to send whole. Each lands as a sentence in a live
 *    region, a short marker painted at the separator itself, and a toast, so
 *    pressing expand never appears to do nothing.
 *
 * 3. **Keeping the comment partition honest.** Expansion changes which lines
 *    are on screen without changing a single hunk, so a review comment that
 *    was correctly detached can become attached. `@/lib/diff-expansion` owns
 *    that question; this hook drives it from the viewer's post-render hook
 *    and hands the pane the answer.
 *
 * ## Keyboard
 *
 * The library paints the expand control as a `div[role="button"]` with no
 * `tabindex` and handles pointer clicks only, inside a shadow root the app
 * cannot style into focusability. The post-render pass below gives each
 * control a tab stop and a name, and the returned key handler activates it —
 * keyboard events are composed, so they reach the pane the same way the
 * header clicks already do.
 */

import { useAtomMount, useAtomValue } from '@effect/atom-react/Hooks'
import type { DiffTarget } from '@laborer/shared/rpc'
import type {
  CodeView,
  FileDiffLoadedFiles,
  FileDiffMetadata,
} from '@pierre/diffs'
import type { CodeViewHandle } from '@pierre/diffs/react'
import { Effect } from 'effect'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import type { DiffExpansionStatus } from '@/lib/diff-contents'
import {
  describeDiffContentsFailure,
  diffContentsCacheKey,
  diffContentsPayload,
  toLoadedDiffFiles,
  truncatedSideMessage,
} from '@/lib/diff-contents'
import type { DiffLineProbe, RenderedLineKeys } from '@/lib/diff-expansion'
import {
  readExpandedRenderedLines,
  renderedLinesSignature,
} from '@/lib/diff-expansion'
import { toast } from '@/lib/toast'

/**
 * How many unchanged lines one press reveals. Passed explicitly rather than
 * left at the library default so the amount is a stated product decision and
 * so the virtualizer's estimates are computed against a known number.
 */
export const DIFF_EXPANSION_LINE_COUNT = 40

/** Custom property the injected stylesheet paints at the separator. */
const EXPANSION_NOTE_PROPERTY = '--diff-expansion-note'

const EXPAND_BUTTON_SELECTOR = '[data-expand-button]'

/** The short marker painted into the separator, per status. */
const separatorNote = (status: DiffExpansionStatus | undefined): string => {
  if (status?._tag === 'loading') {
    return 'Loading…'
  }
  if (status?._tag === 'unavailable') {
    return 'Cannot expand'
  }
  return ''
}

/** A CSS `content` string, quoted and escaped. */
const asCSSString = (text: string): string => JSON.stringify(text)

const expandButtonLabel = (button: Element): string => {
  if (button.hasAttribute('data-expand-up')) {
    return 'Show more unchanged lines above'
  }
  if (button.hasAttribute('data-expand-down')) {
    return 'Show more unchanged lines below'
  }
  return 'Show more unchanged lines'
}

/**
 * One file's diff as this hook needs it: the parsed metadata the viewer was
 * handed, and the content key its patch was parsed under.
 */
export interface ExpandableDiffFile {
  readonly cacheKey: string
  readonly fileDiff: FileDiffMetadata
  readonly path: string
}

export interface DiffHunkExpansion {
  /** The whole sentence for what expansion is doing, for a live region. */
  readonly announcement: string
  /** Lines the viewer paints beyond a file's hunks, keyed by file path. */
  readonly expandedLines: ReadonlyMap<string, RenderedLineKeys>
  /** Activates an expand control the pane's key handler routed here. */
  readonly handleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  /** The viewer's `loadDiffFiles`. Stable across renders. */
  readonly loadDiffFiles: (
    fileDiff: FileDiffMetadata
  ) => Promise<FileDiffLoadedFiles>
  /** The viewer's `onPostRender`. Stable across renders. */
  readonly onPostRender: (
    node: HTMLElement,
    instance: unknown,
    phase: 'mount' | 'unmount' | 'update',
    context: { readonly id?: string; readonly item?: { readonly id: string } }
  ) => void
}

interface DiffHunkExpansionInput<LAnnotation> {
  readonly files: readonly ExpandableDiffFile[]
  /** Lines whose placement expansion could change, keyed by file path. */
  readonly probesByFile: ReadonlyMap<string, readonly DiffLineProbe[]>
  /** Workspace, target and whitespace as one string — the cache's outer key. */
  readonly requestKey: string
  readonly target: DiffTarget
  readonly viewerRef: RefObject<CodeViewHandle<LAnnotation> | null>
  readonly workspaceId: string
}

const EMPTY_EXPANDED_LINES: ReadonlyMap<string, RenderedLineKeys> = new Map()

export function useDiffHunkExpansion<LAnnotation>({
  files,
  probesByFile,
  requestKey,
  target,
  viewerRef,
  workspaceId,
}: DiffHunkExpansionInput<LAnnotation>): DiffHunkExpansion {
  useAtomMount(LaborerClient.runtime)
  const runtimeResult = useAtomValue(LaborerClient.runtime)

  const [statusByFile, setStatusByFile] = useState<
    ReadonlyMap<string, DiffExpansionStatus>
  >(() => new Map())
  const [expandedLines, setExpandedLines] =
    useState<ReadonlyMap<string, RenderedLineKeys>>(EMPTY_EXPANDED_LINES)

  // --- Everything the stable callbacks below have to read at call time ---
  const runtimeRef = useRef(runtimeResult)
  runtimeRef.current = runtimeResult
  const targetRef = useRef(target)
  targetRef.current = target
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const probesRef = useRef(probesByFile)
  probesRef.current = probesByFile
  const statusRef = useRef(statusByFile)
  statusRef.current = statusByFile

  /** Content key per parsed file, by the object identity the viewer holds. */
  const cacheKeyByFileDiff = useRef(new Map<FileDiffMetadata, string>())
  cacheKeyByFileDiff.current = new Map(
    files.map((file) => [file.fileDiff, file.cacheKey])
  )

  /**
   * Fetched contents, and refusals, by cache key.
   *
   * A refusal is cached like an answer: a binary file stays binary, and the
   * viewer retries its loader on every press, which would otherwise be a
   * round trip per press for a question already answered.
   */
  const contentsCache = useRef(new Map<string, Promise<FileDiffLoadedFiles>>())

  /** The nodes the status marker is painted onto, by file path. */
  const fileNodes = useRef(new Map<string, HTMLElement>())

  // A new question — a different target, workspace, or whitespace flag —
  // reads the old side at a different revision, so nothing fetched under the
  // previous one is an answer to this one.
  const [lastRequestKey, setLastRequestKey] = useState(requestKey)
  if (lastRequestKey !== requestKey) {
    setLastRequestKey(requestKey)
    contentsCache.current = new Map()
    setStatusByFile(new Map())
    setExpandedLines(EMPTY_EXPANDED_LINES)
  }

  const setStatus = useCallback((path: string, status: DiffExpansionStatus) => {
    setStatusByFile((previous) => new Map(previous).set(path, status))
  }, [])

  // --- The loader ---

  const loadDiffFiles = useCallback(
    async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      const payload = diffContentsPayload(fileDiff, {
        target: targetRef.current,
        workspaceId: workspaceIdRef.current,
      })
      const patchCacheKey = cacheKeyByFileDiff.current.get(fileDiff)
      if (payload === null || patchCacheKey === undefined) {
        throw new Error(
          `No hunk-context request for ${fileDiff.name} (${fileDiff.type})`
        )
      }

      const cacheKey = diffContentsCacheKey(requestKey, patchCacheKey)
      const cached = contentsCache.current.get(cacheKey)
      if (cached) {
        return await cached
      }

      const runtime = runtimeRef.current
      if (runtime._tag !== 'Success') {
        throw new Error('Not connected yet')
      }
      const context = runtime.value

      setStatus(payload.newPath, { _tag: 'loading' })

      const pending = Effect.runPromiseWith(context)(
        Effect.flatMap(LaborerClient, (client) =>
          client('file.diffContents', payload)
        )
      ).then(
        (contents): FileDiffLoadedFiles => {
          // A side the server cut off at its byte cap is shorter than the
          // file, so hydrating from it would drop the tail of every
          // expansion without saying so.
          const truncated = truncatedSideMessage(contents, payload.newPath)
          if (truncated !== null) {
            setStatus(payload.newPath, {
              _tag: 'unavailable',
              message: truncated,
            })
            toast.warning(truncated)
            throw new Error(truncated)
          }
          setStatus(payload.newPath, { _tag: 'ready' })
          return toLoadedDiffFiles(payload, contents, cacheKey)
        },
        (error: unknown) => {
          const message = describeDiffContentsFailure(error)
          setStatus(payload.newPath, { _tag: 'unavailable', message })
          toast.warning(message)
          throw new Error(message)
        }
      )

      contentsCache.current.set(cacheKey, pending)
      return await pending
    },
    [requestKey, setStatus]
  )

  // --- Reading back what the viewer paints ---

  /**
   * Re-read what the viewer is painting, and publish it only when it
   * differs. The comparison is what keeps this off a render loop: the
   * answer feeds the thread partition, the partition changes an item's
   * version, and a changed version brings the viewer back through
   * `onPostRender` to ask again.
   */
  const syncExpandedLines = useCallback(
    (probes: ReadonlyMap<string, readonly DiffLineProbe[]>) => {
      const viewer = viewerRef.current?.getInstance() as
        | CodeView<LAnnotation>
        | undefined
      const next = readExpandedRenderedLines(viewer, probes)
      setExpandedLines((previous) =>
        renderedLinesSignature(previous) === renderedLinesSignature(next)
          ? previous
          : next
      )
    },
    [viewerRef]
  )

  // A comment can arrive on the shared stream, or be resolved away, without
  // the viewer repainting anything — so the answer is re-read whenever the
  // question changes too, not only after a render pass.
  useEffect(() => {
    syncExpandedLines(probesByFile)
  }, [probesByFile, syncExpandedLines])

  // --- The viewer's post-render hook ---

  const paintStatus = useCallback((path: string, node: HTMLElement) => {
    node.style.setProperty(
      EXPANSION_NOTE_PROPERTY,
      asCSSString(separatorNote(statusRef.current.get(path)))
    )
  }, [])

  const onPostRender = useCallback(
    (
      node: HTMLElement,
      _instance: unknown,
      phase: 'mount' | 'unmount' | 'update',
      context: { readonly id?: string; readonly item?: { readonly id: string } }
    ) => {
      const path = context.item?.id ?? context.id
      if (path === undefined) {
        return
      }
      if (phase === 'unmount') {
        fileNodes.current.delete(path)
        return
      }

      fileNodes.current.set(path, node)
      paintStatus(path, node)

      // The library gives the control neither a tab stop nor a name. The
      // node handed here is the custom element that hosts the file, and
      // everything it paints — separators included — lives in its shadow
      // root, which an ordinary query does not cross.
      const root = node.shadowRoot ?? node
      for (const button of root.querySelectorAll(EXPAND_BUTTON_SELECTOR)) {
        if (!(button instanceof HTMLElement) || button.tabIndex === 0) {
          continue
        }
        button.tabIndex = 0
        button.setAttribute('aria-label', expandButtonLabel(button))
      }

      syncExpandedLines(probesRef.current)
    },
    [paintStatus, syncExpandedLines]
  )

  // A status changes between repaints — the round trip starts and lands on
  // its own schedule — so the marker is repainted from here as well.
  useEffect(() => {
    for (const [path, node] of fileNodes.current) {
      node.style.setProperty(
        EXPANSION_NOTE_PROPERTY,
        asCSSString(separatorNote(statusByFile.get(path)))
      )
    }
  }, [statusByFile])

  // --- Keyboard activation ---

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      const button = event.nativeEvent
        .composedPath()
        .find(
          (node): node is HTMLElement =>
            node instanceof HTMLElement && node.matches(EXPAND_BUTTON_SELECTOR)
        )
      if (!button) {
        return
      }
      // Space would otherwise scroll the viewer out from under the reader.
      event.preventDefault()
      button.click()
    },
    []
  )

  const announcement = (() => {
    for (const [path, status] of statusByFile) {
      if (status._tag === 'unavailable') {
        return status.message
      }
      if (status._tag === 'loading') {
        return `Loading the rest of ${path} to show the unchanged lines around this change`
      }
    }
    return ''
  })()

  return {
    announcement,
    expandedLines,
    handleKeyDown,
    loadDiffFiles,
    onPostRender,
  }
}
