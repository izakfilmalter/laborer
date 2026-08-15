#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  EnsureConflictError,
  processExists,
  readDaemonRegistration,
  stopWithEscalation,
} from '@laborer/ensure'
import { config as loadDotEnv } from 'dotenv'

import { DEV_TERMINAL_XDG_STATE_HOME } from '../packages/server/src/services/terminal-spawn-environment'

export const BASE_DAEMON_PORT = 2100
export const BASE_WEB_PORT = 2101
export const MAX_HASH_OFFSET = 3000
export const MAX_PORT = 65_535
export const WORKTREE_STATE_DIRECTORY = '.laborer-state'
const LINE_BREAK = /\r?\n/
const PATH_SEPARATOR = /[\\/]/

type PortAvailabilityCheck = (port: number) => Promise<boolean>

export interface DevPorts {
  readonly daemonPort: number
  readonly webPort: number
}

// Effect Hash.string's djb2 variant, copied here because the root runner must
// execute before workspace-package module resolution is available.
const hashString = (value: string): number => {
  let hash = 5381
  let index = value.length
  while (index) {
    // biome-ignore lint/suspicious/noBitwiseOperators: t3-compatible allocation hash
    hash = (hash * 33) ^ value.charCodeAt(--index)
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Effect Hash.optimize compatibility
  return (hash & 0xbf_ff_ff_ff) | ((hash >>> 1) & 0x40_00_00_00)
}

export const worktreePortOffset = (worktreePath: string): number => {
  // biome-ignore lint/suspicious/noBitwiseOperators: t3-compatible unsigned allocation seed
  const unsignedHash = hashString(resolve(worktreePath)) >>> 0
  return (unsignedHash % MAX_HASH_OFFSET) + 1
}

export const portPairForOffset = (offset: number): DevPorts => ({
  daemonPort: BASE_DAEMON_PORT + offset,
  webPort: BASE_WEB_PORT + offset,
})

const canListenOnHost = (port: number, host: string): Promise<boolean> =>
  new Promise((complete) => {
    const server = createServer()
    server.unref()
    server.once('error', () => complete(false))
    server.listen({ host, port }, () => {
      server.close(() => complete(true))
    })
  })

export const canListenOnLoopback = async (port: number): Promise<boolean> => {
  const available = await Promise.all([
    canListenOnHost(port, '127.0.0.1'),
    canListenOnHost(port, '::1'),
  ])
  return available.every(Boolean)
}

export const findAvailableDevPorts = async (
  startOffset: number,
  checkPort: PortAvailabilityCheck = canListenOnLoopback
): Promise<DevPorts> => {
  for (let offset = startOffset; ; offset += 1) {
    const ports = portPairForOffset(offset)
    if (ports.daemonPort > MAX_PORT || ports.webPort > MAX_PORT) {
      throw new Error(
        `No daemon and web port pair is available from offset ${String(startOffset)}`
      )
    }
    const [daemonAvailable, webAvailable] = await Promise.all([
      checkPort(ports.daemonPort),
      checkPort(ports.webPort),
    ])
    if (daemonAvailable && webAvailable) {
      return ports
    }
  }
}

/**
 * A linked worktree has a .git file pointing into the common repository's
 * worktrees directory. Main checkouts deliberately return undefined so their
 * ambient XDG state remains available for explicit daily-driver development.
 */
export const linkedWorktreeStateHome = (
  worktreePath: string
): string | undefined => {
  const gitPath = join(worktreePath, '.git')
  if (!(existsSync(gitPath) && statSync(gitPath).isFile())) {
    return undefined
  }
  const gitDirectory = readFileSync(gitPath, 'utf8')
    .split(LINE_BREAK)
    .find((line) => line.trim().startsWith('gitdir:'))
    ?.slice('gitdir:'.length)
    .trim()
  if (!gitDirectory) {
    return undefined
  }
  const segments = resolve(worktreePath, gitDirectory)
    .split(PATH_SEPARATOR)
    .filter(Boolean)
  if (segments.length < 3 || segments.at(-2) !== 'worktrees') {
    return undefined
  }
  return join(worktreePath, WORKTREE_STATE_DIRECTORY)
}

export const resolveDevStateHome = ({
  explicitStateHome,
  worktreeStateHome,
  ambientStateHome,
}: {
  readonly explicitStateHome?: string | undefined
  readonly worktreeStateHome?: string | undefined
  readonly ambientStateHome?: string | undefined
}): string | undefined =>
  (explicitStateHome?.trim() || undefined) ??
  worktreeStateHome ??
  (ambientStateHome?.trim() || undefined)

interface DevRunnerArguments {
  readonly desktop: boolean
  readonly dryRun: boolean
  readonly stateHome?: string
  readonly useRealState: boolean
}

export const parseDevRunnerArguments = (
  arguments_: readonly string[]
): DevRunnerArguments => {
  let stateHome: string | undefined
  let useRealState = false
  let dryRun = false
  let desktop = false
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--state-home') {
      const value = arguments_[index + 1]?.trim()
      if (!value || value.startsWith('--')) {
        throw new Error('--state-home requires a path')
      }
      stateHome = resolve(value)
      index += 1
    } else if (argument === '--use-real-state') {
      useRealState = true
    } else if (argument === '--dry-run') {
      dryRun = true
    } else if (argument === '--desktop') {
      desktop = true
    } else if (argument === '--help' || argument === '-h') {
      console.log(`Usage: bun dev [--desktop] [--state-home PATH | --use-real-state] [--dry-run]

  --desktop          Launch the Electron client alongside the web dev server
  --state-home PATH  Use an explicit XDG state home (highest precedence)
  --use-real-state   Opt in to ambient XDG state instead of worktree state
  --dry-run          Print the resolved environment without spawning processes`)
      process.exit(0)
    } else {
      throw new Error(`Unknown dev-runner argument: ${argument}`)
    }
  }
  if (stateHome && useRealState) {
    throw new Error('--state-home and --use-real-state cannot be combined')
  }
  return { desktop, stateHome, useRealState, dryRun }
}

