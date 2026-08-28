// biome-ignore-all lint/style/noNestedTernary: ported near-verbatim from t3code, which chains presentation ternaries in JSX.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the panel is t3code's, ported whole; splitting it would diverge from the source it mirrors.

/**
 * The Files surface's shared panel, ported from t3code's
 * `FilePreviewPanel`.
 *
 * Serves both right-panel shapes: the standalone `files` surface (full-
 * width explorer) and `file:<path>` surfaces (file content with an
 * optional explorer aside). File text is syntax-highlighted, virtualized,
 * and editable with a 500ms debounced save; markdown offers a rendered
 * view; images preview from `file.read`'s base64 payload; reveal-line
 * requests scroll and highlight their target line.
 *
 * Laborer adaptations:
 * - Queries key by workspace id (t3: environment + cwd), backed by the
 *   `file.readText` / `file.write` RPCs.
 * - t3's composer review-comment annotations, drag mentions, and the
 *   browser-preview handoff are left out (no chat composer or Browser
 *   surface here yet); its OpenInPicker becomes a plain open-in-editor
 *   button on the `editor.open` RPC.
 * - Rendered markdown uses `@laborer/ui`'s read-only `Markdown` (no task
 *   checkbox toggling), and word wrap is fixed off rather than read from
 *   t3's client settings.
 */

import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import { RegistryContext } from '@effect/atom-react/RegistryContext'
import { Markdown } from '@laborer/ui/components/markdown'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
import { Toggle } from '@laborer/ui/components/toggle'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import type { SelectedLineRange } from '@pierre/diffs'
import { VirtualizedFile } from '@pierre/diffs'
import { Editor, type EditorOptions } from '@pierre/diffs/edit'
import type { CreateEditor, FileOptions } from '@pierre/diffs/react'
import { EditProvider, File, Virtualizer } from '@pierre/diffs/react'
import { Effect } from 'effect'
import { Atom, AsyncResult as Result } from 'effect/unstable/reactivity'
import {
  ChevronRight,
  Code2,
  Eye,
  FolderTree,
  Globe2,
  LoaderCircle,
  SquareArrowOutUpRight,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { FileBrowserPanel } from '@/components/files/file-browser-panel'
import {
  fileCacheKey,
  fileEditorCacheKey,
} from '@/components/files/file-content-revision'
import { installFileEditorDismissal } from '@/components/files/file-editor-dismissal'
import { resolveCenteredFileLineScrollTop } from '@/components/files/file-line-reveal'
import { fileBreadcrumbs } from '@/components/files/file-path'
import { isMarkdownPreviewFile } from '@/components/files/file-preview-mode'
import {
  FileSaveCoordinator,
  type FileSaveOutcome,
} from '@/components/files/file-save-coordinator'
import {
  confirmFileQueryData,
  setFileQueryData,
  useFileTextQuery,
} from '@/components/files/project-files-query-state'
import { DIFF_SURFACE_THEME_UNSAFE_CSS } from '@/lib/diff-rendering'
import { extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'

interface FilePreviewPanelProps {
  onOpenFile: (relativePath: string) => void
  onPendingChange: (relativePath: string, pending: boolean) => void
  projectName: string
  relativePath: string | null
  revealLine: number | null
  revealRequestId: number
  workspaceId: string
}

const FILE_EXPLORER_STORAGE_KEY = 'laborer.fileExplorerOpen'
const RENDER_MARKDOWN_STORAGE_KEY = 'laborer.renderMarkdown'
const FILE_SAVE_DEBOUNCE_MS = 500
const FILE_LINK_REVEAL_ATTRIBUTE = 'data-file-link-reveal'
const FILE_LINK_REVEAL_UNSAFE_CSS = `
  ${DIFF_SURFACE_THEME_UNSAFE_CSS}

  diffs-container {
    --diffs-bg: var(--code-background, var(--background)) !important;
    --diffs-light-bg: var(--code-background, var(--background)) !important;
    --diffs-dark-bg: var(--code-background, var(--background)) !important;
    background-color: var(--code-background, var(--background)) !important;
    color: var(--code-foreground, var(--foreground)) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`
type FilePostRender = NonNullable<FileOptions<unknown>['onPostRender']>

/** Word wrap is fixed off; t3 read this from its client settings. */
const WORD_WRAP = false

/** Extensions the image preview serves, matching the server's list. */
const IMAGE_PREVIEW_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'webp',
  'ico',
  'tiff',
  'tif',
  'svg',
  'avif',
  'heic',
  'heif',
  'jxl',
])

