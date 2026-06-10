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
 * - `status(workspaceId)` — workspace-level changed file summary
 * - `watcherSubscribe(workspaceId)` — per-workspace file watcher event stream
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
  FileDiffEntry,
  FileInfo,
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
import ignore from 'ignore'
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
 * Load gitignore and ignore patterns from the worktree root.
 *
 * Reads `.gitignore` and `.ignore` files from the worktree root,
 * parses them with the `ignore` npm package, and returns a function
 * that tests whether a given relative path should be marked as ignored.
 *
 * If either file is missing, it is silently skipped. If neither exists,
 * the returned function always returns `false`.
 *
 * For directories, the caller should append a trailing `/` before
 * testing (matching gitignore directory semantics).
 */
const loadIgnorePatterns = (
  worktreeRoot: string
): Effect.Effect<(relativePath: string) => boolean, never> =>
  Effect.gen(function* () {
    const ig = ignore()

    const gitignorePath = join(worktreeRoot, '.gitignore')
    const gitignoreText = yield* Effect.tryPromise({
      try: () => readFile(gitignorePath, 'utf-8'),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)))

    if (gitignoreText !== null) {
      ig.add(gitignoreText)
    }

    const ignorePath = join(worktreeRoot, '.ignore')
    const ignoreText = yield* Effect.tryPromise({
      try: () => readFile(ignorePath, 'utf-8'),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)))

    if (ignoreText !== null) {
      ig.add(ignoreText)
    }

    return ig.ignores.bind(ig)
  })

/**
 * Read directory entries and build FileNode array, filtering ignored entries.
 *
 * @param isIgnored — function that returns true if a relative path is
 *   gitignored. For directories, the path is tested with a trailing `/`.
 */
const readAndBuildNodes = (
  targetDir: string,
  worktreeRoot: string,
  isIgnored: (relativePath: string) => boolean
) =>
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
        const relPath = relative(worktreeRoot, absolute)
        nodes.push({
          name,
          path: relPath,
          absolute,
          type: 'directory',
          ignored: isIgnored(`${relPath}/`),
        })
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (IGNORED_FILES.has(name)) {
          continue
        }
        const absolute = join(targetDir, name)
        const relPath = relative(worktreeRoot, absolute)
        nodes.push({
          name,
          path: relPath,
          absolute,
          type: 'file',
          ignored: isIgnored(relPath),
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

// ── Status computation helpers ──────────────────────────────────
// Extracted from FileService.status() for clarity and to keep cognitive
// complexity within bounds.

/** Common git args prepended to status-related commands. */
const STATUS_GIT_FLAGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
]

/**
 * Run the three git commands needed for `file.status` in parallel.
 * Returns `[numstat, untracked, deleted]` results.
 */
const runStatusGitCommands = (worktreeRoot: string) =>
  Effect.all(
    [
      Effect.tryPromise({
        try: () =>
          spawnGit([...STATUS_GIT_FLAGS, 'diff', '--numstat', 'HEAD'], {
            cwd: worktreeRoot,
            readOnly: true,
          }),
        catch: () =>
          new RpcError({
            message: 'Failed to run git diff --numstat',
            code: 'GIT_COMMAND_FAILED',
          }),
      }),
      Effect.tryPromise({
        try: () =>
          spawnGit(
            [...STATUS_GIT_FLAGS, 'ls-files', '--others', '--exclude-standard'],
            { cwd: worktreeRoot, readOnly: true }
          ),
        catch: () =>
          new RpcError({
            message: 'Failed to run git ls-files',
            code: 'GIT_COMMAND_FAILED',
          }),
      }),
      Effect.tryPromise({
        try: () =>
          spawnGit(
            [
              ...STATUS_GIT_FLAGS,
              'diff',
              '--name-only',
              '--diff-filter=D',
              'HEAD',
            ],
            { cwd: worktreeRoot, readOnly: true }
          ),
        catch: () =>
          new RpcError({
            message: 'Failed to run git diff --diff-filter=D',
            code: 'GIT_COMMAND_FAILED',
          }),
      }),
    ],
    { concurrency: 3 }
  )

/**
 * Parse `git diff --numstat HEAD` output into FileInfo entries.
 * Format per line: `<added>\t<removed>\t<path>`
 * Binary files show `-\t-\t<path>`.
 */
const parseNumstatOutput = (stdout: string): FileInfo[] => {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return []
  }
  const entries: FileInfo[] = []
  for (const line of trimmed.split('\n')) {
    const parts = line.split('\t')
    if (parts.length >= 3) {
      const addedStr = parts[0] ?? '0'
      const removedStr = parts[1] ?? '0'
      const filePath = parts.slice(2).join('\t')
      const added = addedStr === '-' ? 0 : Number.parseInt(addedStr, 10)
      const removed = removedStr === '-' ? 0 : Number.parseInt(removedStr, 10)
      entries.push({
        path: filePath,
        added: Number.isNaN(added) ? 0 : added,
        removed: Number.isNaN(removed) ? 0 : removed,
        status: 'modified',
      })
    }
  }
  return entries
}

