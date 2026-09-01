/**
 * Discovers a project's own icon by finding a favicon in its repository.
 *
 * A repository already declares how it wants to be recognised — the favicon it
 * ships to its users — so mission control reuses that rather than inventing a
 * second identity. The file is inlined as a `data:` URL because the renderer
 * has no route to arbitrary local paths, and a favicon is small enough that
 * carrying the bytes costs less than building one.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'

/**
 * Relative paths searched in order, best-looking first.
 *
 * Scalable and multi-resolution sources beat a 16px `.ico`, and an explicitly
 * web-facing directory beats the repository root, so the first hit is also
 * the one that renders best at the sizes mission control draws.
 */
const ICON_CANDIDATES = [
  'public/favicon.svg',
  'public/icon.svg',
  'public/logo.svg',
  'public/apple-touch-icon.png',
  'public/favicon-32x32.png',
  'public/favicon.png',
  'public/icon.png',
  'public/logo.png',
  'public/favicon.ico',
  'static/favicon.svg',
  'static/favicon.png',
  'static/favicon.ico',
  'app/favicon.svg',
  'app/favicon.png',
  'app/favicon.ico',
  'src/app/favicon.ico',
  'assets/favicon.svg',
  'assets/favicon.png',
  'assets/icon.png',
  'src/assets/favicon.svg',
  'src/assets/favicon.png',
  'resources/icon.png',
  'build/icon.png',
  'favicon.svg',
  'favicon.png',
  'favicon.ico',
  'icon.png',
  'logo.png',
] as const

const MEDIA_TYPES: Record<string, string> = {
  ico: 'image/x-icon',
  png: 'image/png',
  svg: 'image/svg+xml',
}

/**
 * Size bound. Every icon travels inside the project row on every shared-state
 * snapshot, so an oversized "favicon" is skipped rather than allowed to bloat
 * the stream; the next candidate, or no icon at all, is the better outcome.
 */
const MAX_ICON_BYTES = 128 * 1024

const mediaTypeFor = (path: string): string | undefined =>
  MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]

const readCandidate = (
  rootPath: string,
  relativePath: string
): Effect.Effect<string | null> =>
  Effect.promise(async () => {
    const mediaType = mediaTypeFor(relativePath)
    if (mediaType === undefined) {
      return null
    }
    const absolutePath = join(rootPath, relativePath)
    try {
      const stats = await stat(absolutePath)
      if (!stats.isFile() || stats.size === 0 || stats.size > MAX_ICON_BYTES) {
        return null
      }
      const bytes = await readFile(absolutePath)
      return `data:${mediaType};base64,${bytes.toString('base64')}`
    } catch {
      // A missing or unreadable candidate is the common case, not a failure.
      return null
    }
  })

/**
 * Finds the repository's favicon and returns it as a `data:` URL, or null when
 * the repository ships none. Total: discovery is a nicety, so no filesystem
 * problem here is ever allowed to fail registering a project.
 */
export const discoverProjectIcon = (
  rootPath: string
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    for (const candidate of ICON_CANDIDATES) {
      const dataUrl = yield* readCandidate(rootPath, candidate)
      if (dataUrl !== null) {
        return dataUrl
      }
    }
    return null
  })

/** Exposed so tests can assert the search order without duplicating it. */
export const projectIconCandidates = ICON_CANDIDATES
