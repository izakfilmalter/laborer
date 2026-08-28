import { Option, Schema } from 'effect'

/**
 * Context menu item definition for native context menus.
 */
export interface ContextMenuItem<T extends string = string> {
  readonly destructive?: boolean
  readonly id: T
  readonly label: string
}

/**
 * Sidecar service names managed by the Electron main process.
 */
export type SidecarName = 'server' | 'terminal' | 'file-watcher'

/**
 * Sidecar status reported to the renderer.
 *
 * - `starting`     — sidecar spawned, waiting for health check
 * - `healthy`      — health check passed, service is reachable
 * - `unresponsive` — process alive but heartbeats stopped (advisory only;
 *                    emitted for status-only services like `terminal`,
 *                    self-heals to `healthy` on the next beat — ADR 0003)
 * - `crashed`      — process exited unexpectedly (includes stderr excerpt)
 * - `restarting`   — automatic restart scheduled, waiting for backoff delay
 */
export type SidecarStatusEvent =
  | { readonly state: 'starting'; readonly name: SidecarName }
  | { readonly state: 'healthy'; readonly name: SidecarName }
  | { readonly state: 'unresponsive'; readonly name: SidecarName }
  | {
      readonly state: 'crashed'
      readonly name: SidecarName
      readonly error: string
    }
  | {
      readonly state: 'restarting'
      readonly name: SidecarName
      readonly delayMs: number
    }

// ---------------------------------------------------------------------------
// Auto-update types
// ---------------------------------------------------------------------------

/** Architecture of the Electron/Node.js process or the host CPU. */
export type DesktopRuntimeArch = 'arm64' | 'x64' | 'other'

/** Runtime architecture information for the current Electron process. */
export interface DesktopRuntimeInfo {
  readonly appArch: DesktopRuntimeArch
  readonly hostArch: DesktopRuntimeArch
  readonly runningUnderArm64Translation: boolean
}

/**
 * Status of the auto-update system.
 *
 * - `disabled`    — auto-updates not available (dev build, env-disabled)
 * - `idle`        — enabled but no check has run yet
 * - `checking`    — check in progress
 * - `up-to-date`  — check completed, no update available
 * - `available`   — new version found, ready to download
 * - `downloading` — download in progress
 * - `downloaded`  — download complete, ready to install
 * - `error`       — something failed (see `errorContext`)
 */
export type DesktopUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/** Full state of the auto-update system, broadcast to the renderer. */
export interface DesktopUpdateState {
  readonly appArch: DesktopRuntimeArch
  readonly availableVersion: string | null
  readonly canRetry: boolean
  readonly checkedAt: string | null
  readonly currentVersion: string
  readonly downloadedVersion: string | null
  readonly downloadPercent: number | null
  readonly enabled: boolean
  readonly errorContext: 'check' | 'download' | 'install' | null
  readonly hostArch: DesktopRuntimeArch
  readonly message: string | null
  readonly runningUnderArm64Translation: boolean
  readonly status: DesktopUpdateStatus
}

/** Result of a user-initiated update action (download or install). */
export interface DesktopUpdateActionResult {
  readonly accepted: boolean
  readonly completed: boolean
  readonly state: DesktopUpdateState
}

// ---------------------------------------------------------------------------
// App quit types
// ---------------------------------------------------------------------------

/**
 * Reason the app is shutting down, sent to renderers via `onBeforeQuit`.
 *
 * - `quit`   — user explicitly quit the app (Cmd+Q, tray Quit, app.quit())
 * - `reload` — the window is being reloaded (not a full app quit)
 */
export type QuitReason = 'quit' | 'reload'

/**
 * Payload sent from the main process to the renderer participating in quit
 * negotiation. The renderer must call `respondToQuit` with `veto: true` to
 * block the quit or `veto: false` to allow it.
 */
export interface BeforeQuitPayload {
  /** Unique ID for this quit request, used to correlate the response. */
  readonly id: string
  /** Why the app is shutting down. */
  readonly reason: QuitReason
}

