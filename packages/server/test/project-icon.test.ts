import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach } from 'vitest'
import { discoverProjectIcon } from '../src/services/project-icon.js'

const directories: string[] = []

const repository = (files: Record<string, string | Uint8Array>): string => {
  const root = mkdtempSync(join(tmpdir(), 'laborer-project-icon-'))
  directories.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, contents)
  }
  return root
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('discoverProjectIcon', () => {
  it.effect('inlines a favicon as a data URL with its media type', () =>
    Effect.gen(function* () {
      const root = repository({ 'public/favicon.svg': '<svg />' })

      const icon = yield* discoverProjectIcon(root)

      assert.strictEqual(
        icon,
        `data:image/svg+xml;base64,${Buffer.from('<svg />').toString('base64')}`
      )
    })
  )

  it.effect('prefers the web-facing scalable icon over a root .ico', () =>
    Effect.gen(function* () {
      const root = repository({
        'favicon.ico': 'root-ico',
        'public/favicon.svg': '<svg />',
      })

      const icon = yield* discoverProjectIcon(root)

      assert.include(icon ?? '', 'image/svg+xml')
    })
  )

  it.effect("finds a monorepo web app's favicon below the root", () =>
    Effect.gen(function* () {
      const root = repository({
        'apps/api/package.json': '{}',
        'apps/web/public/favicon.ico': 'web-ico',
      })

      const icon = yield* discoverProjectIcon(root)

      assert.strictEqual(
        icon,
        `data:image/x-icon;base64,${Buffer.from('web-ico').toString('base64')}`
      )
    })
  )

  it.effect('prefers a shallower icon over one buried deeper', () =>
    Effect.gen(function* () {
      const root = repository({
        'apps/web/public/favicon.ico': 'web-ico',
        'public/favicon.ico': 'root-ico',
      })

      assert.strictEqual(
        yield* discoverProjectIcon(root),
        `data:image/x-icon;base64,${Buffer.from('root-ico').toString('base64')}`
      )
    })
  )

  it.effect('finds an icon wherever the framework puts it', () =>
    Effect.gen(function* () {
      const root = repository({
        'src/frontend/static/img/favicon.png': 'nested-png',
      })

      assert.include(yield* discoverProjectIcon(root) ?? '', 'image/png')
    })
  )

  it.effect("ignores icons belonging to a repository's dependencies", () =>
    Effect.gen(function* () {
      const root = repository({
        'dist/favicon.svg': '<svg />',
        'node_modules/some-package/public/favicon.svg': '<svg />',
      })

      assert.strictEqual(yield* discoverProjectIcon(root), null)
    })
  )

  it.effect('prefers the plain favicon over its sized variants', () =>
    Effect.gen(function* () {
      const root = repository({
        'public/favicon-16x16.png': 'small',
        'public/favicon-32x32.png': 'large',
        'public/favicon.png': 'plain',
      })

      assert.strictEqual(
        yield* discoverProjectIcon(root),
        `data:image/png;base64,${Buffer.from('plain').toString('base64')}`
      )
    })
  )

  it.effect(
    'prefers the largest sized variant when there is no plain one',
    () =>
      Effect.gen(function* () {
        const root = repository({
          'public/favicon-16x16.png': 'small',
          'public/favicon-32x32.png': 'large',
        })

        assert.strictEqual(
          yield* discoverProjectIcon(root),
          `data:image/png;base64,${Buffer.from('large').toString('base64')}`
        )
      })
  )

  it.effect('prefers a favicon over an apple-touch-icon beside it', () =>
    Effect.gen(function* () {
      const root = repository({
        'public/apple-touch-icon.png': 'touch',
        'public/favicon.ico': 'fav',
      })

      assert.strictEqual(
        yield* discoverProjectIcon(root),
        `data:image/x-icon;base64,${Buffer.from('fav').toString('base64')}`
      )
    })
  )

  it.effect('returns null when the repository ships no icon', () =>
    Effect.gen(function* () {
      const root = repository({ 'README.md': '# no icon here' })

      assert.strictEqual(yield* discoverProjectIcon(root), null)
    })
  )

  it.effect('skips an oversized candidate rather than streaming it', () =>
    Effect.gen(function* () {
      const root = repository({
        'public/favicon.png': new Uint8Array(200 * 1024),
      })

      assert.strictEqual(yield* discoverProjectIcon(root), null)
    })
  )

  it.effect('is total for a repository path that does not exist', () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* discoverProjectIcon('/laborer/definitely/not/here'),
        null
      )
    })
  )
})
