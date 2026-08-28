import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import type { WorkspaceProvider } from '../src/services/workspace-provider.js'
import {
  issueWorkspaceAssetUrl,
  makeWorkspaceAssetHttpResponse,
  resolveWorkspaceAsset,
} from '../src/workspace-assets.js'

const key = Buffer.alloc(32, 7)
const INDEX_HTML_PATH = /\/site\/index\.html$/
const STYLE_CSS_PATH = /\/site\/style\.css$/

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
              { key, now: 1000 }
            )
            const suffix = issued.relativeUrl.slice(
              '/api/workspace-assets/'.length
            )
            const slash = suffix.indexOf('/')
            const token = suffix.slice(0, slash)

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
})