/**
 * Parse `git ls-files --others --exclude-standard` output into FileInfo entries.
 * Reads each untracked file to count lines for the `added` count.
 */
const parseUntrackedOutput = (
  stdout: string,
  worktreeRoot: string
): Effect.Effect<FileInfo[], RpcError> => {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return Effect.succeed([])
  }
  const paths = trimmed.split('\n').filter((p) => p.length > 0)
  return Effect.forEach(paths, (filePath) =>
    pipe(
      Effect.tryPromise({
        try: async () => {
          const content = await readFile(
            resolve(worktreeRoot, filePath),
            'utf-8'
          )
          return content.split('\n').filter((l) => l.length > 0).length
        },
        catch: () =>
          new RpcError({
            message: `Failed to read untracked file: ${filePath}`,
            code: 'READ_FAILED',
          }),
      }),
      Effect.catchAll(() => Effect.succeed(0)),
      Effect.map(
        (lineCount): FileInfo => ({
          path: filePath,
          added: lineCount,
          removed: 0,
          status: 'added',
        })
      )
    )
  )
}

/**
 * Parse `git diff --name-only --diff-filter=D HEAD` output into FileInfo entries.
 */
const parseDeletedOutput = (stdout: string): FileInfo[] => {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return []
  }
  return trimmed
    .split('\n')
    .filter((p) => p.length > 0)
    .map(
      (filePath): FileInfo => ({
        path: filePath,
        added: 0,
        removed: 0,
        status: 'deleted',
      })
    )
}

/**
 * Remove deleted files from the modified list — `git diff --numstat` includes
 * deleted files, so they'd appear in both the modified and deleted lists.
 */
const deduplicateStatusResults = (
  results: readonly FileInfo[]
): readonly FileInfo[] => {
  const deletedPaths = new Set(
    pipe(
      results,
      Arr.filter((f) => f.status === 'deleted'),
      Arr.map((f) => f.path)
    )
  )
  return pipe(
    results,
    Arr.filter((f) => f.status !== 'modified' || !deletedPaths.has(f.path))
  )
}

// ── Batched workspace diff computation ──────────────────────────
// Computes patches for every changed file with a single
// `git diff --patch HEAD` invocation (plus per-file `--no-index`
// diffs for untracked files), modeled on opencode's Vcs.diff and
// t3code's review diff preview.

/**
 * Full-file context so patches include the entire file, matching the
 * previous `structuredPatch(..., { context: Infinity })` behavior.
 * Same value opencode uses as its default patch context.
 */
const PATCH_CONTEXT_LINES = 2_147_483_647

/** Per-file patch byte budget — larger patches are omitted + flagged. */
const MAX_PATCH_BYTES = 10_000_000

/** Total patch byte budget across all files in one `file.diff` response. */
const MAX_TOTAL_PATCH_BYTES = 10_000_000

/** Bounded fan-out for untracked-file `git diff --no-index` calls. */
const UNTRACKED_DIFF_CONCURRENCY = 4

/** Flags shared by all patch-producing git diff invocations. */
const PATCH_GIT_FLAGS = [
  '--patch',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  `--unified=${String(PATCH_CONTEXT_LINES)}`,
]

/** Matches the `diff --git a/<path> b/<path>` header for identical paths. */
const DIFF_GIT_HEADER_REGEX = /^diff --git a\/(.+) b\/\1$/