export function isWorkspaceImagePreviewPath(path: string): boolean {
  const dotIndex = path.lastIndexOf('.')
  if (dotIndex === -1) {
    return false
  }
  return IMAGE_PREVIEW_EXTENSIONS.has(path.slice(dotIndex + 1).toLowerCase())
}

const BROWSER_PREVIEW_FILE_EXTENSION = /\.(?:html?|pdf)$/i
const FILE_QUERY_OR_HASH = /[?#]/
const isBrowserPreviewFile = (path: string): boolean =>
  BROWSER_PREVIEW_FILE_EXTENSION.test(
    path.split(FILE_QUERY_OR_HASH, 1)[0] ?? ''
  )

/** Mutation atoms shared across all panel instances. */
const fileWriteMutation = LaborerClient.mutation('file.write')
const editorOpenMutation = LaborerClient.mutation('editor.open')

/** Per-file query for image previews: `file.read` serves base64 + MIME. */
const imagePreviewQueryAtom = Atom.family((key: string) => {
  const separator = key.indexOf('\n')
  const workspaceId = key.slice(0, separator)
  const filePath = key.slice(separator + 1)
  return LaborerClient.runtime.atom(
    Effect.flatMap(LaborerClient, (client) =>
      client('file.read', { workspaceId, filePath })
    )
  )
})

function WorkspaceImagePreview(props: {
  readonly workspaceId: string
  readonly relativePath: string
  readonly alt: string
}) {
  const result = useAtomValue(
    imagePreviewQueryAtom(`${props.workspaceId}\n${props.relativePath}`)
  )

  if (Result.isFailure(result)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-destructive text-xs leading-relaxed">
        Unable to load workspace image.
      </div>
    )
  }
  if (!Result.isSuccess(result)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    )
  }
  const file = result.value
  if (file.encoding !== 'base64' || file.content.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-destructive text-xs leading-relaxed">
        Unable to load workspace image.
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      {/* biome-ignore lint/correctness/useImageSize: the preview's natural size is unknown until the workspace image loads; object-contain bounds it. */}
      <img
        alt={props.alt}
        className="max-h-full max-w-full object-contain"
        src={`data:${file.mimeType ?? 'image/png'};base64,${file.content}`}
      />
    </div>
  )
}

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index)
    if (character === 10) {
      lineCount += 1
    } else if (character === 13) {
      lineCount += 1
      if (contents.charCodeAt(index + 1) === 10) {
        index += 1
      }
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount)
}

function updateFileLinkReveal(
  fileContainer: HTMLElement,
  line: number | null
): void {
  const root = fileContainer.shadowRoot ?? fileContainer
  for (const element of root.querySelectorAll<HTMLElement>(
    `[${FILE_LINK_REVEAL_ATTRIBUTE}]`
  )) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE)
  }
  if (line === null) {
    return
  }

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, '')
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, '')
}

/**
 * Frames to keep retrying while the file contents or line metrics are not
 * available yet (fresh mounts hydrate asynchronously).
 */
const REVEAL_MAX_ATTEMPTS = 30
/**
 * After scrolling to the target, hold it for a short window so late
 * programmatic scroll resets (editable-editor focus and state restoration)
 * cannot silently snap the file back to the top. Real user input cancels the
 * guard immediately.
 */
