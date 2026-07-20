import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DESKTOP_SCHEME,
  getMimeType,
  isAssetRequest,
  resolveStaticPath,
  resolveStaticRoot,
} from '../src/protocol.js'

// ---------------------------------------------------------------------------
// Test fixture: a temporary directory mimicking apps/web/dist/
// ---------------------------------------------------------------------------

let tempRoot: string
let staticDir: string

beforeAll(() => {
  tempRoot = join(tmpdir(), `protocol-test-${randomUUID()}`)
  staticDir = join(tempRoot, 'static')

  // Create a minimal Vite-like output directory.
  mkdirSync(join(staticDir, 'assets'), { recursive: true })
  mkdirSync(join(staticDir, 'about'), { recursive: true })

  writeFileSync(join(staticDir, 'index.html'), '<html>root</html>')
  writeFileSync(
    join(staticDir, 'assets', 'main.abc123.js'),
    'console.log("hi")'
  )
  writeFileSync(
    join(staticDir, 'assets', 'style.abc123.css'),
    'body { color: red }'
  )
  writeFileSync(join(staticDir, 'about', 'index.html'), '<html>about</html>')
})

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// DESKTOP_SCHEME
// ---------------------------------------------------------------------------

describe('DESKTOP_SCHEME', () => {
  it('is "laborer"', () => {
    expect(DESKTOP_SCHEME).toBe('laborer')
  })
})

// ---------------------------------------------------------------------------
// getMimeType
// ---------------------------------------------------------------------------

describe('getMimeType', () => {
  it('returns correct type for .html', () => {
    expect(getMimeType('.html')).toBe('text/html; charset=utf-8')
  })

  it('returns correct type for .js', () => {
    expect(getMimeType('.js')).toBe('application/javascript; charset=utf-8')
  })

  it('returns correct type for .css', () => {
    expect(getMimeType('.css')).toBe('text/css; charset=utf-8')
  })

  it('returns correct type for .json', () => {
    expect(getMimeType('.json')).toBe('application/json; charset=utf-8')
  })

  it('returns correct type for .svg', () => {
    expect(getMimeType('.svg')).toBe('image/svg+xml')
  })

  it('returns correct type for .png', () => {
    expect(getMimeType('.png')).toBe('image/png')
  })

  it('returns correct type for .woff2', () => {
    expect(getMimeType('.woff2')).toBe('font/woff2')
  })

  it('returns correct type for .wasm', () => {
    expect(getMimeType('.wasm')).toBe('application/wasm')
  })

  it('returns octet-stream for unknown extensions', () => {
    expect(getMimeType('.xyz')).toBe('application/octet-stream')
  })

  it('is case-insensitive', () => {
    expect(getMimeType('.HTML')).toBe('text/html; charset=utf-8')
    expect(getMimeType('.JS')).toBe('application/javascript; charset=utf-8')
  })
})

// ---------------------------------------------------------------------------
// isAssetRequest
// ---------------------------------------------------------------------------

describe('isAssetRequest', () => {
  it('returns true for a .js file', () => {
    expect(isAssetRequest('laborer://app/assets/main.abc123.js')).toBe(true)
  })

  it('returns true for a .css file', () => {
    expect(isAssetRequest('laborer://app/assets/style.abc123.css')).toBe(true)
  })

  it('returns true for a .png file', () => {
    expect(isAssetRequest('laborer://app/logo.png')).toBe(true)
  })

  it('returns false for an extensionless path', () => {
    expect(isAssetRequest('laborer://app/settings')).toBe(false)
  })

  it('returns false for root path', () => {
    expect(isAssetRequest('laborer://app/')).toBe(false)
  })

  it('returns false for invalid URL', () => {
    expect(isAssetRequest('not a url')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveStaticPath
// ---------------------------------------------------------------------------

describe('resolveStaticPath', () => {
  it('resolves root URL to index.html', () => {
    const result = resolveStaticPath(staticDir, 'laborer://app/')
    expect(result).toBe(join(staticDir, 'index.html'))
  })

  it('resolves empty path to index.html', () => {
    const result = resolveStaticPath(staticDir, 'laborer://app')
    expect(result).toBe(join(staticDir, 'index.html'))
  })

  it('resolves a JS asset path to the file', () => {
    const result = resolveStaticPath(
      staticDir,
      'laborer://app/assets/main.abc123.js'
    )
    expect(result).toBe(join(staticDir, 'assets', 'main.abc123.js'))
  })

  it('resolves a CSS asset path to the file', () => {
    const result = resolveStaticPath(
      staticDir,
      'laborer://app/assets/style.abc123.css'
    )
    expect(result).toBe(join(staticDir, 'assets', 'style.abc123.css'))
  })

  it('resolves a directory with index.html to the nested index', () => {
    const result = resolveStaticPath(staticDir, 'laborer://app/about')
    expect(result).toBe(join(staticDir, 'about', 'index.html'))
  })

  it('falls back to root index.html for unknown extensionless paths (SPA)', () => {
    const result = resolveStaticPath(staticDir, 'laborer://app/settings')
    expect(result).toBe(join(staticDir, 'index.html'))
  })

  it('blocks path traversal with ..', () => {
    const result = resolveStaticPath(
      staticDir,
      'laborer://app/../../../etc/passwd'
    )
    expect(result).toBe(join(staticDir, 'index.html'))
  })

  it('decodes URL-encoded paths', () => {
    const result = resolveStaticPath(
      staticDir,
      'laborer://app/assets/main.abc123.js'
    )
    expect(result).toBe(join(staticDir, 'assets', 'main.abc123.js'))
  })

  it('handles index.html explicitly', () => {
    const result = resolveStaticPath(staticDir, 'laborer://app/index.html')
    expect(result).toBe(join(staticDir, 'index.html'))
  })
})

// ---------------------------------------------------------------------------
// resolveStaticRoot
// ---------------------------------------------------------------------------

describe('resolveStaticRoot', () => {
  it('finds apps/web/dist/ when it contains index.html', () => {
    // Create a temp directory with the expected structure.
    const fakeAppRoot = join(tempRoot, 'app-root')
    const webDist = join(fakeAppRoot, 'apps', 'web', 'dist')
    mkdirSync(webDist, { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<html></html>')

    const result = resolveStaticRoot(fakeAppRoot)
    expect(result).toBe(webDist)
  })

  it('finds web-dist/ fallback when apps/web/dist/ is missing', () => {
    const fakeAppRoot = join(tempRoot, 'app-root-fallback')
    const webDist = join(fakeAppRoot, 'web-dist')
    mkdirSync(webDist, { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<html></html>')

    const result = resolveStaticRoot(fakeAppRoot)
    expect(result).toBe(webDist)
  })

  it('returns null when no static root is found', () => {
    const fakeAppRoot = join(tempRoot, 'empty-root')
    mkdirSync(fakeAppRoot, { recursive: true })

    const result = resolveStaticRoot(fakeAppRoot)
    expect(result).toBeNull()
  })

  it('prefers apps/web/dist/ over web-dist/', () => {
    const fakeAppRoot = join(tempRoot, 'app-root-both')
    const webDist = join(fakeAppRoot, 'apps', 'web', 'dist')
    const webDistFallback = join(fakeAppRoot, 'web-dist')
    mkdirSync(webDist, { recursive: true })
    mkdirSync(webDistFallback, { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<html>primary</html>')
    writeFileSync(join(webDistFallback, 'index.html'), '<html>fallback</html>')

    const result = resolveStaticRoot(fakeAppRoot)
    expect(result).toBe(webDist)
  })
})
