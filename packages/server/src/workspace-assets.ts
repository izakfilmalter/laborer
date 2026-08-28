// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: asset resolution deliberately keeps every security gate in one auditable path.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { Effect, Schema } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { WorkspaceProvider } from './services/workspace-provider.js'

export const WORKSPACE_ASSET_ROUTE_PREFIX = '/api/workspace-assets'
export const WORKSPACE_ASSET_TTL_MS = 60 * 60 * 1000

const signingKey = randomBytes(32)
const ENTRY_EXTENSION = /\.(?:html?|pdf)$/i
const PATH_SEPARATOR = /[\\/]/
const BYTE_RANGE = /^bytes=(\d*)-(\d*)$/
const SERVED_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.css',
  '.gif',
  '.heic',
  '.heif',
  '.htm',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.jxl',
  '.mjs',
  '.otf',
  '.pdf',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.ttf',
  '.webp',
  '.woff',
  '.woff2',
])
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.jxl': 'image/jxl',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const Claims = Schema.Struct({
  baseRelativePath: Schema.String,
  expiresAt: Schema.Number,
  version: Schema.Literal(1),
  workspaceId: Schema.String,
})
const ClaimsJson = Schema.fromJsonString(Claims)
const decodeClaims = Schema.decodeUnknownOption(ClaimsJson)
const encodeClaims = Schema.encodeSync(ClaimsJson)

const encode = (value: string): string =>
  Buffer.from(value).toString('base64url')
const decode = (value: string): string | null => {
  try {
    return Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    return null
  }
}
const sign = (payload: string, key: Uint8Array = signingKey): string =>
  createHmac('sha256', Buffer.from(key)).update(payload).digest('base64url')

const containedFile = async (
  root: string,
  relativePath: string
): Promise<string | null> => {
  if (isAbsolute(relativePath) || relativePath.includes('\0')) {
    return null
  }
  const canonicalRoot = await realpath(root).catch(() => null)
  const canonicalFile = await realpath(resolve(root, relativePath)).catch(
    () => null
  )
  if (!(canonicalRoot && canonicalFile)) {
    return null
  }
  const inside = relative(canonicalRoot, canonicalFile)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
    return null
  }
  const info = await stat(canonicalFile).catch(() => null)
  return info?.isFile() ? canonicalFile : null
}

export const issueWorkspaceAssetUrl = (
  workspaceProvider: WorkspaceProvider['Service'],
  workspaceId: string,
  relativePath: string,
  options: { readonly key?: Uint8Array; readonly now?: number } = {}
) =>
  Effect.gen(function* () {
    const segments = relativePath.split(PATH_SEPARATOR)
    if (
      !ENTRY_EXTENSION.test(relativePath) ||
      isAbsolute(relativePath) ||
      segments.some((segment) => segment === '.' || segment === '..')
    ) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message: 'Only relative HTML and PDF workspace paths can be previewed.',
      })
    }
    const workspace = yield* workspaceProvider.findWorkspaceForTask(workspaceId)
    if (workspace === null) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: 'Workspace not found.',
      })
    }
    const file = yield* Effect.promise(() =>
      containedFile(workspace.worktreePath, relativePath)
    )
    if (file === null) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: 'Workspace asset not found.',
      })
    }
    const expiresAt = (options.now ?? Date.now()) + WORKSPACE_ASSET_TTL_MS
    const payload = encode(
      encodeClaims({
        baseRelativePath: dirname(relativePath),
        expiresAt,
        version: 1,
        workspaceId,
      })
    )
    const token = `${payload}.${sign(payload, options.key ?? signingKey)}`
    return {
      expiresAt,
      relativeUrl: `${WORKSPACE_ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(basename(relativePath))}`,
    }
  })