interface ChildDefinition {
  readonly command: readonly string[]
  readonly cwd: string
  readonly label: string
}

interface RunningDevChild {
  readonly definition: ChildDefinition
  readonly process: {
    readonly exited: Promise<number>
    kill(signal?: NodeJS.Signals | number): unknown
  }
}

export const resolveDevDaemonRegistrationPath = (
  stateHome: string | undefined
): string =>
  join(
    stateHome ?? join(homedir(), '.local', 'state'),
    'laborer',
    'daemon.json'
  )

export const probeDaemonHealth = async (url: string): Promise<boolean> =>
  fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) }).then(
    () => true,
    () => false
  )

export const assertNoDevIncumbent = async (
  registrationPath: string
): Promise<void> => {
  const registration = readDaemonRegistration(registrationPath)
  if (
    registration !== null &&
    processExists(registration.pid) &&
    (await probeDaemonHealth(registration.url))
  ) {
    throw new EnsureConflictError(registration)
  }
}

export const shutdownDevDaemon = async (
  registrationPath: string
): Promise<void> => {
  const registration = readDaemonRegistration(registrationPath)
  if (registration === null) {
    return
  }
  await stopWithEscalation(registration, {
    requestStop: async ({ url }) => {
      const response = await fetch(`${url}/daemon/stop`, {
        body: JSON.stringify({ mode: 'shutdown' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) {
        throw new Error(`Daemon rejected shutdown (${String(response.status)})`)
      }
    },
  })
}

const killChildren = (
  children: readonly RunningDevChild[],
  signal: NodeJS.Signals
) => {
  for (const child of children) {
    try {
      child.process.kill(signal)
    } catch {
      // The child may have exited between observation and cleanup.
    }
  }
}

/**
 * Treat every child as required: once one exits, stop its siblings rather than
 * waiting forever for watch processes that can no longer provide a usable dev
 * environment. Escalate cleanup so Ctrl-C and startup failures stay bounded.
 */
export const superviseDevChildren = async (
  children: readonly RunningDevChild[],
  shutdownGraceMs = 5000,
  beforeStop: () => Promise<void> = () => Promise.resolve()
): Promise<{
  readonly exits: readonly {
    readonly definition: ChildDefinition
    readonly exitCode: number
  }[]
  readonly firstExit: {
    readonly definition: ChildDefinition
    readonly exitCode: number
  }
}> => {
  if (children.length === 0) {
    throw new Error('The dev runner requires at least one child process')
  }

  const exits = children.map(async ({ definition, process: child }) => ({
    definition,
    exitCode: await child.exited,
  }))
  const firstExit = await Promise.race(exits)
  await beforeStop().catch(() => undefined)
  killChildren(children, 'SIGTERM')

  const allExits = Promise.all(exits)
  const grace = Promise.withResolvers<undefined>()
  const graceTimer = setTimeout(grace.resolve, shutdownGraceMs)
  const gracefulExits = await Promise.race([
    allExits.then((results) => results as readonly (typeof firstExit)[]),
    grace.promise,
  ])
  clearTimeout(graceTimer)
  if (gracefulExits === undefined) {
    killChildren(children, 'SIGKILL')
  }

  return { exits: await allExits, firstExit }
}

export const devChildDefinitions = (
  root: string,
  desktop = false
): readonly ChildDefinition[] => [
  {
    label: 'server build',
    command: [
      join(root, 'packages/server/node_modules/.bin/tsdown'),
      '--watch',
    ],
    cwd: join(root, 'packages/server'),
  },
  {
    label: 'terminal build',
    command: [
      join(root, 'packages/terminal/node_modules/.bin/tsdown'),
      '--watch',
    ],
    cwd: join(root, 'packages/terminal'),
  },
  {
    label: 'file-watcher build',
    command: [
      join(root, 'packages/file-watcher/node_modules/.bin/tsdown'),
      '--watch',
    ],
    cwd: join(root, 'packages/file-watcher'),
  },
  {
    label: 'daemon',
    command: [
      'node',
      '--watch',
      join(root, 'packages/server/dist/daemon-main.mjs'),
    ],
    cwd: root,
  },
  {
    label: 'web',
    command: [join(root, 'apps/web/node_modules/.bin/vite')],
    cwd: join(root, 'apps/web'),
  },
  ...(desktop
    ? [
        {
          label: 'desktop build',
          command: [
            join(root, 'apps/desktop/node_modules/.bin/tsdown'),
            '--watch',
          ],
          cwd: join(root, 'apps/desktop'),
        },
        {
          label: 'desktop',
          command: ['bun', join(root, 'apps/desktop/scripts/dev-electron.mjs')],
          cwd: join(root, 'apps/desktop'),
        },
      ]
    : []),
]

export const isCleanDesktopQuit = (
  desktop: boolean,
  exit: {
    readonly definition: ChildDefinition
    readonly exitCode: number
  }
): boolean =>
  desktop && exit.definition.label === 'desktop' && exit.exitCode === 0

const initialServerBuild = async (
  root: string,
  environment: NodeJS.ProcessEnv
) => {
  const build = Bun.spawn(
    [join(root, 'packages/server/node_modules/.bin/tsdown')],
    {
      cwd: join(root, 'packages/server'),
      env: environment,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    }
  )
  const exitCode = await build.exited
  if (exitCode !== 0) {
    throw new Error(`Initial server build exited with code ${String(exitCode)}`)
  }
}

export const runDev = async (arguments_: readonly string[]) => {
  const root = resolve(import.meta.dirname, '..')
  loadDotEnv({ path: join(root, '.env.local'), quiet: true })
  const options = parseDevRunnerArguments(arguments_)
  const worktreeStateHome = options.useRealState
    ? undefined
    : linkedWorktreeStateHome(root)
  const stateHome = resolveDevStateHome({
    explicitStateHome: options.stateHome,
    worktreeStateHome,
    ambientStateHome: process.env.XDG_STATE_HOME,
  })
  if (stateHome !== undefined && !isAbsolute(stateHome)) {
    throw new Error(`XDG state home must be absolute: ${stateHome}`)
  }
  const registrationPath = resolveDevDaemonRegistrationPath(stateHome)
  await assertNoDevIncumbent(registrationPath)
  const offset = worktreePortOffset(root)
  const ports = await findAvailableDevPorts(offset)

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    [DEV_TERMINAL_XDG_STATE_HOME]:
      process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state'),
    LABORER_DAEMON_PORT: String(ports.daemonPort),
    LABORER_DEV_WATCH: '1',
    VITE_PORT: String(ports.webPort),
  }
  if (stateHome === undefined) {
    environment.XDG_STATE_HOME = undefined
  } else {
    environment.XDG_STATE_HOME = stateHome
  }

  console.log(
    `[dev-runner] daemon=http://127.0.0.1:${String(ports.daemonPort)} web=http://localhost:${String(ports.webPort)} state=${stateHome ?? 'system default'}`
  )
  if (options.dryRun) {
    return
  }

  // The watched runtime targets dist. Seed that entry once so a clean checkout
  // cannot race tsdown's first watch build and leave Node watching a missing file.
  await initialServerBuild(root, environment)

  const children: readonly RunningDevChild[] = devChildDefinitions(
    root,
    options.desktop
  ).map((definition) => ({
    definition,
    process: Bun.spawn([...definition.command], {
      cwd: definition.cwd,
      env: environment,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  }))

  let stopping = false
  let shutdownPromise: Promise<void> | undefined
  const stop = () => {
    if (stopping) {
      return
    }
    stopping = true
    shutdownPromise ??= shutdownDevDaemon(registrationPath).catch(
      () => undefined
    )
    shutdownPromise.finally(() => killChildren(children, 'SIGTERM'))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  const { firstExit } = await superviseDevChildren(children, 5000, async () => {
    shutdownPromise ??= shutdownDevDaemon(registrationPath)
    await shutdownPromise.catch(() => undefined)
  })
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)

  if (!(stopping || isCleanDesktopQuit(options.desktop, firstExit))) {
    throw new Error(
      `${firstExit.definition.label} exited with code ${String(firstExit.exitCode)}`
    )
  }
}

if (import.meta.main) {
  runDev(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