/** Splits combined `git diff` output ahead of each `diff --git ` header. */
const DIFF_CHUNK_BOUNDARY_REGEX = /^(?=diff --git )/m

/** Strips git's trailing tab from `+++ b/<path>` / `--- a/<path>` headers. */
const TRAILING_TAB_REGEX = /\t$/

/**
 * Split combined `git diff` output into per-file chunks on
 * `diff --git ` boundaries. The first element (anything before the
 * first header) is dropped.
 */
const splitGitPatch = (combined: string): string[] => {
  if (!combined.trim()) {
    return []
  }
  const parts = combined.split(DIFF_CHUNK_BOUNDARY_REGEX)
  return parts.filter((part) => part.startsWith('diff --git '))
}

/**
 * Extract the file path a patch chunk applies to.
 *
 * Prefers the `+++ b/<path>` header, falling back to `--- a/<path>`
 * for deletions (where `+++` is `/dev/null`), then to the
 * `diff --git a/<p> b/<p>` line for binary chunks that have neither.
 */
const fileFromPatchChunk = (chunk: string): string | null => {
  for (const line of chunk.split('\n')) {
    if (line.startsWith('+++ b/')) {
      return line.slice('+++ b/'.length).replace(TRAILING_TAB_REGEX, '')
    }
    if (line.startsWith('--- a/') && chunk.includes('+++ /dev/null')) {
      return line.slice('--- a/'.length).replace(TRAILING_TAB_REGEX, '')
    }
  }
  const headerLine = chunk.split('\n')[0] ?? ''
  const match = DIFF_GIT_HEADER_REGEX.exec(headerLine)
  return match?.[1] ?? null
}

/**
 * Run one batched `git diff --patch HEAD` for all tracked changes and
 * return a map of relative path → patch chunk. Returns an empty map
 * when the repo has no HEAD (fresh repo) or the command fails — the
 * caller degrades to entries without patches.
 */
const buildBatchedPatchMap = (
  worktreeRoot: string
): Effect.Effect<Map<string, string>> =>
  Effect.tryPromise({
    try: () =>
      spawnGit(
        [...STATUS_GIT_FLAGS, 'diff', ...PATCH_GIT_FLAGS, 'HEAD', '--', '.'],
        { cwd: worktreeRoot, readOnly: true }
      ),
    catch: () => null,
  }).pipe(
    Effect.map((result) => {
      const map = new Map<string, string>()
      if (result.exitCode !== 0) {
        return map
      }
      for (const chunk of splitGitPatch(result.stdout)) {
        const path = fileFromPatchChunk(chunk)
        if (path !== null) {
          map.set(path, chunk)
        }
      }
      return map
    }),
    Effect.catchAll(() => Effect.succeed(new Map<string, string>()))
  )

/**
 * Compute a patch for one untracked file by diffing it against
 * `/dev/null` with `git diff --no-index` (exit code 1 means "diff
 * found" and is expected). Returns `null` on failure so one bad file
 * never blocks the batch.
 */
const buildUntrackedPatch = (
  worktreeRoot: string,
  filePath: string
): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: () =>
      spawnGit(
        [
          ...STATUS_GIT_FLAGS,
          'diff',
          '--no-index',
          ...PATCH_GIT_FLAGS,
          '--',
          '/dev/null',
          filePath,
        ],
        { cwd: worktreeRoot, readOnly: true }
      ),
    catch: () => null,
  }).pipe(
    Effect.map((result) => {
      const patch = result.stdout.trim()
      return patch.length > 0 ? result.stdout : null
    }),
    Effect.catchAll(() => Effect.succeed(null))
  )

/**
 * Assemble `FileDiffEntry[]` from the status file list and the patch
 * map, enforcing per-file and total byte budgets. Once the total
 * budget is exhausted, remaining patches are omitted with
 * `truncated: true` (opencode's "capped" behavior).
 */
