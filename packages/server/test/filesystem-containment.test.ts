import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, describe, it } from '@effect/vitest'
import {
  FilesystemContainmentError,
  writeContainedFile,
} from '../src/lib/filesystem-containment.js'

const roots: string[] = []

const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'laborer-containment-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

describe('writeContainedFile', () => {
  it('writes existing files and creates missing directories', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'existing.txt'), 'before')

    await writeContainedFile(root, 'existing.txt', 'after')
    await writeContainedFile(root, 'new/nested/file.txt', 'created')

    assert.strictEqual(
      readFileSync(join(root, 'existing.txt'), 'utf8'),
      'after'
    )
    assert.strictEqual(
      readFileSync(join(root, 'new/nested/file.txt'), 'utf8'),
      'created'
    )
  })

  it('rejects an ancestor swapped to an escaping symlink before mutation', async () => {
    const root = makeRoot()
    const outside = makeRoot()
    mkdirSync(join(root, 'ancestor'))

    let error: unknown
    try {
      await writeContainedFile(root, 'ancestor/created.txt', 'escaped', 0o666, {
        beforeMutation: () => {
          renameSync(join(root, 'ancestor'), join(root, 'original-ancestor'))
          symlinkSync(outside, join(root, 'ancestor'))
        },
      })
    } catch (cause) {
      error = cause
    }

    assert.instanceOf(error, FilesystemContainmentError)
    assert.strictEqual(error.reason, 'PATH_TRAVERSAL')
    assert.isFalse(existsSync(join(outside, 'created.txt')))
    assert.isFalse(existsSync(join(root, 'original-ancestor', 'created.txt')))
  })
})
