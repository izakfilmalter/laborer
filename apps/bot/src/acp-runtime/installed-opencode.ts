import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, resolve, sep } from 'node:path'

/** Overrides PATH discovery with an explicit OpenCode 2 executable. */
export const OPEN_CODE_COMMAND_VARIABLE = 'LABORER_OPENCODE_COMMAND'

const CANDIDATE_NAMES = ['opencode', 'opencode2'] as const
const VERSION_TIMEOUT_MILLIS = 15_000
const VERSION_PATTERN = /(?:^|[\s/v])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/
const MAJOR_VERSION_PATTERN = /^(\d+)\.\d+\.\d+/

export interface InstalledOpenCode {
  readonly command: string
  readonly version: string
}

/**
 * Laborer drives OpenCode through its v2 HTTP API (`serve --stdio`). Stable
 * 2.x releases and `0.0.0-*` preview builds expose it; 1.x does not.
 */
export const isSupportedOpenCodeVersion = (version: string): boolean => {
  const match = MAJOR_VERSION_PATTERN.exec(version)
  if (match === null) {
    return false
  }
  return Number(match[1]) >= 2 || version.startsWith('0.0.0-')
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const readVersion = (command: string): string | null => {
  try {
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: VERSION_TIMEOUT_MILLIS,
    })
    return VERSION_PATTERN.exec(output)?.[1] ?? null
  } catch {
    return null
  }
}

const cache = new Map<string, InstalledOpenCode>()

/**
 * Resolves the OpenCode 2 installed on this machine, so Laborer runs the same
 * OpenCode (configuration, providers, and credentials) as the operator.
 */
export const resolveInstalledOpenCode = (
  environment: NodeJS.ProcessEnv = process.env
): InstalledOpenCode => {
  const override = environment[OPEN_CODE_COMMAND_VARIABLE]?.trim()
  const searchPath = environment.PATH ?? ''
  const key = `${override ?? ''}\0${searchPath}`
  const cached = cache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const candidates =
    override !== undefined && override.length > 0
      ? [override]
      : searchPath
          .split(delimiter)
          // Package runners prepend project `node_modules/.bin`; a package's
          // bundled OpenCode is not the machine's installation.
          .filter(
            (directory) =>
              isAbsolute(directory) &&
              !`${directory}${sep}`.includes(`${sep}node_modules${sep}`)
          )
          .flatMap((directory) =>
            CANDIDATE_NAMES.map((name) => resolve(directory, name))
          )
  const rejected: string[] = []
  for (const command of candidates) {
    if (!isExecutable(command)) {
      continue
    }
    const version = readVersion(command)
    if (version !== null && isSupportedOpenCodeVersion(version)) {
      const installed = { command, version }
      cache.set(key, installed)
      return installed
    }
    rejected.push(`${command} (${version ?? 'unknown version'})`)
  }
  throw new Error(
    [
      override !== undefined && override.length > 0
        ? `${OPEN_CODE_COMMAND_VARIABLE} does not point to OpenCode 2.`
        : 'OpenCode 2 was not found on PATH.',
      ...(rejected.length === 0 ? [] : [`Rejected: ${rejected.join(', ')}`]),
      `Install OpenCode 2 or set ${OPEN_CODE_COMMAND_VARIABLE}.`,
    ].join(' ')
  )
}
