#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type BuildPlatform = 'mac' | 'linux' | 'win'
type BuildArch = 'arm64' | 'x64' | 'universal'

interface BuildOptions {
  arch?: BuildArch
  platform: BuildPlatform
  skipBuild: boolean
  target: string
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = join(repoRoot, 'apps/desktop')
const desktopDistDir = join(desktopDir, 'dist-electron')
const webDistDir = join(repoRoot, 'apps/web/dist')

const fail = (message: string): never => {
  console.error(`[desktop-build] ${message}`)
  process.exit(1)
}

const run = (command: string, args: string[], cwd: string): void => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(' ')}`)
  }
}

const detectHostPlatform = (): BuildPlatform => {
  if (process.platform === 'darwin') {
    return 'mac'
  }
  if (process.platform === 'linux') {
    return 'linux'
  }
  if (process.platform === 'win32') {
    return 'win'
  }

  fail(`Unsupported host platform: ${process.platform}`)
}

const defaultTarget = (platform: BuildPlatform): string => {
  if (platform === 'mac') {
    return 'dmg'
  }
  if (platform === 'linux') {
    return 'AppImage'
  }

  return 'nsis'
}

const takeValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index + 1]
  if (!value) {
    fail(`Missing value for ${flag}`)
  }

  return value
}

const parseArgs = (argv: string[]): BuildOptions => {
  let platform: BuildPlatform | undefined
  let target: string | undefined
  let arch: BuildArch | undefined
  let skipBuild = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--skipBuild') {
      skipBuild = true
      continue
    }

    if (arg === '--platform') {
      platform = takeValue(argv, index, arg) as BuildPlatform
      index += 1
      continue
    }

    if (arg.startsWith('--platform=')) {
      platform = arg.slice('--platform='.length) as BuildPlatform
      continue
    }

    if (arg === '--target') {
      target = takeValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length)
      continue
    }

    if (arg === '--arch') {
      arch = takeValue(argv, index, arg) as BuildArch
      index += 1
      continue
    }

    if (arg.startsWith('--arch=')) {
      arch = arg.slice('--arch='.length) as BuildArch
    }
  }

  const resolvedPlatform = platform ?? detectHostPlatform()

  return {
    platform: resolvedPlatform,
    target: target ?? defaultTarget(resolvedPlatform),
    arch,
    skipBuild,
  }
}

const main = (): void => {
  const options = parseArgs(process.argv.slice(2))

  if (!options.skipBuild) {
    run(
      'bun',
      [
        'x',
        'turbo',
        'run',
        'build',
        '--filter=@laborer/web',
        '--filter=@laborer/desktop',
      ],
      repoRoot
    )
  }

  if (!existsSync(join(webDistDir, 'index.html'))) {
    fail(`Missing web build output at ${webDistDir}`)
  }

  if (!existsSync(join(desktopDistDir, 'main.js'))) {
    fail(`Missing desktop build output at ${desktopDistDir}`)
  }

  const builderArgs = ['x', 'electron-builder', '--publish', 'never']

  if (options.platform === 'mac') {
    builderArgs.push('--mac', options.target)
  } else if (options.platform === 'linux') {
    builderArgs.push('--linux', options.target)
  } else {
    builderArgs.push('--win', options.target)
  }

  if (options.arch) {
    builderArgs.push(`--${options.arch}`)
  }

  run('bun', builderArgs, desktopDir)
}

main()