/** Main-to-renderer intent used for workspace and terminal click routing. */
export const WorkspaceActivationIntentSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(['open-agent-pane']),
    initialPrompt: Schema.optional(Schema.String),
    workspaceId: Schema.String,
  }),
  Schema.Struct({
    terminalId: Schema.optional(Schema.String),
    workspaceId: Schema.String,
  }),
])

export type WorkspaceActivationIntent =
  typeof WorkspaceActivationIntentSchema.Type

export interface WorkspaceActivationRequest {
  readonly action: 'open-agent-pane'
  readonly initialPrompt?: string | undefined
}

const decodeWorkspaceActivation = Schema.decodeUnknownOption(
  WorkspaceActivationIntentSchema
)

export function decodeWorkspaceActivationIntent(
  value: unknown
): WorkspaceActivationIntent | undefined {
  return Option.getOrUndefined(decodeWorkspaceActivation(value))
}

/** Renderer-reported workspace metadata used only as notification context. */
export interface WorkspaceNotificationContext {
  readonly branchName: string
  readonly workspaceId: string
}

// ---------------------------------------------------------------------------
// Desktop browser preview types
// ---------------------------------------------------------------------------

export type DesktopPreviewColorScheme = 'system' | 'light' | 'dark'

export type DesktopPreviewNavStatus =
  | { readonly kind: 'Idle' }
  | { readonly kind: 'Loading'; readonly title: string; readonly url: string }
  | { readonly kind: 'Success'; readonly title: string; readonly url: string }
  | {
      readonly kind: 'LoadFailed'
      readonly code: number
      readonly description: string
      readonly title: string
      readonly url: string
    }

export interface DesktopPreviewFavicon {
  readonly capturedAt: number
  readonly dataUrl: string
  readonly pageUrl: string
}

export interface DesktopPreviewTabState {
  readonly audible: boolean
  readonly audioMuted: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly colorScheme: DesktopPreviewColorScheme
  readonly controller: 'agent' | 'human' | 'none'
  readonly favicon?: DesktopPreviewFavicon
  readonly navStatus: DesktopPreviewNavStatus
  readonly pictureInPicture: boolean
  readonly tabId: string
  readonly updatedAt: string
  readonly webContentsId: number | null
  readonly zoomFactor: number
}

export interface DesktopPreviewTabDefaults {
  readonly colorScheme?: DesktopPreviewColorScheme
  readonly zoomFactor?: number
}

export interface DesktopPreviewWebviewConfig {
  readonly partition: string
  readonly preloadUrl: string | null
  readonly webPreferences: string
}

export interface DesktopPreviewAnnotationTheme {
  readonly accent: string
  readonly accentForeground: string
  readonly background: string
  readonly border: string
  readonly colorScheme: 'light' | 'dark'
  readonly fontMono: string
  readonly fontSans: string
  readonly foreground: string
  readonly input: string
  readonly muted: string
  readonly mutedForeground: string
  readonly popover: string
  readonly popoverForeground: string
  readonly primary: string
  readonly primaryForeground: string
  readonly radius: string
  readonly ring: string
}

export interface PickedElementStackFrame {
  readonly columnNumber: number | null
  readonly fileName: string | null
  readonly functionName: string | null
  readonly lineNumber: number | null
}

export interface PickedElementPayload {
  readonly componentName: string | null
  readonly htmlPreview: string
  readonly pageTitle: string | null
  readonly pageUrl: string
  readonly pickedAt: string
  readonly selector: string | null
  readonly source: PickedElementStackFrame | null
  readonly stack: readonly PickedElementStackFrame[]
  readonly styles: string
  readonly tagName: string
}

export interface PreviewAnnotationRect {
  readonly height: number
  readonly width: number
  readonly x: number
  readonly y: number
}

