#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const NIGHTLY_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/
const NEWLINE_PATTERN = /\r?\n/

interface NightlyVersion {
  readonly date: number
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly runNumber: number
}

function parseNightlyTag(tag: string): NightlyVersion | undefined {
  const match = NIGHTLY_TAG_PATTERN.exec(tag)
  if (!match) {
    return undefined
  }

  const [, major, minor, patch, date, runNumber] = match
  if (!(major && minor && patch && date && runNumber)) {
    return undefined
  }

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    date: Number(date),
    runNumber: Number(runNumber),
  }
}

function compareNightlyVersions(
  left: NightlyVersion,
  right: NightlyVersion
): number {
  if (left.major !== right.major) {
    return left.major - right.major
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor
  }
  if (left.patch !== right.patch) {
    return left.patch - right.patch
  }
  if (left.date !== right.date) {
    return left.date - right.date
  }
  return left.runNumber - right.runNumber
}

function listGitTags(): string[] {
  const result = spawnSync('git', ['tag', '--list'], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error('Failed to list git tags.')
  }
  return result.stdout
    .split(NEWLINE_PATTERN)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function resolvePreviousNightlyReleaseTag(
  currentTag: string
): string | undefined {
  const current = parseNightlyTag(currentTag)
  if (!current) {
    throw new Error(`Invalid nightly release tag '${currentTag}'.`)
  }

  return listGitTags()
    .map((tag) => ({ tag, parsed: parseNightlyTag(tag) }))
    .filter(
      (
        entry
      ): entry is { readonly parsed: NightlyVersion; readonly tag: string } =>
        entry.parsed !== undefined
    )
    .filter((entry) => compareNightlyVersions(entry.parsed, current) < 0)
    .toSorted((left, right) =>
      compareNightlyVersions(right.parsed, left.parsed)
    )[0]?.tag
}

function writeOutput(
  previousTag: string | undefined,
  githubOutput: boolean
): void {
  const entry = `previous_tag=${previousTag ?? ''}\n`
  if (githubOutput) {
    const outputPath = process.env.GITHUB_OUTPUT
    if (!outputPath) {
      throw new Error('GITHUB_OUTPUT is not set.')
    }
    writeFileSync(outputPath, entry, { flag: 'a' })
    return
  }
  process.stdout.write(entry)
}

function main(): void {
  const { values } = parseArgs({
    options: {
      'current-tag': { type: 'string' },
      'github-output': { type: 'boolean', default: false },
    },
  })

  const currentTag = values['current-tag']
  if (!currentTag) {
    throw new Error('Expected --current-tag.')
  }

  writeOutput(
    resolvePreviousNightlyReleaseTag(currentTag),
    values['github-output']
  )
}

main()
