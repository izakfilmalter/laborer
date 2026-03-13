import { createRequire } from 'node:module'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
 * Options for creating a new Ghostty terminal surface.
 */
interface CreateSurfaceOptions {
  /** Command to run instead of the default shell. */
  readonly command?: string
  /** Initial height in pixels (default 600). */
  readonly height?: number
  /** Initial width in pixels (default 800). */
  readonly width?: number
  /** Initial working directory for the shell. */
  readonly workingDirectory?: string
}

/**
 * Result of creating a Ghostty terminal surface.
 */
interface SurfaceHandle {
  /** Unique numeric identifier for the surface. */
  readonly id: number
}

/**
 * Terminal grid and pixel size information for a surface.
 */
interface SurfaceSize {
  readonly cellHeightPx: number
  readonly cellWidthPx: number
  readonly columns: number
  readonly heightPx: number
  readonly rows: number
  readonly widthPx: number
}

/**
 * IOSurface information for zero-copy rendering.
 */
interface IOSurfaceInfo {
  /** Whether the view has a CAMetalLayer. */
  readonly hasLayer: boolean
  /** IOSurface ID for cross-process texture sharing, or null if not yet available. */
  readonly ioSurfaceId: number | null
}

/**
 * Pixel data read back from a Ghostty surface's IOSurface.
 * Contains BGRA pixel data (4 bytes per pixel), tightly packed.
 */
interface SurfacePixels {
  /** BGRA pixel data buffer (width * height * 4 bytes). */
  readonly data: Buffer
  /** Surface height in pixels. */
  readonly height: number
  /** Surface width in pixels. */
  readonly width: number
}

/**
 * Key input action (matches ghostty_input_action_e).
 * 0 = release, 1 = press, 2 = repeat.
 */
type KeyAction = 0 | 1 | 2

/**
 * Key event to send to a Ghostty surface.
 * Matches the fields of ghostty_input_key_s from the Ghostty C API.
 */
interface KeyEvent {
  /** 0 = release, 1 = press, 2 = repeat. */
  readonly action: KeyAction
  /** Whether this is part of an IME compose sequence. */
  readonly composing: boolean
  /** Ghostty key code (ghostty_input_key_e enum value). */
  readonly keycode: number
  /** Modifier bitmask (ghostty_input_mods_e flags OR'd together). */
  readonly mods: number
  /** UTF-8 text produced by the key, or null. */
  readonly text: string | null
  /** Codepoint of the key without shift modifier applied. */
  readonly unshiftedCodepoint: number
}

// ---------------------------------------------------------------------------
// Native addon interface
// ---------------------------------------------------------------------------

/**
 * The raw native addon interface exposed by the compiled Objective-C++ module.
 */
interface GhosttyAddon {
  // App lifecycle
  appTick(): void
  createApp(): boolean

  // Surface lifecycle
  createSurface(options?: CreateSurfaceOptions): SurfaceHandle
  destroyApp(): boolean
  destroySurface(surfaceId: number): boolean

  // Runtime initialization
  getInfo(): GhosttyInfo

  // Surface control
  getSurfaceIOSurfaceId(surfaceId: number): IOSurfaceInfo
  getSurfacePixels(surfaceId: number): SurfacePixels | null
  getSurfaceSize(surfaceId: number): SurfaceSize
  init(): boolean
  isAppCreated(): boolean
  isInitialized(): boolean
  listSurfaces(): number[]

  // Keyboard and text input
  sendSurfaceKey(
    surfaceId: number,
    action: number,
    mods: number,
    keycode: number,
    text: string | null,
    unshiftedCodepoint: number,
    composing: boolean
  ): boolean
  sendSurfaceText(surfaceId: number, text: string): boolean

  setSurfaceFocus(surfaceId: number, focused: boolean): boolean
  setSurfaceSize(surfaceId: number, width: number, height: number): boolean
  validateConfig(): GhosttyConfigValidation
}

// ---------------------------------------------------------------------------
// Addon loading
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Runtime initialization
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/**
 * Create the Ghostty app runtime with callbacks.
 * Only one app instance is supported. Must be called after init()
 * and before any surfaces can be created.
 *
 * @returns `true` if app creation succeeded.
 * @throws If Ghostty is not initialized or app creation fails.
 */
const createApp = (): boolean => {
  return getAddon().createApp()
}

/**
 * Check whether the Ghostty app runtime has been created.
 */
const isAppCreated = (): boolean => {
  return getAddon().isAppCreated()
}

/**
 * Destroy the Ghostty app runtime and all surfaces.
 * Safe to call if no app exists.
 *
 * @returns `true` on success.
 */
const destroyApp = (): boolean => {
  return getAddon().destroyApp()
}

/**
 * Tick the Ghostty app runtime to process events.
 * Must be called periodically (e.g., on a timer in the helper process).
 *
 * @throws If the app is not created.
 */
