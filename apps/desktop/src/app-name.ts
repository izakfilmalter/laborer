export const DESKTOP_APP_NAME = 'Laborer'

const STABLE_DESKTOP_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

function isStableDesktopVersion(version: string): boolean {
  return STABLE_DESKTOP_VERSION_PATTERN.test(version.trim())
}

/**
 * Prerelease desktop builds keep a `-dev` suffix so they are easy to
 * distinguish from stable releases in process lists and the OS UI.
 */
export function resolveDesktopAppName(options: {
  readonly isDevelopment: boolean
  readonly version: string
}): string {
  const isDevVariant =
    options.isDevelopment || !isStableDesktopVersion(options.version)

  return isDevVariant ? `${DESKTOP_APP_NAME}-dev` : DESKTOP_APP_NAME
}