const REVEAL_GUARD_FRAMES = 20
const REVEAL_GUARD_TOLERANCE_PX = 2

interface FileRevealState {
  cancelGuard: (() => void) | null
  frameId: number | null
  handledRequestId: number | null
  latestRequestId: number | null
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number
): FilePostRender {
  const [revealStatesByPath] = useState(
    () => new Map<string, FileRevealState>()
  )

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (relativePath === null) {
        return
      }

      const existingState = revealStatesByPath.get(relativePath)
      const state: FileRevealState = existingState ?? {
        frameId: null,
        cancelGuard: null,
        handledRequestId: null,
        latestRequestId: null,
      }
      if (!existingState) {
        revealStatesByPath.set(relativePath, state)
      }

      const cancelPendingReveal = () => {
        if (state.frameId !== null) {
          cancelAnimationFrame(state.frameId)
          state.frameId = null
        }
        state.cancelGuard?.()
      }

      if (phase === 'unmount') {
        cancelPendingReveal()
        return
      }

      const contents = instance.file?.contents
      const targetLine =
        revealLine === null || contents === undefined
          ? null
          : clampFileLine(contents, revealLine)
      updateFileLinkReveal(fileContainer, targetLine)

      if (!(instance instanceof VirtualizedFile)) {
        return
      }

      if (state.latestRequestId !== revealRequestId) {
        cancelPendingReveal()
        state.latestRequestId = revealRequestId
        state.handledRequestId = null
      }

      if (revealLine === null) {
        fileContainer.style.minHeight = ''
        return
      }

      const scrollContainer = fileContainer.closest<HTMLElement>(
        '.file-preview-virtualizer'
      )
      if (!scrollContainer) {
        return
      }
      fileContainer.style.minHeight = `${Math.ceil(
        Math.max(instance.height, scrollContainer.clientHeight)
      )}px`

      if (
        state.handledRequestId === revealRequestId ||
        state.frameId !== null
      ) {
        return
      }

      const resolveScrollTarget = (line: number): number | null => {
        const linePosition = instance.getLinePosition(line)
        if (!linePosition) {
          return null
        }

        const scrollContainerRect = scrollContainer.getBoundingClientRect()
        const fileTop =
          scrollContainer.scrollTop +
          fileContainer.getBoundingClientRect().top -
          scrollContainerRect.top
        const root = fileContainer.shadowRoot ?? fileContainer
        const renderedLineElement = root.querySelector<HTMLElement>(
          `[data-line="${line}"]`
        )
        const renderedLineRect = renderedLineElement?.getBoundingClientRect()

        return resolveCenteredFileLineScrollTop({
          scrollTop: scrollContainer.scrollTop,
          scrollHeight: scrollContainer.scrollHeight,
          viewportTop: scrollContainerRect.top,
          viewportHeight: scrollContainer.clientHeight,
          fileTop,
          estimatedLine: linePosition,
          ...(renderedLineRect && renderedLineRect.height > 0
            ? {
                renderedLine: {
                  top: renderedLineRect.top,
                  height: renderedLineRect.height,
                },
              }
            : {}),
        })
      }

      const guardScrollTarget = (line: number) => {
        let framesLeft = REVEAL_GUARD_FRAMES
        let guardFrameId: number | null = null
        const cancelGuard = () => {
          if (guardFrameId !== null) {
            cancelAnimationFrame(guardFrameId)
            guardFrameId = null
          }
          scrollContainer.removeEventListener('wheel', cancelGuard)
          scrollContainer.removeEventListener('touchstart', cancelGuard)
          scrollContainer.removeEventListener('pointerdown', cancelGuard, true)
          window.removeEventListener('keydown', cancelGuard, true)
          if (state.cancelGuard === cancelGuard) {
            state.cancelGuard = null
          }
        }
        scrollContainer.addEventListener('wheel', cancelGuard, {
          passive: true,
        })
        scrollContainer.addEventListener('touchstart', cancelGuard, {
          passive: true,
        })
        // Pierre stops gutter pointer events from bubbling. Listen in capture
        // so starting a selection cancels the reveal guard before the row
        // expands.
        scrollContainer.addEventListener('pointerdown', cancelGuard, {
          passive: true,
          capture: true,
        })
        window.addEventListener('keydown', cancelGuard, true)
        const holdTarget = () => {
          guardFrameId = null
          framesLeft -= 1
          if (framesLeft <= 0 || !scrollContainer.isConnected) {
            cancelGuard()
            return
          }
          const targetTop = resolveScrollTarget(line)
          if (
            targetTop !== null &&
            Math.abs(scrollContainer.scrollTop - targetTop) >
              REVEAL_GUARD_TOLERANCE_PX
          ) {
            scrollContainer.scrollTop = targetTop
          }
          guardFrameId = requestAnimationFrame(holdTarget)
        }
        guardFrameId = requestAnimationFrame(holdTarget)
        state.cancelGuard = cancelGuard
      }

      const scheduleReveal = (attempt: number) => {
        state.frameId = requestAnimationFrame(() => {
          state.frameId = null
          if (
            state.latestRequestId !== revealRequestId ||
            !fileContainer.isConnected
          ) {
            return
          }

          // Contents and line metrics can lag the first post-render on fresh
          // mounts; clamping against missing contents would scroll to line 1
          // and wrongly mark the request handled.
          const currentContents = instance.file?.contents
          const line =
            currentContents === undefined
              ? null
              : clampFileLine(currentContents, revealLine)
          const targetTop = line === null ? null : resolveScrollTarget(line)
          if (line === null || targetTop === null) {
            if (attempt < REVEAL_MAX_ATTEMPTS) {
              scheduleReveal(attempt + 1)
            }
            return
          }
          updateFileLinkReveal(fileContainer, line)

          scrollContainer.scrollTop = targetTop
          state.handledRequestId = revealRequestId
          guardScrollTarget(line)
        })
      }

      scheduleReveal(0)
    },
    [revealStatesByPath, relativePath, revealLine, revealRequestId]
  )
}

