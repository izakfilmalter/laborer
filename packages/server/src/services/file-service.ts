/**
 * FileService — Lazy, on-demand file operations
 *
 * Provides stateless request/response operations for file listing,
 * reading, and status. Replaces the streaming FileTreeService and
 * polling-based DiffService with lazy, per-request operations.
 *
 * Currently implements:
 * - `list(workspaceId, dir?)` — single directory level listing
 * - `read(workspaceId, filePath)` — file content + per-file diff
 * - `watcherSubscribe(workspaceId)` — per-workspace file watcher event stream
 *
 * Future additions (Issue 4):
 * - `status(workspaceId)` — workspace-level changed file summary
 *
 * @see PRD: Lazy File Service
 * @see Issue 1: file.list — Lazy per-directory listing (tracer bullet)
 * @see Issue 3: file.read — On-demand file content with per-file diff
 * @see Issue 5: file.watcher.subscribe — Per-workspace watcher event stream
 */

import { readdir, readFile } from 'node:fs/promises'
import { extname, join, normalize, relative, resolve } from 'node:path'
import type {
  FileContent,
  FileNode,
  FileWatcherEvent,
  WatchFileEvent,
} from '@laborer/shared/rpc'
import { RpcError } from '@laborer/shared/rpc'
import { tables } from '@laborer/shared/schema'
import { formatPatch, structuredPatch } from 'diff'
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Order,
  pipe,
  Stream,
} from 'effect'
import { spawnGit } from '../lib/spawn-git.js'
import { FileWatcherClient } from './file-watcher-client.js'
import { LaborerStore } from './laborer-store.js'

// ── Directory ignore rules ──────────────────────────────────────
// Directories that are skipped entirely during listing. These are
// the same noisy directories the file watcher ignores.

const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.yarn',
  '.pnpm-store',
  '.idea',
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.pytest_cache',
  '.cache',
  '.history',
  '.gradle',
  'target',
  'bin',
  'obj',
])

/** Individual file names to skip (OS metadata files that are noise). */
const IGNORED_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db'])

// ── Binary and image detection ──────────────────────────────────
// Extension-based detection for binary and image files. Modeled on
// OpenCode's File.read() approach.

/** Extensions that are known binary formats (non-text, non-image). */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'o',
  'a',
  'lib',
  'zip',
  'gz',
  'tar',
  'bz2',
  'xz',
  '7z',
  'rar',
  'zst',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'wasm',
  'pyc',
  'pyo',
  'class',
  'sqlite',
  'db',
  'sqlite3',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  'mp3',
  'mp4',
  'avi',
  'mov',
  'mkv',
  'flv',
  'wmv',
  'wav',
  'flac',
  'ogg',
  'dmg',
  'iso',
  'img',
  'jar',
  'war',
  'ear',
  'deb',
  'rpm',
  'msi',
  'lock',
])

/** Extensions that are image formats. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
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

/** MIME types for image extensions. */
const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  jxl: 'image/jxl',
}

/** Get the lowercase extension without the dot. */
const getExt = (filePath: string): string =>
  extname(filePath).toLowerCase().slice(1)

/** Check if a file is a known image by extension. */
const isImageByExtension = (filePath: string): boolean =>
  IMAGE_EXTENSIONS.has(getExt(filePath))

/** Check if a file is a known binary by extension (non-image). */
const isBinaryByExtension = (filePath: string): boolean =>
  BINARY_EXTENSIONS.has(getExt(filePath))

/** Get the MIME type for an image file. */
const getImageMimeType = (filePath: string): string => {
  const ext = getExt(filePath)
  return IMAGE_MIME_TYPES[ext] ?? `image/${ext}`
}

/**
 * Sort order for FileNode: directories first, then alphabetical by name.
 */
