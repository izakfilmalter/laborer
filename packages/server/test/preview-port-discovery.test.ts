import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Layer, Scope } from 'effect'
import {
  normalizeConfiguredPreviewUrls,
  PreviewDiscoveryPlatform,
  PreviewPortDiscovery,
  parsePreviewLsofListeners,
} from '../src/services/preview-port-discovery.js'

const requested: string[] = []

const TestPlatform = Layer.succeed(PreviewDiscoveryPlatform, {
  listeners: (workspaceRoot) =>
    Effect.succeed(
      workspaceRoot === '/workspace/a'
        ? [
            {
              host: 'localhost',
              pid: 42,
              port: 5173,
              processName: 'vite',
            },
          ]
        : []
    ),
  probeWebDocument: (url) =>
    Effect.sync(() => {
      requested.push(url)
      return (
        url === 'http://localhost:5173' || url === 'http://localhost:43124/docs'
      )
    }),
})

const TestDiscovery = PreviewPortDiscovery.layer.pipe(
  Layer.provide(TestPlatform)
)

describe('PreviewPortDiscovery', () => {
  it.effect(
    'discovers only listeners attributed to the requested workspace',
    () =>
      Effect.gen(function* () {
        requested.length = 0
        const discovery = yield* PreviewPortDiscovery
        const first = yield* discovery.scan('/workspace/a')
        const second = yield* discovery.scan('/workspace/b')

        expect(first).toEqual([
          {
            host: 'localhost',
            pid: 42,
            port: 5173,
            processName: 'vite',
            terminal: null,
            url: 'http://localhost:5173',
          },
        ])
        expect(second).toEqual([])
      }).pipe(Effect.provide(TestDiscovery))
  )

  it.effect(
    'probes bounded configured loopback URLs and rejects public URLs',
    () =>
      Effect.gen(function* () {
        requested.length = 0
        const discovery = yield* PreviewPortDiscovery
        const servers = yield* discovery.scan('/workspace/b', [
          'https://example.com/',
          'ws://localhost:43124/',
          'http://0.0.0.0:43124/docs',
        ])

        expect(servers).toEqual([
          {
            host: 'localhost',
            pid: null,
            port: 43_124,
            processName: null,
            terminal: null,
            url: 'http://localhost:43124/docs',
          },
        ])
        expect(requested).toEqual(['http://localhost:43124/docs'])
      }).pipe(Effect.provide(TestDiscovery))
  )

  it('preserves explicit IPv4 and IPv6 loopback URLs', () => {
    const urls = normalizeConfiguredPreviewUrls([
      'https://127.0.0.1:43125/docs',
      'http://[::1]:43126/docs',
    ])

    expect(urls).toEqual([
      'https://127.0.0.1:43125/docs',
      'http://[::1]:43126/docs',
    ])
  })

  it.effect(
    'broadcasts the current snapshot when the first retainer arrives',
    () =>
      Effect.gen(function* () {
        const discovery = yield* PreviewPortDiscovery
        const snapshots: number[][] = []
        yield* discovery.subscribe(
          {
            configuredUrls: [],
            initialSnapshot: [],
            workspaceRoot: '/workspace/a',
          },
          (servers) =>
            Effect.sync(() => {
              snapshots.push(servers.map(({ port }) => port))
            })
        )

        yield* discovery.retain

        expect(snapshots).toEqual([[5173]])
      }).pipe(Effect.scoped, Effect.provide(TestDiscovery))
  )

  it.effect('removes a subscription when its scope closes', () =>
    Effect.gen(function* () {
      const discovery = yield* PreviewPortDiscovery
      const scope = yield* Scope.make()
      const snapshots: number[] = []
      yield* discovery
        .subscribe(
          {
            configuredUrls: [],
            initialSnapshot: [],
            workspaceRoot: '/workspace/a',
          },
          (servers) =>
            Effect.sync(() => {
              snapshots.push(servers.length)
            })
        )
        .pipe(Effect.provideService(Scope.Scope, scope))
      yield* Scope.close(scope, Exit.void)

      // Closing an already removed subscriber is safe and cannot resurrect it.
      expect(snapshots).toEqual([])
    }).pipe(Effect.provide(TestDiscovery))
  )
})

describe('preview discovery parsing', () => {
  it('decodes lsof listeners and ignores non-loopback endpoints', () => {
    expect(
      parsePreviewLsofListeners(
        'p42\ncvite\nn*:5173\np43\ncpostgres\nn192.168.1.2:5432\n'
      )
    ).toEqual([
      {
        host: 'localhost',
        pid: 42,
        port: 5173,
        processName: 'vite',
      },
    ])
  })

  it('normalizes, deduplicates, and filters configured candidates', () => {
    expect(
      normalizeConfiguredPreviewUrls([
        'http://0.0.0.0:3000/',
        'http://localhost:3000/',
        'https://example.com/',
      ])
    ).toEqual(['http://localhost:3000/'])
  })
})
