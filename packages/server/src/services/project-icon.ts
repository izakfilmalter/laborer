/**
 * Discovers a project's own icon by finding an icon file anywhere in its
 * repository.
 *
 * A repository already declares how it wants to be recognised — the favicon it
 * ships to its users — so mission control reuses that rather than inventing a
 * second identity. The file is inlined as a `data:` URL because the renderer
 * has no route to arbitrary local paths, and a favicon is small enough that
 * carrying the bytes costs less than building one.
 *
 * Repositories put that file wherever their framework wants it, so discovery
 * searches by *name* across the tree rather than guessing at a fixed list of
 * paths: a monorepo's `apps/web/public/favicon.ico` and a Vite app's
 * `public/favicon.svg` are found by the same rule. The walk is bounded — it
 * skips dependency and build directories, stops at a depth, and stops after a
 * budget of entries — so a large repository cannot make registration slow.
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { Effect } from 'effect'

/**
 * Base names recognised as a project icon, best first. A `favicon` is the
 * file the project already points browsers at, so it wins; `icon` and
 * `apple-touch-icon` are the next most deliberate; a `logo` is a guess and
 * ranks last.
 */
const ICON_BASE_NAMES = ['favicon', 'icon', 'apple-touch-icon', 'logo'] as const

/** Extensions we can inline, best-rendering first. */
const MEDIA_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
}

const EXTENSION_RANK = Object.keys(MEDIA_TYPES)

/**
 * Directories that never hold the project's identity: dependencies, build
 * output, caches, and version-control internals. Skipping them keeps the walk
 * cheap and stops a vendored package's icon from impersonating the project.
 */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.venv',
  '.yarn',
  'bower_components',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'tmp',
  'vendor',
])

/** Depth and breadth bounds. Icons live near the top of a project. */
const MAX_DEPTH = 6
const MAX_ENTRIES_SCANNED = 20_000

/**
 * Size bound. Every icon travels inside the project row on every shared-state
 * snapshot, so an oversized "favicon" is skipped rather than allowed to bloat
 * the stream; the next candidate, or no icon at all, is the better outcome.
 */
const MAX_ICON_BYTES = 128 * 1024

interface Candidate {
  readonly absolutePath: string
  readonly mediaType: string
  /** Sort key: lower is better, compared field by field. */
  readonly rank: readonly number[]
}

/** Matches the `32x32` in a `favicon-32x32.png`. */
const SIZE_SUFFIX = /^(\d+)x\d+$/

/**
 * Ranks a file name, or returns null when it is not an icon.
 *
 * Recognises the sized variants frameworks emit (`favicon-32x32.png`) and
 * prefers the unsuffixed file, then the largest size, so a project that ships
 * a whole set is represented by its best single image.
 */
const rankStem = (stem: string): readonly number[] | null => {
  for (const [nameRank, baseName] of ICON_BASE_NAMES.entries()) {
    if (stem === baseName) {
      return [nameRank, 0, 0]
    }
    const sized = stem.startsWith(`${baseName}-`)
      ? SIZE_SUFFIX.exec(stem.slice(baseName.length + 1))
      : null
    if (sized) {
      // Suffixed variants rank below the plain name, largest first.
      return [nameRank, 1, -Number(sized[1])]
    }
  }
  return null
}

const describeIcon = (
  fileName: string
): { readonly mediaType: string; readonly rank: readonly number[] } | null => {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }
  const extension = fileName.slice(dot + 1).toLowerCase()
  const mediaType = MEDIA_TYPES[extension]
  if (mediaType === undefined) {
    return null
  }
  const stemRank = rankStem(fileName.slice(0, dot).toLowerCase())
  return stemRank === null
    ? null
    : { mediaType, rank: [...stemRank, EXTENSION_RANK.indexOf(extension)] }
}

const isSearchableDirectory = (name: string): boolean =>
  !(name.startsWith('.') || SKIPPED_DIRECTORIES.has(name))

const compareRanks = (a: Candidate, b: Candidate): number => {
  for (const [index, value] of a.rank.entries()) {
    const other = b.rank[index] ?? 0
    if (value !== other) {
      return value - other
    }
  }
  return a.absolutePath.localeCompare(b.absolutePath)
}

interface Scan {
  /** Counts down so the walk stops on very large repositories. */
  budget: number
  readonly candidates: Candidate[]
  readonly rootPath: string
}

const readEntries = async (directoryPath: string): Promise<Dirent[]> => {
  try {
    return await readdir(directoryPath, { withFileTypes: true })
  } catch {
    // An unreadable directory is the common case, not a failure.
    return []
  }
}

/**
 * Records the icons in one directory and returns the subdirectories still
 * worth visiting.
 */
const visit = (scan: Scan, directoryPath: string, entries: Dirent[]) => {
  const subdirectories: string[] = []
  for (const entry of entries) {
    if (scan.budget <= 0) {
      break
    }
    scan.budget -= 1
    const absolutePath = join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      if (isSearchableDirectory(entry.name)) {
        subdirectories.push(absolutePath)
      }
      continue
    }
    const icon = entry.isFile() ? describeIcon(entry.name) : null
    if (icon !== null) {
      const distance = relative(scan.rootPath, absolutePath).split(sep).length
      scan.candidates.push({
        absolutePath,
        mediaType: icon.mediaType,
        rank: [...icon.rank, distance],
      })
    }
  }
  return subdirectories.sort()
}

const walk = async (
  scan: Scan,
  directoryPath: string,
  depth: number
): Promise<void> => {
  if (depth > MAX_DEPTH || scan.budget <= 0) {
    return
  }
  for (const subdirectory of visit(
    scan,
    directoryPath,
    await readEntries(directoryPath)
  )) {
    await walk(scan, subdirectory, depth + 1)
  }
}

/**
 * Walks the repository top-down, collecting every file that names itself an
 * icon. Shallower files are ranked ahead of deeper ones so a monorepo's root
 * branding beats a nested package's, and a stable path comparison breaks
 * remaining ties so the same repository always yields the same icon.
 */
const collectCandidates = async (rootPath: string): Promise<Candidate[]> => {
  const scan: Scan = {
    budget: MAX_ENTRIES_SCANNED,
    candidates: [],
    rootPath,
  }
  await walk(scan, rootPath, 0)
  return scan.candidates
}

const inline = async (candidate: Candidate): Promise<string | null> => {
  try {
    const stats = await stat(candidate.absolutePath)
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_ICON_BYTES) {
      return null
    }
    const bytes = await readFile(candidate.absolutePath)
    return `data:${candidate.mediaType};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * Finds the repository's icon and returns it as a `data:` URL, or null when
 * the repository ships none. Total: discovery is a nicety, so no filesystem
 * problem here is ever allowed to fail registering a project.
 */
export const discoverProjectIcon = (
  rootPath: string
): Effect.Effect<string | null> =>
  Effect.promise(async () => {
    const candidates = (await collectCandidates(rootPath)).sort(compareRanks)
    for (const candidate of candidates) {
      const dataUrl = await inline(candidate)
      if (dataUrl !== null) {
        return dataUrl
      }
    }
    return null
  })

/** Exposed so tests can assert the naming rule without duplicating it. */
export const projectIconBaseNames = ICON_BASE_NAMES