interface EditableFileSurfaceProps {
  contents: string
  onPendingChange: (relativePath: string, pending: boolean) => void
  onPostRender: FilePostRender
  relativePath: string
  resolvedTheme: 'light' | 'dark'
  revealRequestId: number
  workspaceId: string
}

interface FileSelectionOverride {
  range: SelectedLineRange | null
  revealRequestId: number
}

function useFileSaveCoordinator({
  workspaceId,
  relativePath,
  onPendingChange,
}: Pick<
  EditableFileSurfaceProps,
  'workspaceId' | 'relativePath' | 'onPendingChange'
>): FileSaveCoordinator {
  const registry = useContext(RegistryContext)
  const writeFile = useAtomSet(fileWriteMutation, { mode: 'promise' })
  const coordinator = useMemo(
    () =>
      new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        onPendingChange: (pending) => onPendingChange(relativePath, pending),
        persist: async (nextContents): Promise<FileSaveOutcome> => {
          try {
            await writeFile({
              payload: {
                workspaceId,
                filePath: relativePath,
                contents: nextContents,
              },
            })
            return { _tag: 'Success' }
          } catch {
            return { _tag: 'Failure' }
          }
        },
        onConfirmed: (confirmedContents) => {
          confirmFileQueryData(
            registry,
            workspaceId,
            relativePath,
            confirmedContents
          )
        },
      }),
    [onPendingChange, registry, relativePath, workspaceId, writeFile]
  )

  useEffect(() => () => coordinator.dispose(), [coordinator])
  return coordinator
}