const fileNodeOrder: Order.Order<FileNode> = Order.make((a, b) => {
  if (a.type !== b.type) {
    return a.type === 'directory' ? -1 : 1
  }
  const cmp = a.name.localeCompare(b.name)
  if (cmp < 0) {
    return -1
  }
  if (cmp > 0) {
    return 1
  }
  return 0
})

/**
 * Look up a workspace by ID and validate it is usable.
 * Returns the workspace record or fails with an RpcError.
 */
const lookupWorkspace = (
  store: LaborerStore['Type']['store'],
  workspaceId: string
) =>
  Effect.gen(function* () {
    const workspaceOpt = pipe(
      store.query(tables.workspaces),
      Arr.findFirst((w) => w.id === workspaceId)
    )

    if (workspaceOpt._tag === 'None') {
      return yield* new RpcError({
        message: `Workspace not found: ${workspaceId}`,
        code: 'NOT_FOUND',
      })
    }

    const workspace = workspaceOpt.value

    if (workspace.status === 'destroyed') {
      return yield* new RpcError({
        message: `Workspace ${workspaceId} has been destroyed`,
        code: 'INVALID_STATE',
      })
    }

    return workspace
  })

/**
 * Validate that a resolved path does not escape the worktree root.
 */
const validatePathContainment = (
  targetDir: string,
  worktreeRoot: string,
  dir: string | undefined
) =>
  Effect.gen(function* () {
    const normalizedTarget = normalize(targetDir)
    const normalizedRoot = normalize(worktreeRoot)
    if (
      !normalizedTarget.startsWith(`${normalizedRoot}/`) &&
      normalizedTarget !== normalizedRoot
    ) {
      return yield* new RpcError({
        message: `Path escapes worktree root: ${dir}`,
        code: 'PATH_TRAVERSAL',
      })
    }
  })

/**
 * Read directory entries and build FileNode array, filtering ignored entries.
 */
const readAndBuildNodes = (targetDir: string, worktreeRoot: string) =>
  Effect.gen(function* () {
    const rawEntries = yield* Effect.tryPromise({
      try: () => readdir(targetDir, { withFileTypes: true }),
      catch: (error) =>
        new RpcError({
          message: `Failed to read directory: ${String(error)}`,
          code: 'READDIR_FAILED',
        }),
    })

    const nodes: FileNode[] = []

    for (const entry of rawEntries) {
      const name = String(entry.name)

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(name)) {
          continue
        }
        const absolute = join(targetDir, name)
        nodes.push({
          name,
          path: relative(worktreeRoot, absolute),
          absolute,
          type: 'directory',
          ignored: false, // Issue 2 adds gitignore marking
        })
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (IGNORED_FILES.has(name)) {
          continue
        }
        const absolute = join(targetDir, name)
        nodes.push({
          name,
          path: relative(worktreeRoot, absolute),
          absolute,
          type: 'file',
          ignored: false, // Issue 2 adds gitignore marking
        })
      }
    }

    return pipe(nodes, Arr.sort(fileNodeOrder))
  })

// ── Event type mapping ──────────────────────────────────────────
// Maps internal watcher event types to client-facing types.
// The file-watcher sidecar uses "delete" but the client API uses "unlink".

const mapEventType = (
  type: 'add' | 'change' | 'delete'
): FileWatcherEvent['event'] => {
  if (type === 'delete') {
    return 'unlink'
  }
  return type
}

// ── Per-file diff computation ───────────────────────────────────
// Computes the diff of a text file against HEAD. Tries unstaged diff
// first, then falls back to staged diff. Uses the `diff` npm library
// for structured patch output.

/**
 * Compute per-file diff for a text file against HEAD.
 *
 * Runs `git diff -- <file>`, falling back to `git diff --staged -- <file>`.
 * When a diff exists, retrieves the original content from HEAD and computes
 * a structured patch via `structuredPatch()` with `context: Infinity`.
 *
 * If git is not available or the repo has no commits, returns content without diff.
 */
