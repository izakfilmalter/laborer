import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { LABORER_VERSION } from '../version.ts'
import { laborerLaunchAgentPlist, macosPackageLayout } from './macos-package.ts'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '../..')
const outputRoot = resolve(packageRoot, 'release', `macos-${arch()}`)
const application = resolve(outputRoot, 'Laborer.app')
const contents = resolve(application, 'Contents')
const resources = resolve(contents, 'Resources')
const packagedApplication = resolve(resources, 'app')
const packagedDaemon = resolve(resources, 'daemon')

const plistSet = async (key: string, value: string): Promise<void> => {
  await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :${key} ${value}`,
    resolve(contents, 'Info.plist'),
  ])
}

const plistAdd = async (
  key: string,
  type: string,
  value: string
): Promise<void> => {
  await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    `Add :${key} ${type} ${value}`,
    resolve(contents, 'Info.plist'),
  ])
}

const plistSetOrAdd = async (
  key: string,
  type: string,
  value: string
): Promise<void> => {
  try {
    await plistSet(key, value)
  } catch {
    await plistAdd(key, type, value)
  }
}

const nodeExecutable = async (): Promise<string> => {
  const [{ stdout: executable }, { stdout: runtimeArch }, { stdout: version }] =
    await Promise.all([
      execFileAsync('node', ['-p', 'process.execPath']),
      execFileAsync('node', ['-p', 'process.arch']),
      execFileAsync('node', ['-p', 'process.versions.node']),
    ])
  const expectedVersion = (
    await readFile(resolve(packageRoot, '.node-version'), 'utf8')
  ).trim()
  if (runtimeArch.trim() !== arch() || version.trim() !== expectedVersion) {
    throw new Error(
      `Node ${expectedVersion} for ${arch()} is required to package the daemon`
    )
  }
  return executable.trim()
}

const packageMacosApplication = async (): Promise<void> => {
  if (platform() !== 'darwin') {
    throw new Error('companion:package:macos must run on macOS')
  }
  const electronApplication = resolve(
    packageRoot,
    'node_modules/electron/dist/Electron.app'
  )
  const node = await nodeExecutable()
  await Promise.all([access(electronApplication), access(node)])
  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(outputRoot, { recursive: true })
  await cp(electronApplication, application, { recursive: true })

  await plistSet('CFBundleDisplayName', 'Laborer')
  await plistSet('CFBundleIdentifier', 'com.laborer.companion')
  await plistSet('CFBundleName', 'Laborer')
  await plistSet('CFBundleExecutable', 'Laborer')
  await plistSetOrAdd('LSMinimumSystemVersion', 'string', '13.0')
  await plistSetOrAdd('LSUIElement', 'bool', 'true')
  await rename(
    resolve(contents, 'MacOS', 'Electron'),
    resolve(contents, 'MacOS', 'Laborer')
  )

  await rm(resolve(resources, 'default_app.asar'), { force: true })
  await mkdir(packagedApplication, { recursive: true })
  await cp(resolve(packageRoot, 'out'), resolve(packagedApplication, 'out'), {
    recursive: true,
  })
  await writeFile(
    resolve(packagedApplication, 'package.json'),
    `${JSON.stringify({ main: 'out/main/main.js', name: 'laborer-companion', version: LABORER_VERSION }, null, 2)}\n`
  )

  await mkdir(resolve(packagedDaemon, 'app'), { recursive: true })
  await mkdir(resolve(packagedDaemon, 'bin'), { recursive: true })
  await cp(resolve(packageRoot, 'src'), resolve(packagedDaemon, 'app', 'src'), {
    recursive: true,
  })
  await cp(
    resolve(packageRoot, 'node_modules'),
    resolve(packagedDaemon, 'app', 'node_modules'),
    { recursive: true }
  )
  // electron-vite externalizes main-process packages. Reuse the daemon's full
  // dependency tree rather than duplicating it inside the same application.
  await symlink(
    '../daemon/app/node_modules',
    resolve(packagedApplication, 'node_modules'),
    'dir'
  )
  await Promise.all(
    ['laborer.json', 'package.json'].map((name) =>
      copyFile(resolve(packageRoot, name), resolve(packagedDaemon, 'app', name))
    )
  )
  await copyFile(
    node,
    resolve(contents, macosPackageLayout.nodeRuntime.replace('Contents/', ''))
  )
  await chmod(
    resolve(contents, macosPackageLayout.nodeRuntime.replace('Contents/', '')),
    0o755
  )

  const daemonLauncher = resolve(
    contents,
    'MacOS',
    basename(macosPackageLayout.daemonBundleProgram)
  )
  await copyFile(
    resolve(import.meta.dirname, 'native/laborer-daemon'),
    daemonLauncher
  )
  await chmod(daemonLauncher, 0o755)

  const serviceManager = resolve(
    resources,
    basename(macosPackageLayout.serviceManager)
  )
  const target =
    arch() === 'arm64' ? 'arm64-apple-macos13' : 'x86_64-apple-macos13'
  const serviceManagerSource = resolve(outputRoot, 'service-management.swift')
  await writeFile(
    serviceManagerSource,
    (
      await readFile(
        resolve(import.meta.dirname, 'native/service-management.swift'),
        'utf8'
      )
    ).replace('__LABORER_VERSION__', LABORER_VERSION)
  )
  await execFileAsync('xcrun', [
    'swiftc',
    '-O',
    '-parse-as-library',
    '-target',
    target,
    serviceManagerSource,
    '-o',
    serviceManager,
  ])
  await rm(serviceManagerSource)

  const launchAgent = resolve(contents, 'Library', 'LaunchAgents')
  await mkdir(launchAgent, { recursive: true })
  await writeFile(
    resolve(application, macosPackageLayout.launchAgentPlist),
    laborerLaunchAgentPlist()
  )
  await chmod(serviceManager, 0o755)
  // Service Management rejects a bundle whose original Electron signature was
  // invalidated by packaging. Ad-hoc signing is sufficient for this local
  // developer preview; distribution still requires Developer ID notarization.
  await execFileAsync('codesign', [
    '--deep',
    '--force',
    '--sign',
    '-',
    application,
  ])
  process.stdout.write(`${application}\n`)
}

await packageMacosApplication()
