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
 * Options for creating the Ghostty app runtime.
 */
interface CreateAppOptions {
  /**
   * Path to a Ghostty config file to load.
   * When provided, this file is loaded in addition to (or instead of)
   * the default config files, depending on `loadDefaultConfig`.
   */
  readonly configFile?: string
  /**
   * Whether to load default Ghostty config files (~/.config/ghostty/config).
   * Defaults to true. Set to false to skip default config loading when
   * providing a custom configFile.
   */
  readonly loadDefaultConfig?: boolean
}

/**
 * Result of creating the Ghostty app runtime, including any config
 * diagnostics (parse errors, warnings) from the loaded config files.
 */
interface CreateAppResult {
  readonly diagnostics: readonly string[]
  readonly diagnosticsCount: number
  readonly success: boolean
}

/**
 * Config diagnostics from the currently loaded Ghostty app config.
 */
interface ConfigDiagnostics {
  readonly diagnostics: readonly string[]
  readonly diagnosticsCount: number
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
 * IOSurface handle for zero-copy rendering via Electron's sharedTexture API.
 * The ioSurfaceHandle is a Buffer containing the raw IOSurfaceRef pointer
 * that can be passed directly to sharedTexture.importSharedTexture().
 */
interface IOSurfaceHandle {
  /** Surface height in pixels. */
  readonly height: number
  /** Raw IOSurfaceRef as a Buffer for Electron's sharedTexture API. */
  readonly ioSurfaceHandle: Buffer
  /** Surface width in pixels. */
  readonly width: number
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
 * Action event from the Ghostty runtime, drained from the native
 * addon's action queue. Produced by RuntimeAction() in the native
 * layer during ghostty_app_tick().
 *
 * action: the action type string:
 *   - "set_title"       — terminal title changed (str_value = new title)
 *   - "pwd"             — working directory changed (str_value = new pwd)
 *   - "ring_bell"       — terminal bell
 *   - "child_exited"    — child process exited (num1 = exit code)
 *   - "close_window"    — window close requested
 *   - "cell_size"       — cell dimensions changed (num1 = width, num2 = height)
 *   - "renderer_health" — renderer health changed (num1: 0 = healthy, 1 = unhealthy)
 */
interface ActionEvent {
  /** The action type identifier. */
  readonly action: string
  /** First numeric payload (context-dependent). */
  readonly num1: number
  /** Second numeric payload (context-dependent). */
  readonly num2: number
  /** Surface ID the action targets (0 if it targets the app). */
  readonly surfaceId: number
  /** String payload (context-dependent, empty if N/A). */
  readonly value: string
}

/**
 * Key input action (matches ghostty_input_action_e).
 * 0 = release, 1 = press, 2 = repeat.
 */
type KeyAction = 0 | 1 | 2

/**
 * Mouse button state (matches ghostty_input_mouse_state_e).
 * 0 = release, 1 = press.
 */
type MouseState = 0 | 1

/**
 * Mouse button identifier (matches ghostty_input_mouse_button_e).
 * 0 = unknown, 1 = left, 2 = right, 3 = middle, 4-11 = extra buttons.
 */
type MouseButton = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11

/**
 * Mouse button event to send to a Ghostty surface.
 */
interface MouseButtonEvent {
  /** Ghostty mouse button (ghostty_input_mouse_button_e value). */
  readonly button: MouseButton
  /** Modifier bitmask (ghostty_input_mods_e flags). */
  readonly mods: number
  /** 0 = release, 1 = press. */
  readonly state: MouseState
}

/**
 * Mouse position event to send to a Ghostty surface.
 */
interface MousePosEvent {
  /** Modifier bitmask (ghostty_input_mods_e flags). */
  readonly mods: number
  /** X position in pixels relative to the surface. */
  readonly x: number
  /** Y position in pixels relative to the surface. */
  readonly y: number
}

/**
 * Mouse scroll event to send to a Ghostty surface.
 */
interface MouseScrollEvent {
  /** Horizontal scroll delta. */
  readonly dx: number
  /** Vertical scroll delta. */
  readonly dy: number
  /**
   * Packed scroll modifiers (ghostty_input_scroll_mods_t).
   * Encodes precision scrolling state and momentum phase.
   * Pass 0 for standard wheel events.
   */
  readonly scrollMods: number
}

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
  createApp(options?: CreateAppOptions): CreateAppResult