export interface PreviewAnnotationPayload {
  readonly comment: string
  readonly createdAt: string
  readonly elements: readonly {
    readonly element: PickedElementPayload
    readonly id: string
    readonly rect: PreviewAnnotationRect
  }[]
  readonly id: string
  readonly pageTitle: string | null
  readonly pageUrl: string
  readonly regions: readonly {
    readonly id: string
    readonly rect: PreviewAnnotationRect
  }[]
  readonly screenshot: {
    readonly cropRect: PreviewAnnotationRect
    readonly dataUrl: string
    readonly height: number
    readonly width: number
  } | null
  readonly strokes: readonly {
    readonly bounds: PreviewAnnotationRect
    readonly color: string
    readonly id: string
    readonly points: readonly { readonly x: number; readonly y: number }[]
    readonly width: number
  }[]
  readonly styleChanges: readonly {
    readonly previousValue: string
    readonly property: string
    readonly selector: string | null
    readonly targetId: string
    readonly value: string
  }[]
}

export interface PreviewAnnotationSubmissionResult {
  readonly annotation: PreviewAnnotationPayload
  readonly submission: 'attach' | 'send'
}

export interface DesktopPreviewArtifact {
  readonly createdAt: string
  readonly id: string
  readonly mimeType: string
  readonly path: string
  readonly sizeBytes: number
  readonly tabId: string
}

export interface DesktopPreviewScreenshotArtifact
  extends DesktopPreviewArtifact {
  readonly mimeType: 'image/png'
}

export type DesktopPreviewRecordingArtifact = DesktopPreviewArtifact

export interface DesktopPreviewRecordingFrame {
  readonly data: string
  readonly height: number
  readonly receivedAt: string
  readonly tabId: string
  readonly width: number
}

export interface DesktopPreviewPointerEvent {
  readonly createdAt: string
  readonly phase: 'click' | 'move'
  readonly sequence: number
  readonly tabId: string
  readonly x: number
  readonly y: number
}

export interface PreviewAutomationStatus {
  readonly available: boolean
  readonly loading: boolean
  readonly tabId: string | null
  readonly title: string | null
  readonly url: string | null
  readonly viewport?: { readonly height: number; readonly width: number }
  readonly visible: boolean
}

export interface PreviewAutomationTarget {
  readonly locator?: string
  readonly selector?: string
}

export interface PreviewAutomationClickInput extends PreviewAutomationTarget {
  readonly timeoutMs?: number
  readonly x?: number
  readonly y?: number
}

export interface PreviewAutomationTypeInput extends PreviewAutomationTarget {
  readonly clear?: boolean
  readonly text: string
  readonly timeoutMs?: number
}

export interface PreviewAutomationPressInput {
  readonly key: string
  readonly modifiers?: readonly ('Alt' | 'Control' | 'Meta' | 'Shift')[]
}

export interface PreviewAutomationScrollInput extends PreviewAutomationTarget {
  readonly deltaX?: number
  readonly deltaY?: number
}

export interface PreviewAutomationEvaluateInput {
  readonly awaitPromise?: boolean
  readonly expression: string
  readonly returnByValue?: boolean
}

export interface PreviewAutomationWaitForInput extends PreviewAutomationTarget {
  readonly text?: string
  readonly timeoutMs?: number
  readonly urlIncludes?: string
}

export interface PreviewAutomationSnapshot {
  readonly accessibilityTree: unknown
  readonly actionTimeline: readonly unknown[]
  readonly consoleEntries: readonly unknown[]
  readonly interactiveElements: readonly {
    readonly height: number
    readonly name: string
    readonly role: string | null
    readonly selector: string
    readonly tag: string
    readonly width: number
    readonly x: number
    readonly y: number
  }[]
  readonly loading: boolean
  readonly networkEntries: readonly unknown[]
  readonly screenshot: {
    readonly data: string
    readonly height: number
    readonly mimeType: 'image/png'
    readonly width: number
  }
  readonly title: string
  readonly url: string
  readonly visibleText: string
}

