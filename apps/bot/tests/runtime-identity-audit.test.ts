import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const nextRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(nextRoot, '../..')
const CHAT_DEPENDENCY_REFERENCE =
  /["'](?:chat|@chat-adapter\/slack)(?:\/[^"']*)?["']/
const PROTOTYPE_PATH_REFERENCE = /[/"']prototype[/"']/
const INSTALL_TOOLING_REFERENCE = /oauth\.v2\.access|tailscale/i
const RETIRED_TERMS = [
  /Handler invocation/i,
  /public-reply protocol/i,
  /blue\/green development/i,
  /(?:the|workspace) Runner\b/,
  /Runner's public-output/,
  /work handler/i,
] as const

const filesBelow = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.name !== 'node_modules')
      .map((entry) => {
        const path = resolve(root, entry.name)
        return entry.isDirectory() ? filesBelow(path) : Promise.resolve([path])
      })
  )
  return nested.flat()
}

const authoritativeDocuments = [
  resolve(repositoryRoot, 'CONTEXT.md'),
  resolve(repositoryRoot, 'README.md'),
  resolve(repositoryRoot, 'docs/macos-menu-bar-companion-spec.md'),
  resolve(nextRoot, 'AGENTS.md'),
  resolve(nextRoot, 'README.md'),
  resolve(nextRoot, 'docs/acp-production-cutover.md'),
  resolve(nextRoot, 'docs/acp-runtime-matrix.md'),
  resolve(nextRoot, 'slack-app-manifest.yaml'),
] as const

describe('primary runtime identity audit', () => {
  it('names the primary package and documents the authoritative composition', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(nextRoot, 'package.json'), 'utf8')
    ) as {
      readonly name?: string
      readonly scripts?: Readonly<Record<string, string>>
    }
    const readme = await readFile(resolve(nextRoot, 'README.md'), 'utf8')
    const slackManifest = await readFile(
      resolve(nextRoot, 'slack-app-manifest.yaml'),
      'utf8'
    )

    expect(packageJson.name).toBe('@laborer/bot')
    // The daemon runs no OAuth server. Installation is a standalone operator
    // tool under scripts/, never part of the runtime composition in src/.
    expect(packageJson.scripts?.['slack:install']).toBe(
      'node scripts/slack-install.mjs'
    )
    for (const path of (await filesBelow(resolve(nextRoot, 'src'))).filter(
      (file) => file.endsWith('.ts') || file.endsWith('.tsx')
    )) {
      const source = await readFile(path, 'utf8')
      expect(source, relative(nextRoot, path)).not.toMatch(
        INSTALL_TOOLING_REFERENCE
      )
    }
    for (const required of [
      'chat` + `@chat-adapter/slack',
      'installationProvider',
      'custom SQLite',
      'context.skipped',
      'start:acp-canary',
      'Emulate',
      'Registered Actions',
      'NO_REPLY',
      'com.laborer.daemon',
      'com.laborer.companion',
      'versioned local boundary',
    ]) {
      expect(readme).toContain(required)
    }
    expect(slackManifest).toContain('registered local applications')
  })

  it('keeps Chat dependencies inside the Chat Effect boundary', async () => {
    const sourceRoot = resolve(nextRoot, 'src')
    const sourceFiles = (await filesBelow(sourceRoot)).filter(
      (path) => path.endsWith('.ts') || path.endsWith('.tsx')
    )
    const violations: string[] = []

    for (const path of sourceFiles) {
      const source = await readFile(path, 'utf8')
      const sourcePath = relative(nextRoot, path)
      if (
        !sourcePath.startsWith('src/chat-plane/') &&
        CHAT_DEPENDENCY_REFERENCE.test(source)
      ) {
        violations.push(sourcePath)
      }
      if (
        sourcePath.startsWith('src/prototype/') ||
        PROTOTYPE_PATH_REFERENCE.test(source)
      ) {
        violations.push(sourcePath)
      }
    }

    expect(violations).toEqual([])
  })

  it('does not restore retired Slack-plane source or terminology', async () => {
    const sourceFiles = (await filesBelow(resolve(nextRoot, 'src'))).filter(
      (path) => path.endsWith('.ts') || path.endsWith('.tsx')
    )
    const retiredSourceNames = [
      'development-daemon',
      'native-stream.ts',
      'runner-state.json',
      'slack/normalize.ts',
      'slack/socket-mode.ts',
      'slack-funnel.ts',
    ] as const
    const violations: string[] = []

    for (const path of [...sourceFiles, ...authoritativeDocuments]) {
      const contents = await readFile(path, 'utf8')
      const displayPath = relative(repositoryRoot, path)
      for (const term of RETIRED_TERMS) {
        if (term.test(contents)) {
          violations.push(`${displayPath}: ${term.source}`)
        }
      }
      if (
        sourceFiles.includes(path) &&
        retiredSourceNames.some(
          (name) => displayPath.includes(name) || contents.includes(name)
        )
      ) {
        violations.push(`${displayPath}: retired source path`)
      }
    }

    expect(violations).toEqual([])
  })
})
