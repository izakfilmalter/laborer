#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const NIGHTLY_VERSION_PATTERN = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/
const RELEASE_DATE_PATTERN = /^\d{8}$/
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i
const VERSION_CORE_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/
const VERSION_METADATA_PATTERN = /[-+].*$/

interface DesktopPackageJson {
  readonly version?: unknown
}

interface NightlyReleaseMetadata {
  readonly baseVersion: string
  readonly name: string
  readonly shortSha: string
  readonly tag: string
  readonly version: string
}

function resolveNightlyBaseVersion(version: string): string {
  return version.replace(VERSION_METADATA_PATTERN, '')
}

function resolveNightlyTargetVersion(version: string): string {
  const stableCore = resolveNightlyBaseVersion(version)
  const match = VERSION_CORE_PATTERN.exec(stableCore)
  if (!match) {
    throw new Error(`Invalid desktop package version '${version}'.`)
  }

  const [, major, minor, patch] = match
  if (!(major && minor && patch)) {
    throw new Error(`Invalid desktop package version '${version}'.`)
  }

  return `${major}.${minor}.${Number(patch) + 1}`
}

function resolveNightlyReleaseMetadata(args: {
  readonly baseVersion: string
  readonly date: string
  readonly runNumber: number
  readonly sha: string
}): NightlyReleaseMetadata {
  const shortSha = args.sha.slice(0, 12).toLowerCase()
  const version = `${args.baseVersion}-nightly.${args.date}.${String(args.runNumber)}`

  if (!NIGHTLY_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid nightly version '${version}'.`)
  }

  return {
    baseVersion: args.baseVersion,
    version,
    tag: `v${version}`,
    name: `Laborer Nightly ${version} (${shortSha})`,
    shortSha,
  }
}

function readDesktopBaseVersion(rootDir: string): string {
  const packageJsonPath = resolve(rootDir, 'apps/desktop/package.json')
  const packageJson = JSON.parse(
    readFileSync(packageJsonPath, 'utf8')
  ) as DesktopPackageJson

  if (typeof packageJson.version !== 'string') {
    throw new Error(`Missing desktop package version at ${packageJsonPath}.`)
  }

  return resolveNightlyTargetVersion(packageJson.version)
}

function writeOutput(
  metadata: NightlyReleaseMetadata,
  githubOutput: boolean
): void {
  const entries = [
    ['base_version', metadata.baseVersion],
    ['version', metadata.version],
    ['tag', metadata.tag],
    ['name', metadata.name],
    ['short_sha', metadata.shortSha],
  ] as const

  const serialized = entries.map(([key, value]) => `${key}=${value}\n`).join('')

  if (githubOutput) {
    const outputPath = process.env.GITHUB_OUTPUT
    if (!outputPath) {
      throw new Error('GITHUB_OUTPUT is not set.')
    }
    writeFileSync(outputPath, serialized, { flag: 'a' })
    return
  }

  process.stdout.write(serialized)
}

function main(): void {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      'github-output': { type: 'boolean', default: false },
      root: { type: 'string' },
      'run-number': { type: 'string' },
      sha: { type: 'string' },
    },
  })

  const date = values.date
  const runNumber = Number(values['run-number'])
  const sha = values.sha

  if (!(date && RELEASE_DATE_PATTERN.test(date))) {
    throw new Error('Expected --date in YYYYMMDD format.')
  }
  if (!(Number.isInteger(runNumber) && runNumber >= 1)) {
    throw new Error('Expected --run-number to be a positive integer.')
  }
  if (!(sha && SHA_PATTERN.test(sha))) {
    throw new Error('Expected --sha to be a git commit hash.')
  }

  const rootDir = resolve(values.root ?? process.cwd())
  const baseVersion = readDesktopBaseVersion(rootDir)
  const metadata = resolveNightlyReleaseMetadata({
    baseVersion,
    date,
    runNumber,
    sha,
  })

  writeOutput(metadata, values['github-output'])
}

main()
