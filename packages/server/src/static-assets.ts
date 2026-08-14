import { existsSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Effect } from 'effect'
import { HttpServerResponse } from 'effect/unstable/http'

const LEADING_SEPARATORS = /^[/\\]+/

export const WEB_DIST_ENV = 'LABORER_WEB_DIST'

export const resolveWebAssetPath = (
  root: string,
  pathname: string
): { readonly path: string; readonly found: boolean } => {
  const resolvedRoot = resolve(root)
  const fallback = join(resolvedRoot, 'index.html')
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { path: fallback, found: false }
  }
  const relative = normalize(decoded).replace(LEADING_SEPARATORS, '')
  const candidate = resolve(resolvedRoot, relative || 'index.html')
  const inside =
    candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${sep}`)
  if (!inside) {
    return { path: fallback, found: false }
  }
  if (existsSync(candidate)) {
    return { path: candidate, found: true }
  }
  return { path: fallback, found: extname(relative) === '' }
}

export const staticAssetResponse = (root: string, requestUrl: string) => {
  const url = new URL(requestUrl, 'http://127.0.0.1')
  const asset = resolveWebAssetPath(root, url.pathname)
  if (!(asset.found && existsSync(asset.path))) {
    return Effect.succeed(HttpServerResponse.text('Not Found', { status: 404 }))
  }
  return HttpServerResponse.file(asset.path)
}