function EditableFileSurface({
  workspaceId,
  relativePath,
  contents,
  resolvedTheme,
  revealRequestId,
  onPostRender,
  onPendingChange,
}: EditableFileSurfaceProps) {
  const registry = useContext(RegistryContext)
  const [selectionOverride, setSelectionOverride] =
    useState<FileSelectionOverride | null>(null)
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId
      ? selectionOverride.range
      : null
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionOverride({ revealRequestId, range })
    },
    [revealRequestId]
  )
  const surfaceRef = useRef<HTMLDivElement>(null)
  const selectionFrameRef = useRef<number | null>(null)
  const saveCoordinator = useFileSaveCoordinator({
    workspaceId,
    relativePath,
    onPendingChange,
  })

  // The installed @pierre/diffs owns the editor lifecycle: `File` asks the
  // EditProvider factory to create one and cleans it up itself (t3's newer
  // version let the panel own the instance). The panel keeps a ref via
  // onAttach for the dismissal handler and the editor cache key, and routes
  // onChange through refs so the creation-time options never go stale.
  const editorRef = useRef<Editor<unknown> | null>(null)
  const handleChangeRef = useRef<(nextContents: string) => void>(() => {
    // Replaced on every render below; the initial value is never invoked.
  })
  handleChangeRef.current = (nextContents) => {
    setFileQueryData(registry, workspaceId, relativePath, nextContents)
    saveCoordinator.change(nextContents)
  }
  const createEditor = useCallback<CreateEditor<unknown>>(
    (options) => new Editor<unknown>(options),
    []
  )
  const editorOptions = useMemo<EditorOptions<unknown>>(
    () => ({
      persistState: true,
      persistStateStorage: 'inMemory',
      onAttach: (editor) => {
        editorRef.current = editor as Editor<unknown>
      },
      onChange: (file) => {
        handleChangeRef.current(file.contents)
      },
    }),
    []
  )

  useEffect(() => {
    const root = surfaceRef.current
    if (!root) {
      return
    }
    return installFileEditorDismissal({
      root,
      editor: {
        setSelections: (selections) =>
          editorRef.current?.setSelections(selections),
      },
      isBlocked: () => false,
      onDismiss: () => setSelectedRange(null),
    })
  }, [setSelectedRange])

  const handlePostRender = useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      onPostRender(fileContainer, instance, phase)

      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current)
        selectionFrameRef.current = null
      }
      if (phase === 'unmount') {
        return
      }

      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = null
        if (!fileContainer.isConnected) {
          return
        }
        instance.setSelectedLines(selectedRange, { notify: false })
      })
    },
    [onPostRender, selectedRange]
  )

  return (
    <EditProvider createEditor={createEditor}>
      <div className="flex min-h-0 flex-1" ref={surfaceRef}>
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          <File
            className="min-h-full"
            edit
            editorOptions={editorOptions}
            file={{
              name: relativePath,
              contents,
              cacheKey: fileEditorCacheKey(
                workspaceId,
                relativePath,
                contents,
                editorRef.current?.getFile()
              ),
            }}
            options={{
              disableFileHeader: true,
              enableLineSelection: true,
              onLineSelectionEnd: setSelectedRange,
              overflow: WORD_WRAP ? 'wrap' : 'scroll',
              theme: resolvedTheme === 'light' ? 'pierre-light' : 'pierre-dark',
              themeType: resolvedTheme,
              unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
              onPostRender: handlePostRender,
            }}
            selectedLines={selectedRange}
          />
        </Virtualizer>
      </div>
    </EditProvider>
  )
}

function initialExplorerOpen(): boolean {
  try {
    const raw = window.localStorage.getItem(FILE_EXPLORER_STORAGE_KEY)
    return raw === null ? true : JSON.parse(raw) === true
  } catch {
    return true
  }
}

function initialRenderMarkdown(): boolean {
  try {
    return (
      JSON.parse(
        window.localStorage.getItem(RENDER_MARKDOWN_STORAGE_KEY) ?? 'false'
      ) === true
    )
  } catch {
    return false
  }
}

