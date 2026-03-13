import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * Ghostty build information returned by the native runtime.
 */
interface GhosttyInfo {
  readonly buildMode: string
  readonly version: string
}

/**
 * Result of validating the Ghostty config subsystem.
 */
interface GhosttyConfigValidation {
  readonly diagnostics?: readonly string[]
  readonly diagnosticsCount: number
  readonly success: boolean
}

/**
 * The raw native addon interface exposed by the compiled C++ module.
 */
interface GhosttyAddon {
  getInfo(): GhosttyInfo
  init(): boolean
  isInitialized(): boolean
  validateConfig(): GhosttyConfigValidation
}

/**
 * Load the native Ghostty addon.
 *
 * Uses `createRequire` because the addon is a `.node` binary
 * that cannot be loaded with ESM `import`.
 */
const loadAddon = (): GhosttyAddon => {
  const require = createRequire(import.meta.url)
  const addonPath = path.resolve(
    import.meta.dirname,
    '..',
    'build',
    'Release',
    'ghostty_addon.node'
  )
  return require(addonPath) as GhosttyAddon
}

let addon: GhosttyAddon | undefined

/**
 * Get the native Ghostty addon instance, loading it lazily on first access.
 */
const getAddon = (): GhosttyAddon => {
  if (addon === undefined) {
    addon = loadAddon()
  }
  return addon
}

/**
 * Initialize the Ghostty runtime.
 * Must be called once before using any other Ghostty APIs.
 *
 * @returns `true` if initialization succeeded.
 * @throws If the Ghostty runtime fails to initialize.
 */
const init = (): boolean => {
  return getAddon().init()
}

/**
 * Check whether the Ghostty runtime has been initialized.
 */
const isInitialized = (): boolean => {
  return getAddon().isInitialized()
}

/**
 * Get Ghostty build information (version and build mode).
 * Ghostty must be initialized first.
 *
 * @throws If Ghostty is not initialized.
 */
const getInfo = (): GhosttyInfo => {
  return getAddon().getInfo()
}

/**
 * Validate the Ghostty config subsystem by loading default config files.
 * Ghostty must be initialized first.
 *
 * @throws If Ghostty is not initialized.
 */
const validateConfig = (): GhosttyConfigValidation => {
  return getAddon().validateConfig()
}

export { getInfo, init, isInitialized, validateConfig }
export type { GhosttyConfigValidation, GhosttyInfo }
