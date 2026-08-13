#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const RELEASE_PACKAGE_FILES = [
  'apps/desktop/package.json',
  'apps/web/package.json',
  'packages/config/package.json',
  'packages/env/package.json',
  'packages/file-watcher/package.json',
  'packages/server/package.json',
  'packages/shared/package.json',
  'packages/terminal/package.json',
] as const

interface PackageJsonWithVersion {
  readonly version?: unknown
  readonly [key: string]: unknown
}

function updatePackageVersion(filePath: string, version: string): boolean {
  const raw = readFileSync(filePath, 'utf8')
  const packageJson = JSON.parse(raw) as PackageJsonWithVersion

  if (packageJson.version === version) {
    return false
  }

  writeFileSync(
    filePath,
    `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`
  )
  return true
}

function writeGithubOutput(changed: boolean): void {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) {
    throw new Error('GITHUB_OUTPUT is not set.')
  }
  writeFileSync(outputPath, `changed=${String(changed)}\n`, { flag: 'a' })
}

function main(): void {
  const { positionals, values } = parseArgs({
    options: {
      'github-output': { type: 'boolean', default: false },
      root: { type: 'string' },
    },
    allowPositionals: true,
  })

  const version = positionals[0]
  if (!version) {
    throw new Error('Usage: update-release-package-versions <version>')
  }

  const rootDir = resolve(values.root ?? process.cwd())
  let changed = false

  for (const relativePath of RELEASE_PACKAGE_FILES) {
    changed =
      updatePackageVersion(resolve(rootDir, relativePath), version) || changed
  }

  if (values['github-output']) {
    writeGithubOutput(changed)
  } else if (!changed) {
    console.info('All package.json versions already match release version.')
  }
}

main()