const computeFileDiff = (
  worktreeRoot: string,
  filePath: string,
  content: string
): Effect.Effect<FileContent, RpcError> =>
  Effect.tryPromise({
    try: async (): Promise<FileContent> => {
      // Try unstaged diff first
      let gitDiffResult = await spawnGit(
        ['-c', 'core.fsmonitor=false', 'diff', '--', filePath],
        { cwd: worktreeRoot, readOnly: true }
      )

      let diff = gitDiffResult.stdout.trim()

      // Fall back to staged diff
      if (!diff) {
        gitDiffResult = await spawnGit(
          ['-c', 'core.fsmonitor=false', 'diff', '--staged', '--', filePath],
          { cwd: worktreeRoot, readOnly: true }
        )
        diff = gitDiffResult.stdout.trim()
      }

      // If there is a diff, compute the structured patch
      if (diff) {
        // Get original content from HEAD
        const showResult = await spawnGit(['show', `HEAD:${filePath}`], {
          cwd: worktreeRoot,
          readOnly: true,
        })
        const original = showResult.exitCode === 0 ? showResult.stdout : ''

        const patch = structuredPatch(
          filePath,
          filePath,
          original,
          content,
          'old',
          'new',
          { context: Number.POSITIVE_INFINITY }
        )

        return {
          type: 'text',
          content,
          patch: {
            oldFileName: patch.oldFileName ?? filePath,
            newFileName: patch.newFileName ?? filePath,
            oldHeader: patch.oldHeader,
            newHeader: patch.newHeader,
            hunks: patch.hunks,
            index: patch.index,
          },
          diff: formatPatch(patch),
        }
      }

      return { type: 'text', content }
    },
    catch: () =>
      // Git not available or not a git repo — return content without diff
      new RpcError({
        message: 'Git diff computation failed',
        code: 'GIT_DIFF_FAILED',
      }),
  }).pipe(
    // If git is unavailable, return content without diff instead of failing
    Effect.catchAll(() => Effect.succeed({ type: 'text' as const, content }))
  )

class FileService extends Context.Tag('@laborer/FileService')<
  FileService,
  {
    /**
     * List a single directory level from a workspace's worktree.
     *
     * Returns `FileNode[]` sorted directories-first, then alphabetically.
     * Noisy directories and OS metadata files are skipped. When `dir` is
     * omitted, lists the worktree root.
     *
     * @param workspaceId - ID of the workspace
     * @param dir - Optional subdirectory relative to the worktree root
     */
    readonly list: (
      workspaceId: string,
      dir?: string
    ) => Effect.Effect<readonly FileNode[], RpcError>

    /**
     * Read a single file's content and compute its diff against HEAD.
     *
     * Returns `FileContent` with the file text (or base64 for images),
     * plus optional diff and structured patch if the file has changes.
     * Binary files are detected by extension and returned with
     * `type: "binary"` and empty content.
     *
     * @param workspaceId - ID of the workspace
     * @param filePath - Path of the file relative to the worktree root
     */
    readonly read: (
      workspaceId: string,
      filePath: string
    ) => Effect.Effect<FileContent, RpcError>

    /**
     * Subscribe to file change events for a workspace's worktree.
     *
     * Returns a `Stream` of `FileWatcherEvent` objects with file paths
     * relative to the worktree root. Events are forwarded from the
     * file-watcher sidecar, filtered to this workspace's subscription.
     *
     * On stream teardown (client disconnect), the file watcher
     * subscription is automatically cleaned up.
     *
     * @param workspaceId - ID of the workspace
     */
    readonly watcherSubscribe: (
      workspaceId: string
    ) => Stream.Stream<FileWatcherEvent, RpcError>
  }
