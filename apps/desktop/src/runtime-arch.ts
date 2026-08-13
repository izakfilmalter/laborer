import type {
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
} from '@laborer/shared/desktop-bridge'

/**
 * Input for resolving the desktop runtime architecture.
 * Abstracted to allow testing without real `process` and `app` globals.
 */
export interface ResolveDesktopRuntimeInfoInput {
  readonly platform: NodeJS.Platform
  readonly processArch: string
  readonly runningUnderArm64Translation: boolean
}

/** Normalizes a raw `process.arch` string to the `DesktopRuntimeArch` union. */
function normalizeDesktopArch(arch: string): DesktopRuntimeArch {
  if (arch === 'arm64') {
    return 'arm64'
  }
  if (arch === 'x64') {
    return 'x64'
  }
  return 'other'
}

/**
 * Resolves the desktop runtime architecture information.
 *
 * On macOS, detects whether an Intel (x64) build is running under Rosetta
 * translation on Apple Silicon hardware, using Electron's
 * `app.runningUnderARM64Translation` flag.
 */
export function resolveDesktopRuntimeInfo(
  input: ResolveDesktopRuntimeInfoInput
): DesktopRuntimeInfo {
  const appArch = normalizeDesktopArch(input.processArch)

  if (input.platform !== 'darwin') {
    return {
      hostArch: appArch,
      appArch,
      runningUnderArm64Translation: false,
    }
  }

  const hostArch =
    appArch === 'arm64' || input.runningUnderArm64Translation
      ? 'arm64'
      : appArch

  return {
    hostArch,
    appArch,
    runningUnderArm64Translation: input.runningUnderArm64Translation,
  }
}

/**
 * Returns true if an Apple Silicon host is running an Intel (x64) build
 * under Rosetta translation. Used to disable differential downloads.
 */
export function isArm64HostRunningIntelBuild(
  runtimeInfo: DesktopRuntimeInfo
): boolean {
  return runtimeInfo.hostArch === 'arm64' && runtimeInfo.appArch === 'x64'
}