export function FilePreviewPanel({
  workspaceId,
  projectName,
  relativePath,
  revealLine,
  revealRequestId,
  onOpenFile,
  onPendingChange,
}: FilePreviewPanelProps) {
  const { resolvedTheme: themeName } = useTheme()
  const resolvedTheme =
    themeName === 'light' ? ('light' as const) : ('dark' as const)
  const openEditor = useAtomSet(editorOpenMutation, { mode: 'promise' })
  const isImage =
    relativePath !== null && isWorkspaceImagePreviewPath(relativePath)
  const file = useFileTextQuery(workspaceId, relativePath, !isImage)
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen)
  // Reading markdown rendered is a preference, not a property of one file.
  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useState(
    initialRenderMarkdown
  )
  // Paired with the path on purpose: each file surface counts its reveals
  // from one, so a bare id would let a dismissed reveal on one file swallow
  // the first reveal on the next.
  const [handledReveal, setHandledReveal] = useState<{
    path: string
    requestId: number
  } | null>(null)
  const breadcrumbRef = useRef<HTMLDivElement>(null)
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false
  // A reveal still wins over the preference: the line only exists in source.
  const renderMarkdown =
    isMarkdown &&
    renderMarkdownPreferred &&
    (revealLine === null ||
      (handledReveal?.path === relativePath &&
        handledReveal.requestId === revealRequestId))
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath]
  )
  const onFilePostRender = useFileLineReveal(
    relativePath,
    revealLine,
    revealRequestId
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll the crumb strip whenever the open file changes; the DOM query cannot be a dependency.
  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']"
    )
    // jsdom does not implement scrollIntoView; guard for tests.
    if (typeof currentCrumb?.scrollIntoView === 'function') {
      currentCrumb.scrollIntoView({ block: 'nearest', inline: 'end' })
    }
  }, [relativePath])

  const toggleExplorer = () => {
    setExplorerOpen((current) => {
      const next = !current
      try {
        window.localStorage.setItem(
          FILE_EXPLORER_STORAGE_KEY,
          JSON.stringify(next)
        )
      } catch {
        // Persistence is best-effort.
      }
      return next
    })
  }

  const handleOpenInEditor = useCallback(() => {
    if (relativePath === null) {
      return
    }
    openEditor({ payload: { workspaceId, filePath: relativePath } }).catch(
      (error: unknown) =>
        toast.error(`Failed to open file: ${extractErrorMessage(error)}`)
    )
  }, [openEditor, relativePath, workspaceId])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath ? (
        <div
          className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-border/60 border-b bg-background px-3"
          data-surface-subheader
        >
          <ScrollArea
            className="min-w-0 flex-1 rounded-none"
            data-file-breadcrumbs
            ref={breadcrumbRef}
            scrollFade
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              {breadcrumbs.map((crumb, index) => (
                <div
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === 'file'}
                  key={crumb.path || 'project'}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            'max-w-40 truncate',
                            crumb.kind === 'file'
                              ? 'font-medium text-foreground'
                              : 'text-muted-foreground'
                          )}
                        >
                          {crumb.label}
                        </span>
                      }
                    />
                    <TooltipContent className="max-w-80" side="top">
                      {crumb.path || projectName}
                    </TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          </ScrollArea>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label="Open file in editor"
                  className="shrink-0"
                  onPressedChange={handleOpenInEditor}
                  pressed={false}
                  size="sm"
                >
                  <SquareArrowOutUpRight className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipContent>Open file in editor</TooltipContent>
          </Tooltip>
          {isBrowserPreviewFile(relativePath) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    aria-label="Open file in browser preview"
                    className="shrink-0"
                    disabled
                    pressed={false}
                    size="sm"
                  >
                    <Globe2 className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipContent>
                Browser file preview needs a workspace asset URL from the
                daemon.
              </TooltipContent>
            </Tooltip>
          ) : null}
          {isMarkdown ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    aria-label={
                      renderMarkdown
                        ? 'Show markdown source'
                        : 'Show rendered markdown'
                    }
                    className="shrink-0"
                    onPressedChange={(pressed) => {
                      setRenderMarkdownPreferred(Boolean(pressed))
                      try {
                        window.localStorage.setItem(
                          RENDER_MARKDOWN_STORAGE_KEY,
                          JSON.stringify(Boolean(pressed))
                        )
                      } catch {
                        // Persistence is best-effort.
                      }
                      setHandledReveal(
                        pressed && relativePath !== null
                          ? { path: relativePath, requestId: revealRequestId }
                          : null
                      )
                    }}
                    pressed={renderMarkdown}
                    size="sm"
                  >
                    {renderMarkdown ? (
                      <Code2 className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </Toggle>
                }
              />
              <TooltipContent>
                {renderMarkdown
                  ? 'Show markdown source'
                  : 'Show rendered markdown'}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={
                    explorerOpen ? 'Hide file explorer' : 'Show file explorer'
                  }
                  className="shrink-0"
                  onPressedChange={toggleExplorer}
                  pressed={explorerOpen}
                  size="sm"
                >
                  <FolderTree className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipContent>
              {explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {relativePath && file.data?.truncated ? (
        <div className="shrink-0 border-warning/20 border-b bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          Preview limited to the first 1 MB of a{' '}
          {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            'min-w-0 flex-1 flex-col overflow-hidden',
            relativePath ? 'flex' : 'hidden'
          )}
        >
          {relativePath && isImage ? (
            <WorkspaceImagePreview
              alt={relativePath}
              key={relativePath}
              relativePath={relativePath}
              workspaceId={workspaceId}
            />
          ) : relativePath && file.error && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-destructive text-xs leading-relaxed">
              {file.error}
            </div>
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : relativePath && file.data ? (
            isMarkdown && renderMarkdown ? (
              <ScrollArea className="min-h-0 flex-1">
                <Markdown className="mx-auto max-w-4xl px-6 py-5">
                  {file.data.contents}
                </Markdown>
              </ScrollArea>
            ) : file.data.truncated ? (
              <Virtualizer
                className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
                key={`${relativePath}:${resolvedTheme}:${file.data.byteLength}`}
              >
                <File
                  className="min-h-full"
                  file={{
                    name: relativePath,
                    contents: file.data.contents,
                    cacheKey: fileCacheKey(
                      workspaceId,
                      relativePath,
                      file.data.contents
                    ),
                  }}
                  options={{
                    disableFileHeader: true,
                    overflow: WORD_WRAP ? 'wrap' : 'scroll',
                    theme:
                      resolvedTheme === 'light'
                        ? 'pierre-light'
                        : 'pierre-dark',
                    themeType: resolvedTheme,
                    unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
                    onPostRender: onFilePostRender,
                  }}
                />
              </Virtualizer>
            ) : (
              <EditableFileSurface
                contents={file.data.contents}
                key={`${relativePath}:${resolvedTheme}`}
                onPendingChange={onPendingChange}
                onPostRender={onFilePostRender}
                relativePath={relativePath}
                resolvedTheme={resolvedTheme}
                revealRequestId={revealRequestId}
                workspaceId={workspaceId}
              />
            )
          ) : null}
        </div>
        {explorerOpen || relativePath === null ? (
          <aside
            className={cn(
              'flex min-h-0 shrink-0 bg-background',
              relativePath
                ? 'w-[min(22rem,46%)] min-w-64 border-border/60 border-l'
                : 'min-w-0 flex-1'
            )}
          >
            <FileBrowserPanel
              key={workspaceId}
              onOpenFile={onOpenFile}
              projectName={projectName}
              selectedPath={relativePath}
              selectedPathRevealId={revealRequestId}
              workspaceId={workspaceId}
              {...(relativePath && !isImage
                ? { onRefreshSelectedFile: file.refresh }
                : {})}
            />
          </aside>
        ) : null}
      </div>
    </div>
  )
}
