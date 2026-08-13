import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

import { protocol } from 'electron'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Custom protocol scheme for serving the frontend in production builds.
 *
 * In production, the renderer loads `laborer://app/index.html` instead
 * of a Vite dev server URL. The scheme is registered as privileged so
 * it behaves like `https://` — relative URL resolution, fetch API
 * support, CORS, and secure context all work as expected.
 */
export const DESKTOP_SCHEME = 'laborer'

/**
 * MIME type lookup for common web file extensions.
 *
 * Covers all file types Vite produces in a typical React/TypeScript build.
 * For unknown extensions, `application/octet-stream` is returned.
 */
/** Regex to strip leading slashes/backslashes from a normalized path. */
const LEADING_SEPARATORS = /^[/\\]+/

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
}

// ---------------------------------------------------------------------------
// Scheme registration (must be called before app.whenReady())
// ---------------------------------------------------------------------------

/**
 * Register the `laborer://` scheme as privileged.
 *
 * **MUST be called synchronously at the top level of the main process,
 * before `app.whenReady()`.** Electron requires privileged schemes to be
 * registered before the app is ready.
 */
export function registerSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])
}

// ---------------------------------------------------------------------------
// Protocol handler
// ---------------------------------------------------------------------------

/** Whether the protocol handler has been registered. */
let protocolRegistered = false

/**
 * Register the `laborer://` file-serving protocol handler.
 *
 * Must be called after `app.whenReady()`. In development, this is a no-op
 * because the renderer loads from the Vite dev server instead.
 *
 * @param staticRoot Absolute path to the built frontend directory
 *   (e.g., `apps/web/dist/`). Must contain an `index.html`.
 */
export function registerDesktopProtocol(staticRoot: string): void {
  if (protocolRegistered) {
    return
  }

  const resolvedRoot = resolve(staticRoot)
  const rootPrefix = `${resolvedRoot}${sep}`
  const fallbackIndex = join(resolvedRoot, 'index.html')

  if (!existsSync(fallbackIndex)) {
    throw new Error(
      `Desktop static bundle missing: ${fallbackIndex} not found. ` +
        'Build the web app first (vite build).'
    )
  }

  protocol.handle(DESKTOP_SCHEME, async (request) => {
    try {
      const filePath = resolveStaticPath(resolvedRoot, request.url)
      const resolved = resolve(filePath)

      // Security: ensure the resolved path is within the static root.
      const isInRoot =
        resolved === fallbackIndex || resolved.startsWith(rootPrefix)

      if (!(isInRoot && existsSync(resolved))) {
        // Asset requests (files with extensions) get a 404.
        // Navigation requests (no extension) get the SPA fallback.
        if (isAssetRequest(request.url)) {
          return new Response('Not Found', { status: 404 })
        }
        return await serveFile(fallbackIndex)
      }

      return await serveFile(resolved)
    } catch {
      // On any error, serve index.html as SPA fallback.
      return await serveFile(fallbackIndex)
    }
  })

  protocolRegistered = true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a request URL to a filesystem path within the static root.
 *
 * Handles:
 * - URL decoding (`%20` -> space)
 * - Path normalization (removes `//`, resolves `.`)
 * - Path traversal protection (`..` -> fallback to index.html)
 * - Root path (`/` or empty) -> `index.html`
 * - Extensionless paths -> check for nested `index.html`, else SPA fallback
 */
export function resolveStaticPath(
  staticRoot: string,
  requestUrl: string
): string {
  const url = new URL(requestUrl)
  const rawPath = decodeURIComponent(url.pathname)
  const normalizedPath = normalize(rawPath).replace(LEADING_SEPARATORS, '')

  // Path traversal protection: if normalized path contains `..`,
  // it's attempting to escape the static root.
  if (normalizedPath.includes('..')) {
    return join(staticRoot, 'index.html')
  }

  const requestedPath =
    normalizedPath.length > 0 ? normalizedPath : 'index.html'
  const resolvedPath = join(staticRoot, requestedPath)

  // If the path has a file extension, serve it directly.
  if (extname(resolvedPath)) {
    return resolvedPath
  }

  // Extensionless path: check for a nested index.html (e.g., /about/ -> /about/index.html).
  const nestedIndex = join(resolvedPath, 'index.html')
  if (existsSync(nestedIndex)) {
    return nestedIndex
  }

  // SPA fallback: return root index.html for client-side routing.
  return join(staticRoot, 'index.html')
}

/**
 * Determine if a request URL is for a static asset (has a file extension).
 *
 * Asset requests that miss get a 404, while navigation requests
 * (extensionless) get the SPA fallback to `index.html`.
 */
export function isAssetRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl)
    return extname(url.pathname).length > 0
  } catch {
    return false
  }
}

/**
 * Read a file from disk and return it as a `Response` with the
 * correct Content-Type header.
 */
/**
 * Look up the MIME content type for a given file extension.
 * Returns `application/octet-stream` for unknown extensions.
 */
export function getMimeType(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] ?? 'application/octet-stream'
}

async function serveFile(filePath: string): Promise<Response> {
  const ext = extname(filePath).toLowerCase()
  const contentType = getMimeType(ext)
  const body = await readFile(filePath)

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(body.byteLength),
    },
  })
}

// ---------------------------------------------------------------------------
// Static root resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the directory containing the built frontend assets.
 *
 * Checks two candidate paths (following t3code's pattern):
 * 1. `apps/web/dist/` — standard Vite output
 * 2. A fallback path relative to the Electron app root
 *
 * Returns `null` if no valid static root is found.
 */
export function resolveStaticRoot(appRoot: string): string | null {
  const candidates = [
    join(appRoot, 'apps', 'web', 'dist'),
    // In packaged app, resources might be at a different relative path.
    join(appRoot, 'web-dist'),
  ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      return candidate
    }
  }

  return null
}
