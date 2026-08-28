import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'
import { WorkspaceProvider } from '../src/services/workspace-provider.js'
import {
  makeWorkspaceAssetServerLayer,
  WorkspaceAssetServer,
} from '../src/workspace-asset-server.js'
import {
  issueWorkspaceAssetUrl,
  loadWorkspaceAssetSigningKey,
  makeWorkspaceAssetHttpResponse,
  resolveWorkspaceAsset,
} from '../src/workspace-assets.js'

const key = Buffer.alloc(32, 7)
const INDEX_HTML_PATH = /\/site\/index\.html$/
const STYLE_CSS_PATH = /\/site\/style\.css$/
const ASSET_ORIGIN_PATH =
  /^http:\/\/127\.0\.0\.1:43210\/api\/workspace-assets\//

describe('workspace assets', () => {
  it.effect(
    'mints scoped URLs and denies traversal, symlink escape, and stale workspaces',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), 'laborer-assets-'))),
        (root) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await mkdir(join(root, 'site'))
              await writeFile(
                join(root, 'site', 'index.html'),
                '<link href="style.css">'
              )
              await writeFile(join(root, 'site', 'style.css'), 'body{}')
              await writeFile(join(root, 'document.pdf'), 'pdf-data')
              await symlink('/etc/hosts', join(root, 'site', 'escape.css'))
            })
            let available = true
            const provider = {
              findWorkspaceForTask: () =>
                Effect.succeed(
                  available ? ({ worktreePath: root } as never) : null
                ),
            } as unknown as WorkspaceProvider['Service']
            const issued = yield* issueWorkspaceAssetUrl(
              provider,
              'workspace-1',
              'site/index.html',
              'http://127.0.0.1:43210',
              { key, now: 1000 }
            )
            const suffix = new URL(issued.relativeUrl).pathname.slice(
              '/api/workspace-assets/'.length
            )
            const slash = suffix.indexOf('/')
            const token = suffix.slice(0, slash)

            expect(issued.relativeUrl).toMatch(ASSET_ORIGIN_PATH)

            expect(
              yield* resolveWorkspaceAsset(provider, token, 'index.html', {
                key,
                now: 1001,
              })
            ).toMatch(INDEX_HTML_PATH)
            expect(
              yield* resolveWorkspaceAsset(provider, token, 'style.css', {
                key,
                now: 1001,
              })
            ).toMatch(STYLE_CSS_PATH)
            expect(
              yield* resolveWorkspaceAsset(
                provider,
                token,
                '..%2Fdocument.pdf',
                {
                  key,
                  now: 1001,
                }
              )
            ).toBeNull()
            expect(
              yield* resolveWorkspaceAsset(provider, token, 'escape.css', {
                key,
                now: 1001,
              })
            ).toBeNull()

            available = false
            expect(
              yield* resolveWorkspaceAsset(provider, token, 'index.html', {
                key,
                now: 1001,
              })
            ).toBeNull()
            const missing = yield* Effect.exit(
              issueWorkspaceAssetUrl(
                provider,
                'workspace-1',
                'site/index.html',
                'http://127.0.0.1:43210',
                {
                  key,
                  now: 1000,
                }
              )
            )
            expect(Exit.isFailure(missing)).toBe(true)
          }),
        (root) =>
          Effect.promise(() => rm(root, { recursive: true, force: true }))
      )
  )

  it('serves GET, HEAD, ranges, MIME, cache, and unsatisfiable ranges', () => {
    const bytes = new TextEncoder().encode('0123456789')
    const get = makeWorkspaceAssetHttpResponse({
      bytes,
      filePath: '/workspace/index.html',
      method: 'GET',
    })
    expect(get.status).toBe(200)
    expect(get.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(get.headers['cache-control']).toBe('private, max-age=3600')
    expect(get.headers['content-length']).toBe('10')

    const head = makeWorkspaceAssetHttpResponse({
      bytes,
      filePath: '/workspace/document.pdf',
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    expect(head.headers['content-type']).toBe('application/pdf')
    expect(head.body._tag).toBe('Empty')

    const range = makeWorkspaceAssetHttpResponse({
      bytes,
      filePath: '/workspace/document.pdf',
      method: 'GET',
      rangeHeader: 'bytes=2-5',
    })
    expect(range.status).toBe(206)
    expect(range.headers['content-range']).toBe('bytes 2-5/10')
    expect(range.headers['content-length']).toBe('4')
    expect(range.body._tag).toBe('Uint8Array')
    if (range.body._tag === 'Uint8Array') {
      expect(new TextDecoder().decode(range.body.body)).toBe('2345')
    }

    const invalid = makeWorkspaceAssetHttpResponse({
      bytes,
      filePath: '/workspace/document.pdf',
      method: 'GET',
      rangeHeader: 'bytes=20-30',
    })
    expect(invalid.status).toBe(416)
    expect(invalid.headers['content-range']).toBe('bytes */10')
  })

  it('reuses the persisted signing key across fresh daemon loads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laborer-asset-key-'))
    try {
      const path = join(root, 'workspace-asset-signing-key')
      const first = await loadWorkspaceAssetSigningKey(path)
      const afterRestart = await loadWorkspaceAssetSigningKey(path)
      expect(first).toHaveLength(32)
      expect(Buffer.from(afterRestart)).toEqual(Buffer.from(first))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('owns a separate scoped listener and tears it down on finalization', async () => {
    const provider = Layer.succeed(WorkspaceProvider, {
      findWorkspaceForTask: () => Effect.succeed(null),
    } as unknown as WorkspaceProvider['Service'])
    const listener = makeWorkspaceAssetServerLayer(0).pipe(
      Layer.provide(provider)
    )
    let origin = ''
    await Effect.runPromise(
      Effect.gen(function* () {
        const assetServer = yield* WorkspaceAssetServer
        origin = assetServer.origin
        const response = yield* Effect.promise(() =>
          fetch(`${assetServer.origin}/api/workspace-assets/malformed`)
        )
        expect(response.status).toBe(404)
      }).pipe(Effect.provide(listener), Effect.scoped)
    )

    await expect(
      fetch(`${origin}/api/workspace-assets/malformed`, {
        signal: AbortSignal.timeout(500),
      })
    ).rejects.toThrow()
  })
})
