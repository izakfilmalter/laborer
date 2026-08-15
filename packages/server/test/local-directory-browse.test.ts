import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { listLocalDirectories } from '../src/rpc/handlers.js'

describe('local directory browse', () => {
  it.effect(
    'returns only daemon-host directories with canonical navigation paths',
    () =>
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'laborer-directory-browse-'))
        const child = join(root, 'project')
        const linked = join(root, 'linked-project')
        mkdirSync(child)
        writeFileSync(join(root, 'notes.txt'), 'not a directory')
        symlinkSync(child, linked)

        try {
          const result = yield* listLocalDirectories(root)
          assert.strictEqual(result.path, realpathSync(root))
          assert.deepEqual(
            result.directories.map(({ name }) => name),
            ['linked-project', 'project']
          )
          assert.isFalse(
            result.directories.some(({ name }) => name === 'notes.txt')
          )
          assert.isFalse(result.truncated)
        } finally {
          rmSync(root, { force: true, recursive: true })
        }
      })
  )

  it.effect('returns a typed failure for an unreadable or missing path', () =>
    listLocalDirectories('/path/that/does/not/exist').pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          assert.strictEqual(error._tag, 'RpcError')
          assert.strictEqual(error.code, 'DIRECTORY_BROWSE_FAILED')
        })
      )
    )
  )

  it.effect('bounds the number of directory entries inspected', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), 'laborer-directory-browse-'))
      for (let index = 0; index <= 1000; index += 1) {
        writeFileSync(
          join(root, `file-${index.toString().padStart(4, '0')}`),
          ''
        )
      }

      try {
        const result = yield* listLocalDirectories(root)
        assert.isTrue(result.truncated)
        assert.deepEqual(result.directories, [])
      } finally {
        rmSync(root, { force: true, recursive: true })
      }
    })
  )
})
