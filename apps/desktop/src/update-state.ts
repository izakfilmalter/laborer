import type { DesktopUpdateState } from '@laborer/shared/desktop-bridge'

/**
 * Determines whether a download progress update should be broadcast to the
 * renderer via IPC. Throttles to 10% bucket boundaries to prevent flooding.
 */
export function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number
): boolean {
  if (currentState.status !== 'downloading') {
    return true
  }

  const currentPercent = currentState.downloadPercent
  if (currentPercent === null) {
    return true
  }

  const previousStep = Math.floor(currentPercent / 10)
  const nextStep = Math.floor(nextPercent / 10)
  return nextStep !== previousStep || nextPercent === 100
}

/**
 * After a download failure, determines the appropriate next status.
 * Returns `"available"` if the version is known (allowing retry),
 * otherwise `"error"`.
 */
export function nextStatusAfterDownloadFailure(
  currentState: DesktopUpdateState
): DesktopUpdateState['status'] {
  return currentState.availableVersion ? 'available' : 'error'
}

/**
 * After a download failure, determines whether the user can retry.
 * True when the available version is still known.
 */
export function getCanRetryAfterDownloadFailure(
  currentState: DesktopUpdateState
): boolean {
  return currentState.availableVersion !== null
}

/**
 * Returns a human-readable reason why auto-updates are disabled,
 * or `null` if auto-updates should be enabled.
 */
export function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean
  isPackaged: boolean
  platform: NodeJS.Platform
  disabledByEnv: boolean
}): string | null {
  if (args.isDevelopment || !args.isPackaged) {
    return 'Automatic updates are only available in packaged production builds.'
  }
  if (args.disabledByEnv) {
    return 'Automatic updates are disabled by the LABORER_DISABLE_AUTO_UPDATE setting.'
  }
  if (args.platform === 'linux') {
    return 'Automatic updates on Linux are not supported.'
  }
  return null
}
