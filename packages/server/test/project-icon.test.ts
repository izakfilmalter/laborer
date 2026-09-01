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
