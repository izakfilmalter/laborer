import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface CleanupTarget {
  readonly kind: 'renderer-opfs' | 'server-store' | 'server-sync'
  readonly path: string
}

export interface CleanupEnvironment {
  readonly APPDATA?: string
  readonly DATA_DIR?: string
  readonly XDG_CONFIG_HOME?: string
}

function absoluteEnvironmentPath(
  value: string | undefined
): string | undefined {
  const candidate = value?.trim()
  return candidate && isAbsolute(candidate) ? candidate : undefined
}

function addDesktopLocations(options: {
  readonly appDataRoot: string
  readonly dataDirectories: Set<string>
  readonly rendererProfiles: Set<string>
}): void {
  const { appDataRoot, dataDirectories, rendererProfiles } = options
  dataDirectories.add(join(appDataRoot, 'data'))
  dataDirectories.add(join(appDataRoot, 'com.izakfilmalter.laborer', 'data'))
  for (const profile of ['Laborer', 'Laborer-dev', 'laborer-desktop']) {
    dataDirectories.add(join(appDataRoot, profile, 'data'))
    rendererProfiles.add(join(appDataRoot, profile))
  }
}

const syncFileNames = [
  'sync-laborer.db',
  'sync-laborer.db-shm',
  'sync-laborer.db-wal',
  'sync-laborer.db-journal',
] as const

function addServerTargets(
  targets: CleanupTarget[],
  dataDirectory: string
): void {
  targets.push({
    kind: 'server-store',
    path: join(dataDirectory, 'laborer'),
  })
  for (const fileName of syncFileNames) {
    targets.push({
      kind: 'server-sync',
      path: join(dataDirectory, fileName),
    })
  }
}

/**
 * Enumerate only paths that were owned by the removed LiveStore adapters.
 * Parent application/config directories are deliberately retained.
 */
export function enumerateLiveStoreCleanupTargets(options?: {
  readonly environment?: CleanupEnvironment
  readonly homeDirectory?: string
  readonly platform?: NodeJS.Platform
}): readonly CleanupTarget[] {
  const environment = options?.environment ?? process.env
  const homeDirectory = resolve(options?.homeDirectory ?? homedir())
  const platform = options?.platform ?? process.platform
  const targets: CleanupTarget[] = []
  const dataDirectories = new Set<string>()
  const rendererProfiles = new Set<string>()

  // The server adapter's development default.
  dataDirectories.add(join(homeDirectory, '.config', 'laborer', 'data'))
  const xdgConfigHome = absoluteEnvironmentPath(environment.XDG_CONFIG_HOME)
  if (xdgConfigHome) {
    dataDirectories.add(join(xdgConfigHome, 'laborer', 'data'))
  }
  const configuredDataDirectory = absoluteEnvironmentPath(environment.DATA_DIR)
  if (configuredDataDirectory) {
    dataDirectories.add(configuredDataDirectory)
  }

  if (platform === 'darwin') {
    const applicationSupport = join(
      homeDirectory,
      'Library',
      'Application Support'
    )

    // Historical packaged builds used both Electron appData directly and
    // app-specific data roots while the product/app name was being stabilized.
    addDesktopLocations({
      appDataRoot: applicationSupport,
      dataDirectories,
      rendererProfiles,
    })
  } else {
    const appDataRoot =
      platform === 'win32'
        ? absoluteEnvironmentPath(environment.APPDATA)
        : (xdgConfigHome ?? join(homeDirectory, '.config'))
    if (appDataRoot) {
      addDesktopLocations({
        appDataRoot,
        dataDirectories,
        rendererProfiles,
      })
    }
  }

  for (const dataDirectory of dataDirectories) {
    addServerTargets(targets, resolve(dataDirectory))
  }
  for (const profile of rendererProfiles) {
    // Chromium stores the laborer://app origin's OPFS database beneath this
    // directory. LiveStore was the app's only OPFS consumer.
    targets.push({
      kind: 'renderer-opfs',
      path: join(resolve(profile), 'File System'),
    })
  }

  return [...new Map(targets.map((target) => [target.path, target])).values()]
}

export function cleanupLiveStoreTargets(
  targets: readonly CleanupTarget[],
  options: { readonly deleteFiles: boolean }
): readonly (CleanupTarget & { readonly existed: boolean })[] {
  return targets.map((target) => {
    const existed = existsSync(target.path)
    if (existed && options.deleteFiles) {
      rmSync(target.path, { force: true, recursive: true })
    }
    return { ...target, existed }
  })
}