  // Surface lifecycle
  createSurface(options?: CreateSurfaceOptions): SurfaceHandle
  destroyApp(): boolean
  destroySurface(surfaceId: number): boolean
  // Action queue
  drainActions(): ActionEvent[]

  // Config
  getConfigDiagnostics(): ConfigDiagnostics
  getConfigPath(): string | null

  // Runtime initialization
  getInfo(): GhosttyInfo

  // Surface control
  getSurfaceIOSurfaceHandle(surfaceId: number): IOSurfaceHandle | null
  getSurfaceIOSurfaceId(surfaceId: number): IOSurfaceInfo
  getSurfacePixels(surfaceId: number): SurfacePixels | null
  getSurfaceSize(surfaceId: number): SurfaceSize
  init(): boolean
  isAppCreated(): boolean
  isInitialized(): boolean
  listSurfaces(): number[]
  lookupIOSurfaceHandleById(ioSurfaceId: number): IOSurfaceHandle | null

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

  // Mouse input
  sendSurfaceMouseButton(
    surfaceId: number,
    state: number,
    button: number,
    mods: number
  ): boolean
  sendSurfaceMousePos(
    surfaceId: number,
    x: number,
    y: number,
    mods: number
  ): void
  sendSurfaceMouseScroll(
    surfaceId: number,
    dx: number,
    dy: number,
    scrollMods: number
  ): void
  sendSurfaceText(surfaceId: number, text: string): boolean

