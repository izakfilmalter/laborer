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

import {
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, extname, join, normalize, relative, resolve } from 'node:path'
import type {
  DiffContentsChangeType,
  DiffTarget,
  FileContent,
  FileDiffContents,
  FileDiffEntry,
  FileEntriesResult,
  FileEntry,
  FileInfo,
  FileNode,
  FileTextContent,
  FileWatcherEvent,
  FileWriteResult,
  WatchFileEvent,
} from '@laborer/shared/rpc'
import {
  DiffContentsUnavailable,
  DiffTargetUnresolved,
  RpcError,
} from '@laborer/shared/rpc'
import { formatPatch, structuredPatch } from 'diff'
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Order,
  pipe,
  Queue,
  Stream,
} from 'effect'
import ignore from 'ignore'
import { type GitProbeResult, resolveBaseRef } from '../lib/base-ref.js'
import { spawnGit } from '../lib/spawn-git.js'
import { FileWatcherClient } from './file-watcher-client.js'
import {
  LaborerDatabase,
  type LaborerDatabaseService,
} from './laborer-database.js'
import { findWorkspaceRecord } from './workspace-records.js'

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
  laborerDatabase: LaborerDatabaseService,
  workspaceId: string
) =>
  Effect.gen(function* () {
    const workspace = yield* laborerDatabase.read(
      'find workspace for file operation',
      (database) => findWorkspaceRecord(database, workspaceId)
    )

    if (workspace === null) {
      return yield* new RpcError({
        message: `Workspace not found: ${workspaceId}`,
        code: 'NOT_FOUND',
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
    }).pipe(Effect.catch(() => Effect.succeed(null)))

    if (gitignoreText !== null) {
      ig.add(gitignoreText)
    }

    const ignorePath = join(worktreeRoot, '.ignore')
    const ignoreText = yield* Effect.tryPromise({
      try: () => readFile(ignorePath, 'utf-8'),
      catch: () => null,
    }).pipe(Effect.catch(() => Effect.succeed(null)))

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

// ── Recursive worktree listing ──────────────────────────────────
// Backs `file.listEntries`: the right panel's explorer renders with
// `@pierre/trees`, which wants the whole flat path list up front rather
// than per-level pages.

/**
 * Entry cap for `file.listEntries`. The walk stops here and reports
 * `truncated: true` instead of shipping an unbounded listing for
 * pathological worktrees.
 */
const MAX_FILE_ENTRIES = 20_000

/** Directory-first, then name — the same order `file.list` sorts one level. */
const compareDirents = (
  a: { name: string; isDirectory(): boolean },
  b: { name: string; isDirectory(): boolean }
): number => {
  if (a.isDirectory() !== b.isDirectory()) {
    return a.isDirectory() ? -1 : 1
  }
  return a.name.localeCompare(b.name)
}

/** One walkable dirent classified against the ignore rules, or null. */
const classifyWalkDirent = (
  dirent: {
    name: string
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
  },
  parentDir: string,
  worktreeRoot: string,
  isIgnored: (relativePath: string) => boolean
): { entry: FileEntry; absolute: string } | null => {
  const name = String(dirent.name)
  const absolute = join(parentDir, name)
  const relPath = relative(worktreeRoot, absolute)

  if (dirent.isDirectory()) {
    if (IGNORED_DIRECTORIES.has(name) || isIgnored(`${relPath}/`)) {
      return null
    }
    return { entry: { path: relPath, kind: 'directory' }, absolute }
  }
  if (dirent.isFile() || dirent.isSymbolicLink()) {
    if (IGNORED_FILES.has(name) || isIgnored(relPath)) {
      return null
    }
    return { entry: { path: relPath, kind: 'file' }, absolute }
  }
  return null
}

/**
 * Walk the worktree depth-first, skipping noisy directories, OS metadata
 * files, and gitignored entries, stopping at {@link MAX_FILE_ENTRIES}.
 */
const walkWorktreeEntries = (
  worktreeRoot: string,
  isIgnored: (relativePath: string) => boolean
): Effect.Effect<FileEntriesResult, RpcError> =>
  Effect.tryPromise({
    try: async (): Promise<FileEntriesResult> => {
      const entries: FileEntry[] = []
      let truncated = false

      const walk = async (dir: string): Promise<void> => {
        const dirents = (await readdir(dir, { withFileTypes: true })).sort(
          compareDirents
        )
        for (const dirent of dirents) {
          if (truncated) {
            return
          }
          const classified = classifyWalkDirent(
            dirent,
            dir,
            worktreeRoot,
            isIgnored
          )
          if (classified === null) {
            continue
          }
          if (entries.length >= MAX_FILE_ENTRIES) {
            truncated = true
            return
          }
          entries.push(classified.entry)
          if (classified.entry.kind === 'directory') {
            await walk(classified.absolute)
          }
        }
      }

      await walk(worktreeRoot)
      return { entries, truncated }
    },
    catch: (error) =>
      new RpcError({
        message: `Failed to list worktree entries: ${String(error)}`,
        code: 'READDIR_FAILED',
      }),
  })

// ── Verbatim text reads and writes ──────────────────────────────
// Back `file.readText` and `file.write`: the file preview/editor surface
// needs the exact bytes (no trimEnd, no diff) with an honest preview cap,
// and a place to persist debounced edits.

/**
 * Preview cap for `file.readText`, mirroring t3code's 1 MB read limit.
 * The response reports the file's true size so the client can tell the
 * reader what was cut.
 */
const MAX_READ_TEXT_BYTES = 1024 * 1024

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
 * A resolved answer to "what is this diff measured against?".
 *
 * `baseRev` is a concrete revision every git invocation below is pointed at:
 * `HEAD` for the working target, a merge-base sha for the branch and ref
 * targets. `whitespaceFlags` is either empty or `['-w']`, applied to the
 * stat commands and the patch commands alike so line counts and patches
 * cannot disagree about what changed — with `-w` git omits a whitespace-only
 * file from `--numstat` entirely, so such a file never reaches the response
 * as an entry with an empty patch.
 */
interface DiffScope {
  readonly baseRev: string
  readonly whitespaceFlags: readonly string[]
}

/** The working target: the worktree against its own last commit. */
const WORKING_SCOPE: DiffScope = { baseRev: 'HEAD', whitespaceFlags: [] }

/**
 * Run the four git commands needed for `file.status` in parallel.
 * Returns `[numstat, untracked, deleted, added]` results.
 */
const runStatusGitCommands = (worktreeRoot: string, scope: DiffScope) => {
  const runDiff = (args: readonly string[], label: string) =>
    Effect.tryPromise({
      try: () =>
        spawnGit(
          [
            ...STATUS_GIT_FLAGS,
            'diff',
            ...scope.whitespaceFlags,
            ...args,
            scope.baseRev,
          ],
          { cwd: worktreeRoot, readOnly: true }
        ),
      catch: () =>
        new RpcError({
          message: `Failed to run git diff ${label}`,
          code: 'GIT_COMMAND_FAILED',
        }),
    })

  return Effect.all(
    [
      runDiff(['--numstat'], '--numstat'),
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
      runDiff(['--name-only', '--diff-filter=D'], '--diff-filter=D'),
      runDiff(['--name-only', '--diff-filter=A'], '--diff-filter=A'),
    ],
    { concurrency: 4 }
  )
}

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
      Effect.catch(() => Effect.succeed(0)),
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

/** Parse a `git diff --name-only` listing into paths. */
const parseNameOnlyOutput = (stdout: string): string[] => {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return []
  }
  return trimmed.split('\n').filter((p) => p.length > 0)
}

/**
 * Fold the four git listings into one status per file.
 *
 * `--numstat` reports every tracked difference, deletions and creations
 * included, so its entries are corrected against the name-only listings
 * rather than trusted as "modified". This matters far more under a branch
 * target than a working one: every file the branch created in a commit is a
 * tracked difference from the merge-base, and calling those "modified" would
 * have the pane claim the branch edited files that did not exist before.
 */
const classifyChangedFiles = (
  trackedStats: readonly FileInfo[],
  untracked: readonly FileInfo[],
  deletedPaths: readonly string[],
  addedPaths: readonly string[]
): readonly FileInfo[] => {
  const deleted = new Set(deletedPaths)
  const added = new Set(addedPaths)
  const tracked = pipe(
    trackedStats,
    Arr.filter((file) => !deleted.has(file.path)),
    Arr.map(
      (file): FileInfo =>
        added.has(file.path) ? { ...file, status: 'added' } : file
    )
  )
  return [
    ...tracked,
    ...untracked,
    ...deletedPaths.map(
      (filePath): FileInfo => ({
        path: filePath,
        added: 0,
        removed: 0,
        status: 'deleted',
      })
    ),
  ]
}

// ── Batched workspace diff computation ──────────────────────────
// Computes patches for every changed file with a single
// `git diff --patch HEAD` invocation (plus per-file `--no-index`
// diffs for untracked files), modeled on opencode's Vcs.diff and
// t3code's review diff preview.

/**
 * Context lines around each hunk. Previously this was effectively
 * `Infinity` (full-file context), which made every patch contain the
 * entire file — a one-line edit to a 20k-line file produced a 20k-line
 * patch that the diff viewer then parsed, highlighted, and rendered in
 * full. A bounded context keeps patches proportional to the actual
 * change; untracked (new) files still ship in full since every line is
 * an addition.
 */
const PATCH_CONTEXT_LINES = 8

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
 * Run one batched `git diff --patch <base>` for all tracked changes and
 * return a map of relative path → patch chunk. Returns an empty map
 * when the repo has no HEAD (fresh repo) or the command fails — the
 * caller degrades to entries without patches.
 */
const buildBatchedPatchMap = (
  worktreeRoot: string,
  scope: DiffScope
): Effect.Effect<Map<string, string>> =>
  Effect.tryPromise({
    try: () =>
      spawnGit(
        [
          ...STATUS_GIT_FLAGS,
          'diff',
          ...PATCH_GIT_FLAGS,
          ...scope.whitespaceFlags,
          scope.baseRev,
          '--',
          '.',
        ],
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
    Effect.catch(() => Effect.succeed(new Map<string, string>()))
  )

/**
 * Compute a patch for one untracked file by diffing it against
 * `/dev/null` with `git diff --no-index` (exit code 1 means "diff
 * found" and is expected). Returns `null` on failure so one bad file
 * never blocks the batch.
 */
const buildUntrackedPatch = (
  worktreeRoot: string,
  filePath: string,
  scope: DiffScope
): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: () =>
      spawnGit(
        [
          ...STATUS_GIT_FLAGS,
          'diff',
          '--no-index',
          ...PATCH_GIT_FLAGS,
          ...scope.whitespaceFlags,
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
    Effect.catch(() => Effect.succeed(null))
  )

// ── Diff target resolution ──────────────────────────────────────
// Turns the caller's `DiffTarget` into the concrete revision every git
// command above is pointed at.

/** A never-failing read-only git probe rooted at a worktree. */
const gitProbe =
  (worktreeRoot: string) =>
  (args: readonly string[]): Effect.Effect<GitProbeResult> =>
    Effect.tryPromise({
      try: () =>
        spawnGit([...STATUS_GIT_FLAGS, ...args], {
          cwd: worktreeRoot,
          readOnly: true,
        }),
      catch: () => null,
    }).pipe(
      Effect.map((result) => ({
        exitCode: result.exitCode,
        stdout: result.stdout,
      })),
      Effect.catch(() => Effect.succeed({ exitCode: -1, stdout: '' }))
    )

/**
 * Resolve the fork point between `ref` and the worktree's `HEAD`.
 *
 * This is where the two-dot/three-dot choice lives. `git diff base...HEAD`
 * is defined as `git diff $(git merge-base base HEAD) HEAD`, and git refuses
 * three-dot syntax when either side is the working tree — so it can never
 * answer "everything this branch did, including what is not committed yet".
 * Resolving the merge-base here and diffing from it to the worktree gives the
 * three-dot meaning (only this branch's work; commits that landed on the base
 * after the fork are simply not in the range) with the working tree on the
 * right-hand side. A plain two-dot `git diff base` would instead render every
 * base-branch commit inverted, as though the branch had deleted them.
 */
const resolveMergeBase = (
  worktreeRoot: string,
  ref: string
): Effect.Effect<string, DiffTargetUnresolved> =>
  Effect.gen(function* () {
    const probe = gitProbe(worktreeRoot)

    const verified = yield* probe([
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ])
    if (verified.exitCode !== 0) {
      return yield* new DiffTargetUnresolved({
        message: `This repository has no ref named ${ref}.`,
        reason: 'REF_NOT_FOUND',
        ref,
      })
    }

    const mergeBase = yield* probe(['merge-base', ref, 'HEAD'])
    const sha = mergeBase.stdout.trim()
    if (mergeBase.exitCode !== 0 || sha.length === 0) {
      return yield* new DiffTargetUnresolved({
        message: `This branch shares no history with ${ref}, so there is nothing to diff it against.`,
        reason: 'MERGE_BASE_FAILED',
        ref,
      })
    }

    return sha
  })

/**
 * Resolve a request's `DiffTarget` and whitespace preference into the
 * {@link DiffScope} every git invocation is run under.
 */
const resolveDiffScope = (
  worktreeRoot: string,
  target: DiffTarget,
  storedBaseBranch: string | null,
  ignoreWhitespace: boolean
): Effect.Effect<DiffScope, DiffTargetUnresolved> =>
  Effect.gen(function* () {
    const whitespaceFlags = ignoreWhitespace ? ['-w'] : []

    if (target._tag === 'working') {
      return { baseRev: 'HEAD', whitespaceFlags }
    }

    if (target._tag === 'ref') {
      return {
        baseRev: yield* resolveMergeBase(worktreeRoot, target.ref),
        whitespaceFlags,
      }
    }

    const baseRef = yield* resolveBaseRef(
      gitProbe(worktreeRoot),
      storedBaseBranch
    )
    if (baseRef === null) {
      return yield* new DiffTargetUnresolved({
        message:
          'No base branch is recorded for this workspace and the repository has no origin/HEAD, so the branch diff has nothing to fork from.',
        reason: 'NO_BASE_BRANCH',
        ref: null,
      })
    }

    return {
      baseRev: yield* resolveMergeBase(worktreeRoot, baseRef),
      whitespaceFlags,
    }
  })

// ── Whole-file contents for hunk expansion ──────────────────────
// Backs `file.diffContents`. The diff viewer can only expand unchanged
// context past a hunk if it holds both files in full, and the old side is
// a blob at the revision the patch was cut against — never the worktree.

/**
 * Per-side byte cap for `file.diffContents`.
 *
 * Deliberately well under `MAX_PATCH_BYTES`: that budget covers one
 * whole-workspace batch, while this is paid per expansion, per file, on a
 * round trip a reader is waiting on.
 */
const MAX_DIFF_CONTENTS_BYTES = 2_000_000

/** A side of a file plus whether the cap cut it short. */
interface CappedSide {
  readonly contents: string
  readonly truncated: boolean
}

/**
 * Cut `text` down to `maxBytes`, on a line boundary.
 *
 * Cutting mid-line would hand the viewer a line the file does not have, and
 * cutting mid-codepoint would hand it a replacement character, so the cut
 * lands at the last newline inside the budget. A single line longer than the
 * budget has no such boundary and is dropped entirely rather than halved.
 */
const capToBytes = (text: string, maxBytes: number): CappedSide => {
  const buffer = Buffer.from(text, 'utf-8')
  if (buffer.byteLength <= maxBytes) {
    return { contents: text, truncated: false }
  }
  const lastNewline = buffer.lastIndexOf(0x0a, maxBytes - 1)
  const end = lastNewline === -1 ? 0 : lastNewline + 1
  return {
    contents: buffer.subarray(0, end).toString('utf-8'),
    truncated: true,
  }
}

/** True when the decoded text cannot honestly be treated as lines of text. */
const looksBinary = (text: string): boolean =>
  text.includes('\u0000') || text.includes('\uFFFD')

/**
 * Reject a path that could reach outside the repository through `git show`,
 * which takes `<rev>:<path>` and so has no `--` to hide behind.
 */
const validateRepoRelativePath = (
  filePath: string
): Effect.Effect<void, RpcError> => {
  const segments = filePath.split('/')
  if (
    filePath.length === 0 ||
    filePath.startsWith('/') ||
    segments.includes('..')
  ) {
    return new RpcError({
      message: `Path escapes worktree root: ${filePath}`,
      code: 'PATH_TRAVERSAL',
    })
  }
  return Effect.void
}

/**
 * Read the old side of a file: the blob at `baseRev`.
 *
 * A non-zero exit is the base revision simply not having that path, which is
 * `OLD_PATH_ABSENT` — a different answer from the blob being empty, which
 * exits zero with empty stdout.
 */
const readBaseBlob = (
  worktreeRoot: string,
  baseRev: string,
  oldPath: string,
  maxBytes: number
): Effect.Effect<CappedSide, RpcError | DiffContentsUnavailable> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        spawnGit(
          [
            ...STATUS_GIT_FLAGS,
            'show',
            '--no-textconv',
            `${baseRev}:${oldPath}`,
          ],
          { cwd: worktreeRoot, readOnly: true }
        ),
      catch: () =>
        new RpcError({
          message: `Failed to read ${oldPath} at ${baseRev}`,
          code: 'GIT_COMMAND_FAILED',
        }),
    })

    if (result.exitCode !== 0) {
      return yield* new DiffContentsUnavailable({
        message: `${oldPath} does not exist at ${baseRev}.`,
        reason: 'OLD_PATH_ABSENT',
        path: oldPath,
      })
    }

    if (looksBinary(result.stdout)) {
      return yield* new DiffContentsUnavailable({
        message: `${oldPath} is not a text file.`,
        reason: 'BINARY_FILE',
        path: oldPath,
      })
    }

    return capToBytes(result.stdout, maxBytes)
  })

/**
 * Read the new side of a file: the worktree file, verbatim.
 *
 * Unlike {@link FileService.read} this does not `trimEnd()`. The viewer
 * counts lines from what it is given, so dropping a trailing newline would
 * leave its line count one short of the file's and put the end of the diff
 * outside the reachable scroll range.
 */
const readWorktreeFile = (
  worktreeRoot: string,
  newPath: string,
  maxBytes: number
): Effect.Effect<CappedSide, RpcError | DiffContentsUnavailable> =>
  Effect.gen(function* () {
    const fullPath = resolve(worktreeRoot, newPath)
    yield* validatePathContainment(fullPath, worktreeRoot, newPath)

    const buffer = yield* Effect.tryPromise({
      try: () => readFile(fullPath),
      catch: () => null,
    }).pipe(Effect.catch(() => Effect.succeed(null)))

    if (buffer === null) {
      return yield* new DiffContentsUnavailable({
        message: `${newPath} does not exist in the worktree.`,
        reason: 'NEW_PATH_ABSENT',
        path: newPath,
      })
    }

    const text = buffer.toString('utf-8')
    if (looksBinary(text)) {
      return yield* new DiffContentsUnavailable({
        message: `${newPath} is not a text file.`,
        reason: 'BINARY_FILE',
        path: newPath,
      })
    }

    return capToBytes(text, maxBytes)
  })

/**
 * Assemble `FileDiffEntry[]` from the status file list and the patch
 * map, enforcing per-file and total byte budgets. Once the total
 * budget is exhausted, remaining patches are omitted with
 * `truncated: true` (opencode's "capped" behavior).
 *
 * The budget is deliberately target-blind: it reads the assembled patch map,
 * so a branch diff — which can be orders of magnitude larger than a
 * working-tree diff — is capped by exactly the same rule. When a branch diff
 * blows the budget the response still lists every changed file with its line
 * counts; the files past the cap simply arrive with `truncated: true` and no
 * patch text, which is what the pane renders a placeholder for.
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
    Effect.catch(() => Effect.succeed({ type: 'text' as const, content }))
  )

class FileService extends Context.Service<
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
     * List every file and directory in the worktree as one flat recursive
     * listing for the explorer, capped at {@link MAX_FILE_ENTRIES}.
     *
     * @param workspaceId - ID of the workspace
     */
    readonly listEntries: (
      workspaceId: string
    ) => Effect.Effect<FileEntriesResult, RpcError>

    /**
     * Read a text file verbatim (no trimEnd, no diff) up to the 1 MB
     * preview cap, reporting the file's true size and a truncation flag.
     *
     * Fails with `BINARY_FILE` for non-text files, `NOT_FOUND` when the
     * path does not exist, `PATH_TRAVERSAL` when it escapes the worktree.
     *
     * @param workspaceId - ID of the workspace
     * @param filePath - Path of the file relative to the worktree root
     */
    readonly readText: (
      workspaceId: string,
      filePath: string
    ) => Effect.Effect<FileTextContent, RpcError>

    /**
     * Write a text file inside the worktree, creating parent directories
     * as needed. Backs the file editor's debounced save.
     *
     * @param workspaceId - ID of the workspace
     * @param filePath - Path of the file relative to the worktree root
     * @param contents - Full UTF-8 contents to write verbatim
     */
    readonly write: (
      workspaceId: string,
      filePath: string,
      contents: string
    ) => Effect.Effect<FileWriteResult, RpcError>

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
     * one `git diff --patch <base>` invocation split per file; untracked
     * files are diffed against `/dev/null` via `git diff --no-index`
     * with bounded concurrency. Patches exceeding the size budget are
     * omitted with `truncated: true`.
     *
     * `<base>` is `HEAD` for the default `working` target and the merge-base
     * with the workspace's base branch for `branch` — see
     * {@link resolveMergeBase} for why that is a resolved merge-base rather
     * than three-dot syntax.
     *
     * @param workspaceId - ID of the workspace
     * @param options - diff target (default `working`) and whitespace handling
     */
    readonly diff: (
      workspaceId: string,
      options?: {
        readonly ignoreWhitespace?: boolean | undefined
        readonly target?: DiffTarget | undefined
      }
    ) => Effect.Effect<
      readonly FileDiffEntry[],
      RpcError | DiffTargetUnresolved
    >

    /**
     * Return both sides of one changed file in full, for hunk expansion.
     *
     * The old side is `git show <base>:<oldPath>` where `<base>` is the
     * revision {@link resolveDiffScope} resolves the caller's target to —
     * `HEAD` for `working`, a merge-base sha for `branch` and `ref`. Reusing
     * that resolution is the point: the old side of a branch diff is a blob
     * at the fork point, and serving the worktree instead would show the
     * wrong code with no sign that it was wrong.
     *
     * The new side is the worktree file verbatim — no `trimEnd()`, unlike
     * {@link read}. Each side is capped independently and reports whether
     * the cap cut it short.
     *
     * Whitespace handling is not a parameter here. `-w` decides which lines
     * git puts inside hunks; it does not change what the files contain, so
     * whitespace-only lines reappear as plain context inside an expanded
     * region. That is the intended reading of "ignore whitespace" — keep
     * those changes out of the summary, do not deny they exist.
     *
     * @param workspaceId - ID of the workspace
     * @param request - target, change type, and both paths for one file
     */
    readonly diffContents: (
      workspaceId: string,
      request: {
        readonly target: DiffTarget
        readonly changeType: DiffContentsChangeType
        readonly oldPath: string
        readonly newPath: string
        readonly maxBytes?: number | undefined
      }
    ) => Effect.Effect<
      FileDiffContents,
      RpcError | DiffTargetUnresolved | DiffContentsUnavailable
    >

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
>()('@laborer/FileService') {
  static readonly layer = Layer.effect(
    FileService,
    Effect.gen(function* () {
      const laborerDatabase = yield* LaborerDatabase
      const fileWatcherClient = yield* FileWatcherClient

      const list = (
        workspaceId: string,
        dir?: string
      ): Effect.Effect<readonly FileNode[], RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(laborerDatabase, workspaceId)
          const worktreeRoot = workspace.worktreePath

          const targetDir =
            dir !== undefined ? resolve(worktreeRoot, dir) : worktreeRoot

          yield* validatePathContainment(targetDir, worktreeRoot, dir)

          const isIgnored = yield* loadIgnorePatterns(worktreeRoot)

          return yield* readAndBuildNodes(targetDir, worktreeRoot, isIgnored)
        })

      const listEntries = (
        workspaceId: string
      ): Effect.Effect<FileEntriesResult, RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(laborerDatabase, workspaceId)
          const worktreeRoot = workspace.worktreePath
          const isIgnored = yield* loadIgnorePatterns(worktreeRoot)
          return yield* walkWorktreeEntries(worktreeRoot, isIgnored)
        })

      const readText = (
        workspaceId: string,
        filePath: string
      ): Effect.Effect<FileTextContent, RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(laborerDatabase, workspaceId)
          const worktreeRoot = workspace.worktreePath
          const fullPath = resolve(worktreeRoot, filePath)

          yield* validatePathContainment(fullPath, worktreeRoot, filePath)

          if (isBinaryByExtension(filePath) || isImageByExtension(filePath)) {
            return yield* new RpcError({
              message: `${filePath} is not a text file.`,
              code: 'BINARY_FILE',
            })
          }

          const result = yield* Effect.tryPromise({
            try: async (): Promise<FileTextContent> => {
              const stats = await stat(fullPath)
              if (!stats.isFile()) {
                throw Object.assign(new Error('not a file'), {
                  code: 'ENOENT',
                })
              }
              const bytesToRead = Math.min(stats.size, MAX_READ_TEXT_BYTES)
              const handle = await open(fullPath, 'r')
              try {
                const buffer = Buffer.alloc(bytesToRead)
                const { bytesRead } = await handle.read(
                  buffer,
                  0,
                  bytesToRead,
                  0
                )
                return {
                  relativePath: filePath,
                  contents: buffer.subarray(0, bytesRead).toString('utf-8'),
                  byteLength: stats.size,
                  truncated: stats.size > MAX_READ_TEXT_BYTES,
                }
              } finally {
                await handle.close()
              }
            },
            catch: (error) => {
              const code = (error as NodeJS.ErrnoException | undefined)?.code
              if (code === 'ENOENT' || code === 'ENOTDIR') {
                return new RpcError({
                  message: `File not found: ${filePath}`,
                  code: 'NOT_FOUND',
                })
              }
              return new RpcError({
                message: `Failed to read file: ${String(error)}`,
                code: 'READ_FAILED',
              })
            },
          })

          // Extension checks miss extensionless binaries; sniff the decoded
          // text so the editor never renders mangled bytes as source.
          if (looksBinary(result.contents)) {
            return yield* new RpcError({
              message: `${filePath} is not a text file.`,
              code: 'BINARY_FILE',
            })
          }

          return result
        })

      const write = (
        workspaceId: string,
        filePath: string,
        contents: string
      ): Effect.Effect<FileWriteResult, RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(laborerDatabase, workspaceId)
          const worktreeRoot = workspace.worktreePath
          const fullPath = resolve(worktreeRoot, filePath)

          yield* validatePathContainment(fullPath, worktreeRoot, filePath)

          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(dirname(fullPath), { recursive: true })
              await writeFile(fullPath, contents, 'utf-8')
            },
            catch: (error) =>
              new RpcError({
                message: `Failed to write file: ${String(error)}`,
                code: 'WRITE_FAILED',
              }),
          })

          return { relativePath: filePath }
        })

      const read = (
        workspaceId: string,
        filePath: string
      ): Effect.Effect<FileContent, RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(laborerDatabase, workspaceId)
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
            }).pipe(Effect.catch(() => Effect.succeed(null)))

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
          }).pipe(Effect.catch(() => Effect.succeed(null)))

          if (fileContent === null) {
            return { type: 'text' as const, content: '' }
          }

          const content = fileContent.trimEnd()

          // Compute per-file diff against HEAD
          return yield* computeFileDiff(worktreeRoot, filePath, content)
        })

      const computeStatus = (
        worktreeRoot: string,
        scope: DiffScope
      ): Effect.Effect<readonly FileInfo[], RpcError> =>
        Effect.gen(function* () {
          // Run four git commands in parallel
          const [numstatResult, untrackedResult, deletedResult, addedResult] =
            yield* runStatusGitCommands(worktreeRoot, scope)

          const trackedStats = parseNumstatOutput(numstatResult.stdout)
          const untracked = yield* parseUntrackedOutput(
            untrackedResult.stdout,
            worktreeRoot
          )

          return classifyChangedFiles(
            trackedStats,
            untracked,
            parseNameOnlyOutput(deletedResult.stdout),
            parseNameOnlyOutput(addedResult.stdout)
          )
        })

      const status = (
        workspaceId: string
      ): Effect.Effect<readonly FileInfo[], RpcError> =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(laborerDatabase, workspaceId)
          return yield* computeStatus(workspace.worktreePath, WORKING_SCOPE)
        })

      const diff = (
        workspaceId: string,
        options?: {
          readonly ignoreWhitespace?: boolean | undefined
          readonly target?: DiffTarget | undefined
        }
      ): Effect.Effect<
        readonly FileDiffEntry[],
        RpcError | DiffTargetUnresolved
      > =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(laborerDatabase, workspaceId)
          const worktreeRoot = workspace.worktreePath

          // The base a branch diff forks from is whatever already names it:
          // the branch this workspace's PR targets, else the branch the task
          // was cut from. `resolveBaseRef` owns every fallback past that.
          const scope = yield* resolveDiffScope(
            worktreeRoot,
            options?.target ?? { _tag: 'working' },
            workspace.prBaseBranch ?? workspace.baseBranch,
            options?.ignoreWhitespace ?? false
          )

          // File list with line stats + batched tracked-change patches,
          // computed concurrently.
          const [files, patchMap] = yield* Effect.all(
            [
              computeStatus(worktreeRoot, scope),
              buildBatchedPatchMap(worktreeRoot, scope),
            ],
            { concurrency: 2 }
          )

          // Untracked files are absent from `git diff <base>` — diff each
          // against /dev/null with bounded concurrency.
          const untrackedFiles = files.filter(
            (file) => file.status === 'added' && !patchMap.has(file.path)
          )
          const untrackedPatches = yield* Effect.forEach(
            untrackedFiles,
            (file) =>
              buildUntrackedPatch(worktreeRoot, file.path, scope).pipe(
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

      const diffContents = (
        workspaceId: string,
        request: {
          readonly target: DiffTarget
          readonly changeType: DiffContentsChangeType
          readonly oldPath: string
          readonly newPath: string
          readonly maxBytes?: number | undefined
        }
      ): Effect.Effect<
        FileDiffContents,
        RpcError | DiffTargetUnresolved | DiffContentsUnavailable
      > =>
        Effect.gen(function* () {
          const workspace = yield* lookupWorkspace(laborerDatabase, workspaceId)
          const worktreeRoot = workspace.worktreePath

          yield* validateRepoRelativePath(request.oldPath)
          yield* validateRepoRelativePath(request.newPath)

          // A binary file has no lines to expand into, and decoding one as
          // UTF-8 would hand the viewer mangled text that looks like source.
          if (
            isBinaryByExtension(request.newPath) ||
            isImageByExtension(request.newPath)
          ) {
            return yield* new DiffContentsUnavailable({
              message: `${request.newPath} is not a text file.`,
              reason: 'BINARY_FILE',
              path: request.newPath,
            })
          }

          // `maxBytes` may lower the cap but never raise it.
          const maxBytes = Math.min(
            request.maxBytes ?? MAX_DIFF_CONTENTS_BYTES,
            MAX_DIFF_CONTENTS_BYTES
          )

          // Whitespace handling is intentionally fixed: file contents are
          // file contents, and `-w` only ever shaped the hunks.
          const scope = yield* resolveDiffScope(
            worktreeRoot,
            request.target,
            workspace.prBaseBranch ?? workspace.baseBranch,
            false
          )

          const newSide = yield* readWorktreeFile(
            worktreeRoot,
            request.newPath,
            maxBytes
          )

          // A pure rename's old side is byte-identical to its new side, so
          // reading the blob would spend a git process to learn nothing;
          // the viewer's loader wants `oldFile: null` there anyway.
          if (request.changeType === 'rename-pure') {
            return {
              oldContents: '',
              newContents: newSide.contents,
              oldTruncated: false,
              newTruncated: newSide.truncated,
            }
          }

          const oldSide = yield* readBaseBlob(
            worktreeRoot,
            scope.baseRev,
            request.oldPath,
            maxBytes
          )

          return {
            oldContents: oldSide.contents,
            newContents: newSide.contents,
            oldTruncated: oldSide.truncated,
            newTruncated: newSide.truncated,
          }
        })

      const watcherSubscribe = (
        workspaceId: string
      ): Stream.Stream<FileWatcherEvent, RpcError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const workspace = yield* lookupWorkspace(
              laborerDatabase,
              workspaceId
            )
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
            return Stream.callback<FileWatcherEvent, RpcError>((queue) =>
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

                      Queue.offerUnsafe(queue, {
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
                      .pipe(Effect.catch(() => Effect.void))
                  })
              )
            )
          })
        )

      return FileService.of({
        list,
        listEntries,
        read,
        readText,
        status,
        diff,
        diffContents,
        watcherSubscribe,
        write,
      })
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
