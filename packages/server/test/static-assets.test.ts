import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWebAssetPath } from '../src/static-assets.js'

describe('daemon static assets', () => {
  it('serves assets and falls back to index for client routes', () => {
    const root = mkdtempSync(join(tmpdir(), 'laborer-assets-'))
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'index.html'), 'index')
    writeFileSync(join(root, 'assets', 'app.js'), 'app')

    expect(resolveWebAssetPath(root, '/assets/app.js')).toEqual({
      found: true,
      path: join(root, 'assets', 'app.js'),
    })
    expect(resolveWebAssetPath(root, '/workspaces/example')).toEqual({
      found: true,
      path: join(root, 'index.html'),
    })
    expect(resolveWebAssetPath(root, '/assets/missing.js').found).toBe(false)
  })

  it('does not allow traversal outside the asset root', () => {
    const root = mkdtempSync(join(tmpdir(), 'laborer-assets-'))
    writeFileSync(join(root, 'index.html'), 'index')
    expect(resolveWebAssetPath(root, '/../secret.txt').found).toBe(false)
  })
})