  setSurfaceFocus(surfaceId: number, focused: boolean): boolean
  setSurfaceSize(surfaceId: number, width: number, height: number): boolean
  surfaceMouseCaptured(surfaceId: number): boolean
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

/**
 * Get the path to the Ghostty config file.
 *
 * Returns the standard config file path that Ghostty uses for loading
 * configuration (typically ~/.config/ghostty/config on macOS).
 *
 * @returns The config file path, or null if the path cannot be determined.
 * @throws If Ghostty is not initialized.
 */
const getConfigPath = (): string | null => {
  return getAddon().getConfigPath()
}

/**
 * Get diagnostics from the currently loaded app config.
 *
 * Returns any parse errors or warnings from the config files that were
 * loaded during createApp(). Returns empty diagnostics if no app exists.
 */
const getConfigDiagnostics = (): ConfigDiagnostics => {
  return getAddon().getConfigDiagnostics()
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/**
 * Create the Ghostty app runtime with callbacks and config loading.
 * Only one app instance is supported. Must be called after init()
 * and before any surfaces can be created.
 *
 * Loads Ghostty config files during creation. By default, loads the
 * standard config files (~/.config/ghostty/config). A custom config
 * file can be specified via options.configFile.
 *
 * @returns A result object indicating success and any config diagnostics.
 * @throws If Ghostty is not initialized or app creation fails fatally.
 */
const createApp = (options?: CreateAppOptions): CreateAppResult => {
  return getAddon().createApp(options)
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

/**
 * Drain all queued Ghostty actions since the last drain.
 *
 * Returns an array of ActionEvent objects representing Ghostty runtime
 * callbacks (title changes, pwd updates, bell, child exit, etc.) that
 * occurred during ghostty_app_tick() since the last drain.
 *
 * This should be called after each appTick() in the host process to
 * forward action events to the parent.
 */
const drainActions = (): ActionEvent[] => {
  return getAddon().drainActions()
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

// ---------------------------------------------------------------------------
// Mouse input
// ---------------------------------------------------------------------------

/**
 * Check whether a Ghostty surface has captured the mouse.
 * When captured, mouse events should be forwarded to the terminal rather
 * than handled by the surrounding UI (e.g., for TUI applications that
 * request mouse tracking).
 *
 * @throws If the surface is not found.
 */
const surfaceMouseCaptured = (surfaceId: number): boolean => {
  return getAddon().surfaceMouseCaptured(surfaceId)
}

/**
 * Send a mouse button event to a Ghostty surface.
 *
 * @returns `true` if the event was consumed by Ghostty.
 * @throws If the surface is not found.
 */
const sendSurfaceMouseButton = (
  surfaceId: number,
  event: MouseButtonEvent
): boolean => {
  return getAddon().sendSurfaceMouseButton(
    surfaceId,
    event.state,
    event.button,
    event.mods
  )
}

/**
 * Send a mouse position update to a Ghostty surface.
 * Coordinates are in pixels relative to the surface origin.
 *
 * @throws If the surface is not found.
 */
const sendSurfaceMousePos = (surfaceId: number, event: MousePosEvent): void => {
  getAddon().sendSurfaceMousePos(surfaceId, event.x, event.y, event.mods)
}

/**
 * Send a mouse scroll event to a Ghostty surface.
 *
 * @throws If the surface is not found.
 */
const sendSurfaceMouseScroll = (
  surfaceId: number,
  event: MouseScrollEvent
): void => {
  getAddon().sendSurfaceMouseScroll(
    surfaceId,
    event.dx,
    event.dy,
    event.scrollMods
  )
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
 * Get the IOSurface handle for a Ghostty surface's Metal layer.
 *
 * Returns a Buffer containing the raw IOSurfaceRef pointer suitable for
 * passing to Electron's sharedTexture.importSharedTexture() API in the
 * same process that owns the surface.
 *
 * Returns null if the IOSurface is not yet available (Ghostty hasn't
 * rendered a frame yet).
 *
 * @throws If the surface is not found.
 */
const getSurfaceIOSurfaceHandle = (
  surfaceId: number
): IOSurfaceHandle | null => {
  return getAddon().getSurfaceIOSurfaceHandle(surfaceId)
}

/**
 * Look up a process-local IOSurface handle from a cross-process IOSurface ID.
 *
 * Use this in Electron main after receiving an `ioSurfaceId` from the helper
 * process. Electron's sharedTexture importer requires the IOSurfaceRef to be
 * valid in the importing process.
 */
const lookupIOSurfaceHandleById = (
  ioSurfaceId: number
): IOSurfaceHandle | null => {
  return getAddon().lookupIOSurfaceHandleById(ioSurfaceId)
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
  drainActions,
  getConfigDiagnostics,
  getConfigPath,
  getInfo,
  getSurfaceIOSurfaceHandle,
  getSurfaceIOSurfaceId,
  getSurfacePixels,
  getSurfaceSize,
  init,
  isAppCreated,
  isInitialized,
  listSurfaces,
  lookupIOSurfaceHandleById,
  sendSurfaceKey,
  sendSurfaceMouseButton,
  sendSurfaceMousePos,
  sendSurfaceMouseScroll,
  sendSurfaceText,
  setSurfaceFocus,
  setSurfaceSize,
  surfaceMouseCaptured,
  validateConfig,
}
export type {
  ActionEvent,
  ConfigDiagnostics,
  CreateAppOptions,
  CreateAppResult,
  CreateSurfaceOptions,
  GhosttyConfigValidation,
  GhosttyInfo,
  IOSurfaceHandle,
  IOSurfaceInfo,
  KeyAction,
  KeyEvent,
  MouseButton,
  MouseButtonEvent,
  MousePosEvent,
  MouseScrollEvent,
  MouseState,
  SurfaceHandle,
  SurfacePixels,
  SurfaceSize,
}