>() {
  static readonly layer = Layer.scoped(
    FileService,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const fileWatcherClient = yield* FileWatcherClient

      const list = (
        workspaceId: string,
        dir?: string
      ): Effect.Effect<readonly FileNode[], RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(store, workspaceId)
          const worktreeRoot = workspace.worktreePath

          const targetDir =
            dir !== undefined ? resolve(worktreeRoot, dir) : worktreeRoot

          yield* validatePathContainment(targetDir, worktreeRoot, dir)

          return yield* readAndBuildNodes(targetDir, worktreeRoot)
        })

      const read = (
        workspaceId: string,
        filePath: string
      ): Effect.Effect<FileContent, RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(store, workspaceId)
          const worktreeRoot = workspace.worktreePath
          const fullPath = resolve(worktreeRoot, filePath)

          // Validate path containment
          yield* validatePathContainment(fullPath, worktreeRoot, filePath)

          // Image files — base64 encode with MIME type
          if (isImageByExtension(filePath)) {
            const imageResult: string | null = yield* Effect.tryPromise({
              try: async () => {
                const buffer = await readFile(fullPath)
                return buffer.toString('base64')
              },
              catch: () =>
                new RpcError({
                  message: 'File not found',
                  code: 'NOT_FOUND',
                }),
            }).pipe(Effect.catchAll(() => Effect.succeed(null)))

            if (imageResult === null) {
              return { type: 'text' as const, content: '' }
            }

            return {
              type: 'text' as const,
              content: imageResult,
              encoding: 'base64' as const,
              mimeType: getImageMimeType(filePath),
            }
          }

          // Binary files — flag without reading content
          if (isBinaryByExtension(filePath)) {
            return { type: 'binary' as const, content: '' }
          }

          // Text files — read content
          const fileContent: string | null = yield* Effect.tryPromise({
            try: () => readFile(fullPath, 'utf-8'),
            catch: () =>
              new RpcError({
                message: 'File not found',
                code: 'NOT_FOUND',
              }),
          }).pipe(Effect.catchAll(() => Effect.succeed(null)))

          if (fileContent === null) {
            return { type: 'text' as const, content: '' }
          }

          const content = fileContent.trimEnd()

          // Compute per-file diff against HEAD
          return yield* computeFileDiff(worktreeRoot, filePath, content)
        })

      const watcherSubscribe = (
        workspaceId: string
      ): Stream.Stream<FileWatcherEvent, RpcError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const workspace = yield* lookupWorkspace(store, workspaceId)
            const worktreePath = workspace.worktreePath

            // Subscribe a recursive file watcher on the worktree
            const watchSubscription = yield* fileWatcherClient
              .subscribe(worktreePath, { recursive: true })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RpcError({
                      message: `Failed to subscribe file watcher: ${String(error.message)}`,
                      code: 'WATCHER_SUBSCRIBE_FAILED',
                    })
                )
              )

            yield* Effect.logDebug(
              '[FileService.watcherSubscribe] watcher subscribed, creating stream'
            )
            // Build a push-based stream that forwards filtered watcher
            // events. Uses acquireRelease so the event handler and watcher
            // subscription are properly cleaned up on stream teardown.
            return Stream.asyncPush<FileWatcherEvent, RpcError>((emit) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  // Register event handler filtered to this subscription
                  return fileWatcherClient.onFileEvent(
                    (watchEvent: WatchFileEvent) => {
                      if (watchEvent.subscriptionId !== watchSubscription.id) {
                        return
                      }

                      // Compute relative path from the worktree root
                      const relativePath =
                        watchEvent.fileName ??
                        relative(worktreePath, watchEvent.absolutePath)

                      emit.single({
                        file: relativePath,
                        event: mapEventType(watchEvent.type),
                      })
                    }
                  )
                }),
                (eventSubscription) =>
                  Effect.gen(function* () {
                    eventSubscription.unsubscribe()
                    yield* fileWatcherClient
                      .unsubscribe(watchSubscription.id)
                      .pipe(Effect.catchAll(() => Effect.void))
                  })
              )
            )
          })
        )

      return FileService.of({ list, read, watcherSubscribe })
    })
  )
}

export { FileService }