export interface DesktopPreviewBridge {
  readonly automation: {
    readonly click: (
      tabId: string,
      input: PreviewAutomationClickInput
    ) => Promise<void>
    readonly evaluate: (
      tabId: string,
      input: PreviewAutomationEvaluateInput
    ) => Promise<unknown>
    readonly press: (
      tabId: string,
      input: PreviewAutomationPressInput
    ) => Promise<void>
    readonly scroll: (
      tabId: string,
      input: PreviewAutomationScrollInput
    ) => Promise<void>
    readonly snapshot: (tabId: string) => Promise<PreviewAutomationSnapshot>
    readonly status: (tabId: string) => Promise<PreviewAutomationStatus>
    readonly type: (
      tabId: string,
      input: PreviewAutomationTypeInput
    ) => Promise<void>
    readonly waitFor: (
      tabId: string,
      input: PreviewAutomationWaitForInput
    ) => Promise<void>
  }
  readonly cancelPickElement: (tabId: string) => Promise<void>
  readonly captureScreenshot: (
    tabId: string
  ) => Promise<DesktopPreviewScreenshotArtifact>
  readonly clearCache: () => Promise<void>
  readonly clearCookies: () => Promise<void>
  readonly closeTab: (tabId: string) => Promise<void>
  readonly copyArtifactToClipboard: (path: string) => Promise<void>
  readonly createTab: (
    tabId: string,
    defaults?: DesktopPreviewTabDefaults
  ) => Promise<void>
  readonly getPreviewConfig: (
    environmentId: string
  ) => Promise<DesktopPreviewWebviewConfig>
  readonly goBack: (tabId: string) => Promise<void>
  readonly goForward: (tabId: string) => Promise<void>
  readonly hardReload: (tabId: string) => Promise<void>
  readonly navigate: (tabId: string, url: string) => Promise<void>
  readonly onPointerEvent: (
    listener: (event: DesktopPreviewPointerEvent) => void
  ) => () => void
  readonly onStateChange: (
    listener: (tabId: string, state: DesktopPreviewTabState) => void
  ) => () => void
  readonly openDevTools: (tabId: string) => Promise<void>
  readonly pickElement: (
    tabId: string
  ) => Promise<PreviewAnnotationSubmissionResult | null>
  readonly pictureInPicture: {
    readonly close: (tabId: string) => Promise<void>
    readonly open: (tabId: string) => Promise<void>
  }
  readonly recording: {
    readonly onFrame: (
      listener: (frame: DesktopPreviewRecordingFrame) => void
    ) => () => void
    readonly save: (
      tabId: string,
      mimeType: string,
      data: Uint8Array
    ) => Promise<DesktopPreviewRecordingArtifact>
    readonly startScreencast: (tabId: string) => Promise<void>
    readonly stopScreencast: (tabId: string) => Promise<void>
  }
  readonly refresh: (tabId: string) => Promise<void>
  readonly registerWebview: (
    tabId: string,
    webContentsId: number
  ) => Promise<void>
  readonly resetZoom: (tabId: string) => Promise<void>
  readonly revealArtifact: (path: string) => Promise<void>
  readonly setAnnotationTheme: (
    theme: DesktopPreviewAnnotationTheme
  ) => Promise<void>
  readonly setAudioMuted: (tabId: string, audioMuted: boolean) => Promise<void>
  readonly setColorScheme: (
    tabId: string,
    colorScheme: DesktopPreviewColorScheme
  ) => Promise<void>
  /** Stop an in-flight page load without discarding the current document. */
  readonly stop: (tabId: string) => Promise<void>
  readonly zoomIn: (tabId: string) => Promise<void>
  readonly zoomOut: (tabId: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// DesktopBridge interface
// ---------------------------------------------------------------------------

/**
 * Typed contract between the Electron preload script and the renderer.
 *
 * The preload script implements this interface via `contextBridge.exposeInMainWorld()`,
 * and the renderer accesses it via `window.desktopBridge`. When running outside
 * Electron (e.g., in a plain browser for development), `window.desktopBridge` is
 * undefined and the renderer falls back to browser-native equivalents.
 */
export interface DesktopBridge {
  /** Shows a native confirmation dialog with Yes/No buttons. Returns true if confirmed. */
  confirm: (message: string) => Promise<boolean>

  /** Triggers download of an available update. */
  downloadUpdate: () => Promise<DesktopUpdateActionResult>

  /** Ensures the production daemon is healthy after a connection loss. */
  ensureDaemon: () => Promise<void>

  /**
   * Checks if a workspace is already visible in another window.
   * If so, focuses that window, tells the target renderer to activate
   * the workspace's pane, and returns true. If not, returns false so
   * the caller can proceed with opening the workspace in the current window.
   *
   * Returns false when the workspace is only in the requesting window
   * or is not open in any window.
   */
  focusWindowForWorkspace: (
    workspaceId: string,
    intent?: WorkspaceActivationRequest
  ) => Promise<boolean>

  /** Returns the current auto-update state. */
  getUpdateState: () => Promise<DesktopUpdateState>

  /** Returns the stable identity of the current native window. */
  getWindowId: () => string

  /** Triggers quit-and-install of a downloaded update. */
  installUpdate: () => Promise<DesktopUpdateActionResult>

  /**
   * Subscribes to workspace activation events from the main process.
   * Fired when another window's `focusWindowForWorkspace` call determined
   * this window owns the target workspace. The callback receives the
   * `workspaceId` so the renderer can focus the appropriate pane.
   * Returns an unsubscribe function.
   */
  onActivateWorkspace: (
    listener: (intent: WorkspaceActivationIntent) => void
  ) => () => void

  /**
   * Subscribes to quit requests from the main process.
   *
   * When the main process wants to quit, it sends a `BeforeQuitPayload` to
   * every renderer window. The renderer MUST call `respondToQuit` with the
   * payload's `id` and a `veto` flag. If any window vetoes, the quit is
   * cancelled.
   *
   * Use this to:
   * - Flush pending application state
   * - Prompt the user about running terminals/tasks
   * - Clean up subscriptions and resources
   *
   * Returns an unsubscribe function.
   */
  onBeforeQuit: (listener: (payload: BeforeQuitPayload) => void) => () => void

  /**
   * Subscribes to GitHub OAuth callback events.
   * Fired when the OS routes an `x-github-desktop-dev-auth://oauth?code=...&state=...`
   * URL to the app. The callback receives the full URL string.
   * Returns an unsubscribe function.
   */
  onGithubOAuthCallback: (listener: (url: string) => void) => () => void

  /**
   * Subscribes to application menu actions (e.g., "settings").
   * Returns an unsubscribe function.
   */
  onMenuAction: (listener: (action: string) => void) => () => void

  /**
   * Subscribes to auto-update state changes.
   * Returns an unsubscribe function.
   */
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void

  /** Opens a URL in the user's default browser. Returns true on success. */
  openExternal: (url: string) => Promise<boolean>

  /** Opens a native macOS folder picker dialog. Returns the selected path, or null if cancelled. */
  pickFolder: () => Promise<string | null>

  /** Desktop-only Chromium preview host. Feature-detect this in browser builds. */
  preview?: DesktopPreviewBridge
  /** Continues an already-confirmed application quit. */
  quitApp: () => void

  /** Reports native-window routing context; semantic presence uses daemon RPC. */
  reportWindowWorkspaces: (
    workspaceIds: readonly string[],
    contexts?: readonly WorkspaceNotificationContext[]
  ) => Promise<void>

  /**
   * Responds to a quit request from the main process.
   *
   * @param id    — The `id` from the `BeforeQuitPayload` this is responding to.
   * @param veto  — `true` to block the quit, `false` to allow it to proceed.
   */
  respondToQuit: (id: string, veto: boolean) => void

  /**
   * Shows a native context menu at the cursor or specified position.
   * Returns the `id` of the selected item, or null if dismissed.
   */
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number }
  ) => Promise<T | null>

  /**
   * Opens the GitHub OAuth authorization page in the user's browser.
   * The state parameter is a CSRF token the caller generates and validates
   * when the callback arrives.
   */
  startGithubOAuth: (state: string) => Promise<void>

  /** Updates the system tray tooltip with the current workspace count. */
  updateTrayWorkspaceCount: (count: number) => Promise<void>
}