const assembleDiffEntries = (
  files: readonly FileInfo[],
  patches: ReadonlyMap<string, string>
): FileDiffEntry[] => {
  let totalBytes = 0
  let capped = false
  const entries: FileDiffEntry[] = []
  for (const file of files) {
    const patch = patches.get(file.path)
    if (patch === undefined) {
      entries.push({ ...file, truncated: false })
      continue
    }
    const patchBytes = Buffer.byteLength(patch, 'utf-8')
    if (capped || patchBytes > MAX_PATCH_BYTES) {
      entries.push({ ...file, truncated: true })
      continue
    }
    totalBytes += patchBytes
    if (totalBytes > MAX_TOTAL_PATCH_BYTES) {
      capped = true
      entries.push({ ...file, truncated: true })
      continue
    }
    entries.push({ ...file, patch, truncated: false })
  }
  return entries
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
     * Return a summary of all changed files in a workspace.
     *
     * Runs three git commands in parallel:
     * - `git diff --numstat HEAD` for modified files with line counts
     * - `git ls-files --others --exclude-standard` for untracked (added) files
     * - `git diff --name-only --diff-filter=D HEAD` for deleted files
     *
     * Returns `FileInfo[]` where each entry has a relative path,
     * added/removed line counts, and a status.
     *
     * @param workspaceId - ID of the workspace
     */
    readonly status: (
      workspaceId: string
    ) => Effect.Effect<readonly FileInfo[], RpcError>

    /**
     * Return all changed files with their unified diff patches in a
     * single batched call.
     *
     * Tracked changes (modified + deleted, staged or unstaged) come from
     * one `git diff --patch HEAD` invocation split per file; untracked
     * files are diffed against `/dev/null` via `git diff --no-index`
     * with bounded concurrency. Patches exceeding the size budget are
     * omitted with `truncated: true`.
     *
     * @param workspaceId - ID of the workspace
     */
    readonly diff: (
      workspaceId: string
    ) => Effect.Effect<readonly FileDiffEntry[], RpcError>

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

          const isIgnored = yield* loadIgnorePatterns(worktreeRoot)

          return yield* readAndBuildNodes(targetDir, worktreeRoot, isIgnored)
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

      const computeStatus = (
        worktreeRoot: string
      ): Effect.Effect<readonly FileInfo[], RpcError> =>
        Effect.gen(function* () {
          // Run three git commands in parallel
          const [numstatResult, untrackedResult, deletedResult] =
            yield* runStatusGitCommands(worktreeRoot)

          const modified = parseNumstatOutput(numstatResult.stdout)
          const added = yield* parseUntrackedOutput(
            untrackedResult.stdout,
            worktreeRoot
          )
          const deleted = parseDeletedOutput(deletedResult.stdout)

          return deduplicateStatusResults([...modified, ...added, ...deleted])
        })

      const status = (
        workspaceId: string
      ): Effect.Effect<readonly FileInfo[], RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(store, workspaceId)
          return yield* computeStatus(workspace.worktreePath)
        })

      const diff = (
        workspaceId: string
      ): Effect.Effect<readonly FileDiffEntry[], RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(store, workspaceId)
          const worktreeRoot = workspace.worktreePath

          // File list with line stats + batched tracked-change patches,
          // computed concurrently.
          const [files, patchMap] = yield* Effect.all(
            [computeStatus(worktreeRoot), buildBatchedPatchMap(worktreeRoot)],
            { concurrency: 2 }
          )

          // Untracked files are absent from `git diff HEAD` — diff each
          // against /dev/null with bounded concurrency.
          const untrackedFiles = files.filter(
            (file) => file.status === 'added' && !patchMap.has(file.path)
          )
          const untrackedPatches = yield* Effect.forEach(
            untrackedFiles,
            (file) =>
              buildUntrackedPatch(worktreeRoot, file.path).pipe(
                Effect.map((patch) => [file.path, patch] as const)
              ),
            { concurrency: UNTRACKED_DIFF_CONCURRENCY }
          )
          for (const [path, patch] of untrackedPatches) {
            if (patch !== null) {
              patchMap.set(path, patch)
            }
          }

          return assembleDiffEntries(files, patchMap)
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

      return FileService.of({ list, read, status, diff, watcherSubscribe })
    })
  )
}

export {
  // Exported for testing — pure helpers behind the batched `file.diff` RPC
  assembleDiffEntries,
  fileFromPatchChunk,
  FileService,
  splitGitPatch,
}
