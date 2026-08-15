import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('server packaging dependencies', () => {
  it('declares the externalized Parcel watcher as a runtime dependency', async () => {
    const [packageJson, daemonBundle] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../dist/daemon-main.mjs', import.meta.url), 'utf8'),
    ])
    const manifest = JSON.parse(packageJson) as {
      dependencies?: Record<string, string>
    }

    expect(daemonBundle).toContain('import("@parcel/watcher")')
    expect(manifest.dependencies?.['@parcel/watcher']).toBe('^2.5.6')
  })
})