export const resolveWorkspaceAsset = (
  workspaceProvider: WorkspaceProvider['Service'],
  token: string,
  encodedPath: string,
  options: { readonly key?: Uint8Array; readonly now?: number } = {}
) =>
  Effect.gen(function* () {
    const [payload, signature, extra] = token.split('.')
    if (!(payload && signature) || extra !== undefined) {
      return null
    }
    const expected = sign(payload, options.key ?? signingKey)
    const actualBytes = Buffer.from(signature)
    const expectedBytes = Buffer.from(expected)
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      return null
    }
    const json = decode(payload)
    if (json === null) {
      return null
    }
    const decoded = decodeClaims(json)
    if (
      decoded._tag === 'None' ||
      decoded.value.expiresAt <= (options.now ?? Date.now())
    ) {
      return null
    }
    const requestedPath = decodeURIComponentSafe(encodedPath)
    if (requestedPath === null) {
      return null
    }
    const segments = requestedPath.split(PATH_SEPARATOR)
    if (
      requestedPath.length === 0 ||
      segments.some(
        (segment) =>
          segment === '.' || segment === '..' || segment.startsWith('.')
      ) ||
      !SERVED_EXTENSIONS.has(extname(requestedPath).toLowerCase())
    ) {
      return null
    }
    const workspace = yield* workspaceProvider.findWorkspaceForTask(
      decoded.value.workspaceId
    )
    if (workspace === null) {
      return null
    }
    const relativePath =
      decoded.value.baseRelativePath === '.'
        ? requestedPath
        : join(decoded.value.baseRelativePath, requestedPath)
    return yield* Effect.promise(() =>
      containedFile(workspace.worktreePath, relativePath)
    )
  }).pipe(Effect.orElseSucceed(() => null))

const decodeURIComponentSafe = (value: string): string | null => {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export const parseWorkspaceAssetRange = (
  header: string | undefined,
  size: number
): [number, number] | null | 'invalid' => {
  if (header === undefined) {
    return null
  }
  const match = BYTE_RANGE.exec(header.trim())
  if (!(match && (match[1] || match[2]))) {
    return 'invalid'
  }
  let start: number
  let end: number
  if (match[1]) {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  } else {
    const suffix = Number(match[2])
    if (!Number.isInteger(suffix) || suffix <= 0) {
      return 'invalid'
    }
    start = Math.max(0, size - suffix)
    end = size - 1
  }
  return Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < size
    ? [start, Math.min(end, size - 1)]
    : 'invalid'
}

export const makeWorkspaceAssetHttpResponse = (input: {
  readonly bytes: Uint8Array
  readonly filePath: string
  readonly method: string
  readonly rangeHeader?: string | undefined
}) => {
  const range = parseWorkspaceAssetRange(
    input.rangeHeader,
    input.bytes.byteLength
  )
  const contentType =
    MIME_TYPES[extname(input.filePath).toLowerCase()] ??
    'application/octet-stream'
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    ...(input.filePath.toLowerCase().endsWith('.svg')
      ? {
          'Content-Security-Policy':
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        }
      : {}),
  }
  if (range === 'invalid') {
    return HttpServerResponse.empty({
      status: 416,
      headers: {
        ...headers,
        'Content-Range': `bytes */${input.bytes.byteLength}`,
      },
    })
  }
  const body =
    range === null ? input.bytes : input.bytes.subarray(range[0], range[1] + 1)
  const responseHeaders = {
    ...headers,
    'Content-Length': String(body.byteLength),
    ...(range === null
      ? {}
      : {
          'Content-Range': `bytes ${range[0]}-${range[1]}/${input.bytes.byteLength}`,
        }),
  }
  if (input.method === 'HEAD') {
    return HttpServerResponse.empty({
      status: range === null ? 200 : 206,
      headers: responseHeaders,
    })
  }
  return HttpServerResponse.uint8Array(body, {
    status: range === null ? 200 : 206,
    headers: responseHeaders,
  })
}

export const workspaceAssetResponse = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const path = request.url.split('?', 1)[0] ?? ''
  const suffix = path.slice(`${WORKSPACE_ASSET_ROUTE_PREFIX}/`.length)
  const slash = suffix.indexOf('/')
  if (slash <= 0) {
    return HttpServerResponse.text('Not Found', { status: 404 })
  }
  const workspaceProvider = yield* WorkspaceProvider
  const file = yield* resolveWorkspaceAsset(
    workspaceProvider,
    suffix.slice(0, slash),
    suffix.slice(slash + 1)
  )
  if (file === null) {
    return HttpServerResponse.text('Not Found', { status: 404 })
  }
  const bytes = yield* Effect.promise(() => readFile(file))
  return makeWorkspaceAssetHttpResponse({
    bytes,
    filePath: file,
    method: request.method,
    rangeHeader: request.headers.range,
  })
})
