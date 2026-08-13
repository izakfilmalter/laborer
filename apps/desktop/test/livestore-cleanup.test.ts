import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupLiveStoreTargets,
  enumerateLiveStoreCleanupTargets,
} from '../src/livestore-cleanup.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

describe('LiveStore cleanup', () => {
  it('enumerates historical server stores, sync files, and renderer OPFS', () => {
    const targets = enumerateLiveStoreCleanupTargets({
      environment: {},
      homeDirectory: '/Users/tester',
      platform: 'darwin',
    })
    const paths = targets.map((target) => target.path)

    expect(paths).toContain('/Users/tester/.config/laborer/data/laborer')
    expect(paths).toContain(
      '/Users/tester/Library/Application Support/data/sync-laborer.db-wal'
    )
    expect(paths).toContain(
      '/Users/tester/Library/Application Support/com.izakfilmalter.laborer/data/laborer'
    )
    expect(paths).toContain(
      '/Users/tester/Library/Application Support/Laborer/File System'
    )
    expect(paths).not.toContain(
      '/Users/tester/Library/Application Support/Laborer'
    )
  })

  it('ignores relative XDG paths and uses the Linux home fallback', () => {
    const targets = enumerateLiveStoreCleanupTargets({
      environment: { DATA_DIR: 'relative-data', XDG_CONFIG_HOME: 'relative' },
      homeDirectory: '/home/tester',
      platform: 'linux',
    })
    const paths = targets.map((target) => target.path)

    expect(paths).toContain('/home/tester/.config/laborer/data/laborer')
    expect(paths).toContain('/home/tester/.config/Laborer/File System')
    expect(paths.every((path) => path.startsWith('/home/tester/'))).toBe(true)
  })

  it('defaults to observation and removes only explicit targets on request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laborer-livestore-cleanup-'))
    temporaryDirectories.push(root)
    const obsoleteDirectory = join(root, 'laborer')
    const retainedFile = join(root, 'laborer.sqlite')
    mkdirSync(obsoleteDirectory)
    writeFileSync(join(obsoleteDirectory, 'eventlog@6.db'), 'old')
    writeFileSync(retainedFile, 'shared database')
    const targets = [{ kind: 'server-store' as const, path: obsoleteDirectory }]

    cleanupLiveStoreTargets(targets, { deleteFiles: false })
    expect(existsSync(obsoleteDirectory)).toBe(true)

    cleanupLiveStoreTargets(targets, { deleteFiles: true })
    expect(existsSync(obsoleteDirectory)).toBe(false)
    expect(existsSync(retainedFile)).toBe(true)
  })
})
