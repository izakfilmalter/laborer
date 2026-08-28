import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, describe, it } from '@effect/vitest'
import {
  FilesystemContainmentError,
  readContainedFile,
  writeContainedFile,
} from '../src/lib/filesystem-containment.js'

const roots: string[] = []

const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'laborer-containment-'))
  roots.push(root)
  return root
}

const captureError = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (cause) {
    return cause
  }
  return undefined
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

  it('rejects a relative path that escapes the root', async () => {
    const root = makeRoot()

    const error = await captureError(() =>
      writeContainedFile(root, '../escaped.txt', 'escaped')
    )

    assert.instanceOf(error, FilesystemContainmentError)
    assert.strictEqual(error.reason, 'PATH_TRAVERSAL')
  })

  it('rejects a write addressed at the root itself', async () => {
    const root = makeRoot()

    const error = await captureError(() =>
      writeContainedFile(root, '.', 'escaped')
    )

    assert.instanceOf(error, FilesystemContainmentError)
    assert.strictEqual(error.reason, 'PATH_TRAVERSAL')
  })
})

describe('readContainedFile', () => {
  it('reads a contained file and reports its full byte length', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'file.txt'), 'hello world')

    const contained = await readContainedFile(root, 'file.txt', 5)

    assert.strictEqual(contained.contents.toString('utf8'), 'hello')
    assert.strictEqual(contained.byteLength, 'hello world'.length)
  })

  it('rejects a symlink that resolves outside the root', async () => {
    const root = makeRoot()
    const outside = makeRoot()
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))

    const error = await captureError(() =>
      readContainedFile(root, 'link.txt', 1024)
    )

    assert.instanceOf(error, FilesystemContainmentError)
    assert.strictEqual(error.reason, 'PATH_TRAVERSAL')
  })
})
