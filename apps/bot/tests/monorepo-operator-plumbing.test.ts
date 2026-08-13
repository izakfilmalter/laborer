import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { repositoryRootFromAcpRuntimeModule } from '../src/acp-runtime/repository-root.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '../..')

describe('merged monorepo operator plumbing', () => {
  it('derives the repository root for the source-based ACP canary', () => {
    const canaryModule = new URL('../src/acp-runtime/live.ts', import.meta.url)
      .href

    expect(repositoryRootFromAcpRuntimeModule(canaryModule)).toBe(
      repositoryRoot
    )
  })

  it('keeps one root laborer.json with flattened commands', async () => {
    const config = JSON.parse(
      await readFile(resolve(repositoryRoot, 'laborer.json'), 'utf8')
    ) as {
      devServer: { startCommand: string }
      setupScripts: string[]
    }

    expect(config.devServer.startCommand).toBe('bun run dev')
    expect(config.setupScripts).toEqual([
      'sh ./scripts/worktree-setup.sh --no-ports',
    ])
    await expect(
      readFile(resolve(packageRoot, 'laborer.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const packager = await readFile(
      resolve(packageRoot, 'src/companion/package-macos.ts'),
      'utf8'
    )
    expect(packager).toContain("resolve(repositoryRoot, 'laborer.json')")
    const launcher = await readFile(
      resolve(packageRoot, 'src/companion/native/laborer-daemon'),
      'utf8'
    )
    expect(launcher).toContain('cd "$DAEMON/app"')
  })

  it('loads every bot process from the root env file', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    for (const name of [
      'dev:slack',
      'start:acp-canary',
      'start:chat-canary',
      'start:slack',
    ]) {
      expect(manifest.scripts[name]).toContain(
        '--env-file-if-exists=../../.env.local'
      )
    }
  })
})