const appTick = (): void => {
  getAddon().appTick()
}

// ---------------------------------------------------------------------------
// Surface lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a new Ghostty terminal surface.
 *
 * Creates an offscreen NSWindow with an NSView that Ghostty renders into
 * via Metal. The surface is invisible — its content is shared to Electron
 * via IOSurface for zero-copy rendering.
 *
 * @returns A handle containing the surface's unique numeric ID.
 * @throws If the app is not created or surface creation fails.
 */
const createSurface = (options?: CreateSurfaceOptions): SurfaceHandle => {
  return getAddon().createSurface(options)
}

/**
 * Destroy a Ghostty terminal surface by its ID.
 * Frees the native surface, closes the hosting window, and releases resources.
 *
 * @throws If the surface is not found.
 */
const destroySurface = (surfaceId: number): boolean => {
  return getAddon().destroySurface(surfaceId)
}

/**
 * Get a list of all active surface IDs.
 */
const listSurfaces = (): number[] => {
  return getAddon().listSurfaces()
}

// ---------------------------------------------------------------------------
// Surface control
// ---------------------------------------------------------------------------

/**
 * Set the size of a Ghostty surface in pixels.
 * Updates both the hosting NSWindow/NSView and the Ghostty surface.
 *
 * @throws If the surface is not found.
 */
const setSurfaceSize = (
  surfaceId: number,
  width: number,
  height: number
): boolean => {
  return getAddon().setSurfaceSize(surfaceId, width, height)
}

/**
 * Send a key event to a Ghostty surface.
 *
 * Translates from the KeyEvent structure to the native addon's positional
 * arguments matching ghostty_input_key_s.
 *
 * @returns `true` if the key was consumed by Ghostty.
 * @throws If the surface is not found.
 */
const sendSurfaceKey = (surfaceId: number, event: KeyEvent): boolean => {
  return getAddon().sendSurfaceKey(
    surfaceId,
    event.action,
    event.mods,
    event.keycode,
    event.text,
    event.unshiftedCodepoint,
    event.composing
  )
}

/**
 * Send composed text input to a Ghostty surface.
 *
 * @returns `true` on success.
 * @throws If the surface is not found.
 */
const sendSurfaceText = (surfaceId: number, text: string): boolean => {
  return getAddon().sendSurfaceText(surfaceId, text)
}

/**
 * Set focus state of a Ghostty surface.
 * Controls cursor state and keyboard routing in the terminal.
 *
 * @throws If the surface is not found.
 */
const setSurfaceFocus = (surfaceId: number, focused: boolean): boolean => {
  return getAddon().setSurfaceFocus(surfaceId, focused)
}

/**
 * Get the current size of a Ghostty surface including grid dimensions.
 *
 * @throws If the surface is not found.
 */
const getSurfaceSize = (surfaceId: number): SurfaceSize => {
  return getAddon().getSurfaceSize(surfaceId)
}

/**
 * Get the IOSurface ID for a Ghostty surface's Metal layer.
 *
 * The IOSurface ID can be used by another process (Electron) to import
 * the rendered terminal texture for zero-copy display via WebGPU.
 *
 * Note: The IOSurface may not be available immediately after creation.
 * Ghostty needs to render at least one frame first.
 *
 * @throws If the surface is not found.
 */
const getSurfaceIOSurfaceId = (surfaceId: number): IOSurfaceInfo => {
  return getAddon().getSurfaceIOSurfaceId(surfaceId)
}

/**
 * Read pixel data from a Ghostty surface's IOSurface.
 *
 * Locks the IOSurface for CPU read access, copies the BGRA pixel buffer,
 * and returns it. This is the tracer-bullet rendering path that proves
 * Ghostty output can flow to the Electron renderer. The zero-copy path
 * (Issue 3) will replace this with shared-texture display via WebGPU.
 *
 * Returns null if the IOSurface is not yet available (Ghostty hasn't
 * rendered a frame yet).
 *
 * @throws If the surface is not found.
 */
const getSurfacePixels = (surfaceId: number): SurfacePixels | null => {
  return getAddon().getSurfacePixels(surfaceId)
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  appTick,
  createApp,
  createSurface,
  destroyApp,
  destroySurface,
  getInfo,
  getSurfaceIOSurfaceId,
  getSurfacePixels,
  getSurfaceSize,
  init,
  isAppCreated,
  isInitialized,
  listSurfaces,
  sendSurfaceKey,
  sendSurfaceText,
  setSurfaceFocus,
  setSurfaceSize,
  validateConfig,
}
export type {
  CreateSurfaceOptions,
  GhosttyConfigValidation,
  GhosttyInfo,
  IOSurfaceInfo,
  KeyAction,
  KeyEvent,
  SurfaceHandle,
  SurfacePixels,
  SurfaceSize,
}
