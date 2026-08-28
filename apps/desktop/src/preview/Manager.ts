// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module name.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabDefaults,
  DesktopPreviewTabState,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  PreviewAnnotationSubmissionResult,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from '@laborer/shared/desktop-bridge'
import {
  BrowserWindow,
  clipboard,
  nativeImage,
  shell,
  type WebContents,
  webContents,
} from 'electron'
import { BrowserSession } from './BrowserSession.js'
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  MOUSE_NAVIGATE_CHANNEL,
  PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL,
  PREVIEW_POINTER_EVENT_CHANNEL,
  PREVIEW_RECORDING_FRAME_CHANNEL,
  PREVIEW_STATE_CHANGE_CHANNEL,
  START_PICK_CHANNEL,
} from './channels.js'
import {
  fitPictureInPictureContentSize,
  PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON,
} from './picture-in-picture-layout.js'
import { PREVIEW_WEBVIEW_PREFERENCES } from './WebviewPreferences.js'

const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
  5,
] as const
const DEFAULT_ZOOM_FACTOR = 1
const MAX_EVALUATION_BYTES = 64_000
const MAX_VISIBLE_TEXT_LENGTH = 20_000
const MAX_INTERACTIVE_ELEMENTS = 200
const MAX_SCREENSHOT_WIDTH = 1280
const FRAME_INTERVAL_MS = Math.ceil(1000 / 12)
const FRAME_JPEG_QUALITY = 80
const MAX_TAB_ID_LENGTH = 4096
const MAX_URL_LENGTH = 2048
const LOOPBACK_PREFIX_PATTERN =
  /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i
const ROLE_LOCATOR_PATTERN =
  /^role=([^[]+)(?:\[name=(?:'([^']*)'|"([^"]*)")\])?$/
const KEY_MODIFIERS = {
  Alt: 'alt',
  Control: 'control',
  Meta: 'meta',
  Shift: 'shift',
} as const satisfies Record<
  NonNullable<PreviewAutomationPressInput['modifiers']>[number],
  NonNullable<Electron.KeyboardInputEvent['modifiers']>[number]
>

const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  accent: 'rgb(0 0 0 / 4%)',
  accentForeground: 'oklch(0.269 0 0)',
  background: 'white',
  border: 'rgb(0 0 0 / 8%)',
  colorScheme: 'light',
  fontMono: 'ui-monospace, monospace',
  fontSans: 'system-ui, sans-serif',
  foreground: 'oklch(0.269 0 0)',
  input: 'rgb(0 0 0 / 10%)',
  muted: 'rgb(0 0 0 / 4%)',
  mutedForeground: 'oklch(0.556 0 0)',
  popover: 'white',
  popoverForeground: 'oklch(0.269 0 0)',
  primary: 'oklch(0.488 0.217 264)',
  primaryForeground: 'white',
  radius: '0.625rem',
  ring: 'oklch(0.488 0.217 264)',
}

interface ManagedTab {
  cleanup: (() => void) | null
  owner: WebContents
  state: DesktopPreviewTabState
}

interface PickSession {
  readonly cancel: () => void
  readonly promise: Promise<PreviewAnnotationSubmissionResult | null>
}

interface FrameSession {
  readonly consumers: Set<'picture-in-picture' | 'recording'>
  readonly timer: ReturnType<typeof setInterval>
}

function assertTabId(tabId: unknown): asserts tabId is string {
  if (
    typeof tabId !== 'string' ||
    tabId.length === 0 ||
    tabId.length > MAX_TAB_ID_LENGTH ||
    tabId.trim() !== tabId
  ) {
    throw new Error('Invalid preview tab id')
  }
}

export function normalizePreviewUrl(rawUrl: string): string {
  const input = rawUrl.trim()
  if (input.length === 0 || input.length > MAX_URL_LENGTH) {
    throw new Error('Invalid preview URL')
  }
  const candidate = input.includes('://')
    ? input
    : `${LOOPBACK_PREFIX_PATTERN.test(input) ? 'http' : 'https'}://${input}`
  const parsed = new URL(candidate)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported preview URL protocol: ${parsed.protocol}`)
  }
  return parsed.href
}

export function isSafePreviewNavigation(url: string): boolean {
  if (url === 'about:blank') {
    return true
  }
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeZoom(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_ZOOM_FACTOR
  }
  return ZOOM_LEVELS.reduce((closest, level) =>
    Math.abs(level - value) < Math.abs(closest - value) ? level : closest
  )
}

function nextZoom(current: number, direction: 'in' | 'out'): number {
  const closest = ZOOM_LEVELS.reduce(
    (best, level, index) =>
      Math.abs(level - current) < Math.abs(ZOOM_LEVELS[best] ?? 1 - current)
        ? index
        : best,
    0
  )
  const index = direction === 'in' ? closest + 1 : closest - 1
  return ZOOM_LEVELS[Math.max(0, Math.min(index, ZOOM_LEVELS.length - 1))] ?? 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteRect(value: unknown): value is PreviewAnnotationRect {
  return (
    isRecord(value) &&
    ['x', 'y', 'width', 'height'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key])
    ) &&
    (value.width as number) > 0 &&
    (value.height as number) > 0
  )
}

function isAnnotationPayload(
  value: unknown
): value is PreviewAnnotationPayload {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.pageUrl === 'string' &&
    (value.pageTitle === null || typeof value.pageTitle === 'string') &&
    typeof value.comment === 'string' &&
    typeof value.createdAt === 'string' &&
    Array.isArray(value.elements) &&
    Array.isArray(value.regions) &&
    Array.isArray(value.strokes) &&
    Array.isArray(value.styleChanges) &&
    value.screenshot === null
  )
}

function buildPictureInPictureDataUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body,img{width:100%;height:100%;margin:0}body{background:#111;overflow:hidden}img{object-fit:contain}</style></head><body><img id="frame" alt="Live browser preview"><script>window.previewPictureInPicture.onFrame((next)=>{document.getElementById('frame').src='data:image/jpeg;base64,'+next.data})</script></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export class PreviewManager {
  readonly #tabs = new Map<string, ManagedTab>()
  readonly #browserSessions = new BrowserSession()
  readonly #pickSessions = new Map<string, PickSession>()
  readonly #frameSessions = new Map<string, FrameSession>()
  readonly #pictureInPictureWindows = new Map<string, BrowserWindow>()
  readonly #pictureInPictureAspectRatios = new Map<string, number>()
  readonly #artifactDirectory: string
  readonly #pickPreloadUrl: string | null
  readonly #pictureInPicturePreloadPath: string
  #annotationTheme = DEFAULT_ANNOTATION_THEME
  #pointerSequence = 0

  constructor(options: {
    artifactDirectory: string
    pickPreloadUrl: string | null
    pictureInPicturePreloadPath: string
  }) {
    this.#artifactDirectory = resolve(options.artifactDirectory)
    this.#pickPreloadUrl = options.pickPreloadUrl
    this.#pictureInPicturePreloadPath = options.pictureInPicturePreloadPath
  }

  get pickPreloadUrl(): string | null {
    return this.#pickPreloadUrl
  }

  get webviewPreferences(): string {
    return PREVIEW_WEBVIEW_PREFERENCES
  }

  getBrowserSession(scope?: string) {
    return this.#browserSessions.getSession(scope)
  }

  getBrowserPartition(scope?: string): string {
    return this.#browserSessions.getPartition(scope)
  }

  isBrowserPartition(partition: string): boolean {
    return this.#browserSessions.isPartition(partition)
  }

  createTab(
    owner: WebContents,
    tabId: string,
    defaults?: DesktopPreviewTabDefaults
  ): void {
    assertTabId(tabId)
    const existing = this.#tabs.get(tabId)
    if (existing) {
      this.#assertOwner(existing, owner)
      this.#emit(existing)
      return
    }
    const now = new Date().toISOString()
    const managed: ManagedTab = {
      cleanup: null,
      owner,
      state: {
        audioMuted: false,
        audible: false,
        canGoBack: false,
        canGoForward: false,
        colorScheme: defaults?.colorScheme ?? 'system',
        controller: 'none',
        navStatus: { kind: 'Idle' },
        pictureInPicture: false,
        tabId,
        updatedAt: now,
        webContentsId: null,
        zoomFactor: normalizeZoom(defaults?.zoomFactor),
      },
    }
    this.#tabs.set(tabId, managed)
    this.#emit(managed)
  }

  async closeTab(owner: WebContents, tabId: string): Promise<void> {
    const tab = this.#requireTab(owner, tabId)
    this.cancelPickElement(owner, tabId)
    await this.closePictureInPicture(owner, tabId)
    this.#stopFrameCapture(tabId, 'recording')
    tab.cleanup?.()
    this.#tabs.delete(tabId)
    this.#emitState(owner, tabId, {
      ...tab.state,
      audioMuted: false,
      audible: false,
      canGoBack: false,
      canGoForward: false,
      colorScheme: 'system',
      controller: 'none',
      navStatus: { kind: 'Idle' },
      pictureInPicture: false,
      updatedAt: new Date().toISOString(),
      webContentsId: null,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
    })
  }

  async registerWebview(
    owner: WebContents,
    tabId: string,
    webContentsId: number
  ): Promise<void> {
    const tab = this.#requireTab(owner, tabId)
    const guest = webContents.fromId(webContentsId)
    if (
      !guest ||
      guest.isDestroyed() ||
      guest.getType() !== 'webview' ||
      guest.hostWebContents !== owner
    ) {
      throw new Error(`Invalid preview webContents ${webContentsId}`)
    }

    if (tab.state.webContentsId === webContentsId && tab.cleanup) {
      guest.setZoomFactor(tab.state.zoomFactor)
      guest.setAudioMuted(tab.state.audioMuted)
      guest.send(ANNOTATION_THEME_CHANNEL, this.#annotationTheme)
      return
    }

    tab.cleanup?.()
    tab.cleanup = this.#attachGuest(tab, guest)
    guest.setZoomFactor(tab.state.zoomFactor)
    guest.setAudioMuted(tab.state.audioMuted)
    const { favicon: _favicon, ...stateWithoutFavicon } = tab.state
    tab.state = {
      ...stateWithoutFavicon,
      audible: guest.isCurrentlyAudible(),
      canGoBack: guest.navigationHistory.canGoBack(),
      canGoForward: guest.navigationHistory.canGoForward(),
      navStatus: this.#readNavStatus(guest),
      updatedAt: new Date().toISOString(),
      webContentsId,
    }
    this.#emit(tab)
    guest.send(ANNOTATION_THEME_CHANNEL, this.#annotationTheme)
    await this.#applyColorScheme(guest, tab.state.colorScheme).catch(
      () => undefined
    )
  }

  async navigate(
    owner: WebContents,
    tabId: string,
    rawUrl: string
  ): Promise<void> {
    const tab = this.#requireTab(owner, tabId)
    const url = normalizePreviewUrl(rawUrl)
    const currentTitle =
      tab.state.navStatus.kind === 'Idle' ? '' : tab.state.navStatus.title
    this.#update(tab, {
      navStatus: { kind: 'Loading', title: currentTitle, url },
    })
    const guest = this.#guest(tab, false)
    if (!guest) {
      return
    }
    if (guest.getURL() === url) {
      guest.reload()
      return
    }
    await guest.loadURL(url)
  }

  goBack(owner: WebContents, tabId: string): void {
    const guest = this.#requireGuest(owner, tabId)
    if (guest.navigationHistory.canGoBack()) {
      guest.navigationHistory.goBack()
    }
  }

  goForward(owner: WebContents, tabId: string): void {
    const guest = this.#requireGuest(owner, tabId)
    if (guest.navigationHistory.canGoForward()) {
      guest.navigationHistory.goForward()
    }
  }

  refresh(owner: WebContents, tabId: string): void {
    this.#requireGuest(owner, tabId).reload()
  }

  stop(owner: WebContents, tabId: string): void {
    this.#requireGuest(owner, tabId).stop()
  }

  hardReload(owner: WebContents, tabId: string): void {
    this.#requireGuest(owner, tabId).reloadIgnoringCache()
  }

  zoomIn(owner: WebContents, tabId: string): void {
    this.#setZoom(owner, tabId, (current) => nextZoom(current, 'in'))
  }

  zoomOut(owner: WebContents, tabId: string): void {
    this.#setZoom(owner, tabId, (current) => nextZoom(current, 'out'))
  }

  resetZoom(owner: WebContents, tabId: string): void {
    this.#setZoom(owner, tabId, () => DEFAULT_ZOOM_FACTOR)
  }

  reapplyZoom(owner?: WebContents): void {
    for (const tab of this.#tabs.values()) {
      if (owner && tab.owner !== owner) {
        continue
      }
      const guest = this.#guest(tab, false)
      if (guest) {
        guest.setZoomFactor(tab.state.zoomFactor)
      }
    }
  }

  async setColorScheme(
    owner: WebContents,
    tabId: string,
    colorScheme: DesktopPreviewColorScheme
  ): Promise<void> {
    const tab = this.#requireTab(owner, tabId)
    this.#update(tab, { colorScheme })
    const guest = this.#guest(tab, false)
    if (guest) {
      await this.#applyColorScheme(guest, colorScheme)
    }
  }

  setAudioMuted(owner: WebContents, tabId: string, audioMuted: boolean): void {
    const tab = this.#requireTab(owner, tabId)
    this.#guest(tab, false)?.setAudioMuted(audioMuted)
    this.#update(tab, { audioMuted })
  }

  openDevTools(owner: WebContents, tabId: string): void {
    const guest = this.#requireGuest(owner, tabId)
    if (guest.debugger.isAttached()) {
      guest.debugger.detach()
    }
    if (guest.isDevToolsOpened()) {
      guest.devToolsWebContents?.focus()
    } else {
      guest.openDevTools({ mode: 'detach' })
    }
  }

  clearCookies(): Promise<void> {
    return this.#browserSessions.clearCookies()
  }

  clearCache(): Promise<void> {
    return this.#browserSessions.clearCache()
  }

  setAnnotationTheme(theme: DesktopPreviewAnnotationTheme): void {
    this.#annotationTheme = theme
    for (const tab of this.#tabs.values()) {
      this.#guest(tab, false)?.send(ANNOTATION_THEME_CHANNEL, theme)
    }
  }

  pickElement(
    owner: WebContents,
    tabId: string
  ): Promise<PreviewAnnotationSubmissionResult | null> {
    const guest = this.#requireGuest(owner, tabId)
    this.cancelPickElement(owner, tabId)

    let settle: (value: PreviewAnnotationSubmissionResult | null) => void =
      () => undefined
    const promise = new Promise<PreviewAnnotationSubmissionResult | null>(
      (resolvePromise) => {
        settle = resolvePromise
      }
    )
    const cleanup = () => {
      guest.ipc.removeListener(ELEMENT_PICKED_CHANNEL, onPicked)
      guest.removeListener('destroyed', onCancelled)
      guest.removeListener('did-start-navigation', onCancelled)
      this.#pickSessions.delete(tabId)
    }
    const finish = (result: PreviewAnnotationSubmissionResult | null) => {
      cleanup()
      settle(result)
    }
    const onCancelled = () => finish(null)
    const onPicked = async (_event: unknown, ...args: unknown[]) => {
      const payload = args[0]
      if (!isAnnotationPayload(payload)) {
        finish(null)
        return
      }
      const rect = isFiniteRect(args[1]) ? args[1] : null
      const submission = args[2] === 'send' ? 'send' : 'attach'
      try {
        const image = await guest.capturePage(
          rect
            ? {
                height: Math.ceil(rect.height),
                width: Math.ceil(rect.width),
                x: Math.max(0, Math.floor(rect.x)),
                y: Math.max(0, Math.floor(rect.y)),
              }
            : undefined
        )
        const size = image.getSize()
        finish({
          annotation: {
            ...payload,
            screenshot: {
              cropRect: rect ?? {
                height: size.height,
                width: size.width,
                x: 0,
                y: 0,
              },
              dataUrl: image.toDataURL(),
              height: size.height,
              width: size.width,
            },
          },
          submission,
        })
      } catch {
        finish({ annotation: payload, submission })
      } finally {
        if (!guest.isDestroyed()) {
          guest.send(ANNOTATION_CAPTURED_CHANNEL)
        }
      }
    }
    const session: PickSession = {
      cancel: () => {
        cleanup()
        if (!guest.isDestroyed()) {
          guest.send(CANCEL_PICK_CHANNEL)
        }
        settle(null)
      },
      promise,
    }
    this.#pickSessions.set(tabId, session)
    guest.ipc.on(ELEMENT_PICKED_CHANNEL, onPicked)
    guest.once('destroyed', onCancelled)
    guest.once('did-start-navigation', onCancelled)
    guest.focus()
    guest.send(START_PICK_CHANNEL, this.#annotationTheme)
    return promise
  }

  cancelPickElement(owner: WebContents, tabId: string): void {
    this.#requireTab(owner, tabId)
    this.#pickSessions.get(tabId)?.cancel()
  }

  async captureScreenshot(
    owner: WebContents,
    tabId: string
  ): Promise<DesktopPreviewScreenshotArtifact> {
    const guest = this.#requireGuest(owner, tabId)
    const image = await guest.capturePage()
    const data = image.toPNG()
    const createdAt = new Date().toISOString()
    const id = `browser-screenshot-${Date.now().toString(36)}`
    const path = join(this.#artifactDirectory, `${id}.png`)
    await mkdir(this.#artifactDirectory, { recursive: true })
    await writeFile(path, data)
    return {
      createdAt,
      id,
      mimeType: 'image/png',
      path,
      sizeBytes: data.byteLength,
      tabId,
    }
  }

  revealArtifact(path: string): void {
    shell.showItemInFolder(this.#resolveArtifact(path))
  }

  async copyArtifactToClipboard(path: string): Promise<void> {
    const data = await readFile(this.#resolveArtifact(path))
    const image = nativeImage.createFromBuffer(data)
    if (image.isEmpty()) {
      throw new Error('Preview artifact is not an image')
    }
    clipboard.writeImage(image)
  }

  async openPictureInPicture(owner: WebContents, tabId: string): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    const existing = this.#pictureInPictureWindows.get(tabId)
    if (existing && !existing.isDestroyed()) {
      existing.showInactive()
      return
    }
    const window = new BrowserWindow({
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: '#111111',
      fullscreenable: false,
      height: 320,
      maximizable: false,
      minimizable: false,
      minHeight: 160,
      minWidth: 240,
      resizable: true,
      show: false,
      skipTaskbar: true,
      title: guest.getTitle().trim()
        ? `Preview - ${guest.getTitle().trim()}`
        : 'Browser preview',
      width: 480,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: this.#pictureInPicturePreloadPath,
        sandbox: true,
      },
    })
    this.#pictureInPictureWindows.set(tabId, window)
    window.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
    window.once('closed', () => {
      if (this.#pictureInPictureWindows.get(tabId) === window) {
        this.#pictureInPictureWindows.delete(tabId)
        this.#pictureInPictureAspectRatios.delete(tabId)
        this.#stopFrameCapture(tabId, 'picture-in-picture')
        const current = this.#tabs.get(tabId)
        if (current) {
          this.#update(current, { pictureInPicture: false })
        }
      }
    })
    await window.loadURL(buildPictureInPictureDataUrl())
    this.#startFrameCapture(tabId, 'picture-in-picture')
    this.#update(this.#requireTab(owner, tabId), { pictureInPicture: true })
    window.showInactive()
  }

  closePictureInPicture(owner: WebContents, tabId: string): Promise<void> {
    this.#requireTab(owner, tabId)
    this.#stopFrameCapture(tabId, 'picture-in-picture')
    const window = this.#pictureInPictureWindows.get(tabId)
    this.#pictureInPictureWindows.delete(tabId)
    this.#pictureInPictureAspectRatios.delete(tabId)
    if (window && !window.isDestroyed()) {
      window.close()
    }
    const tab = this.#tabs.get(tabId)
    if (tab) {
      this.#update(tab, { pictureInPicture: false })
    }
    return Promise.resolve()
  }

  startRecording(owner: WebContents, tabId: string): void {
    this.#requireGuest(owner, tabId)
    this.#startFrameCapture(tabId, 'recording')
  }

  stopRecording(owner: WebContents, tabId: string): void {
    this.#requireTab(owner, tabId)
    this.#stopFrameCapture(tabId, 'recording')
  }

  async saveRecording(
    owner: WebContents,
    tabId: string,
    mimeType: string,
    data: Uint8Array
  ): Promise<DesktopPreviewRecordingArtifact> {
    this.#requireTab(owner, tabId)
    const createdAt = new Date().toISOString()
    const id = `browser-recording-${Date.now().toString(36)}`
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm'
    const path = join(this.#artifactDirectory, `${id}.${extension}`)
    await mkdir(this.#artifactDirectory, { recursive: true })
    await writeFile(path, data)
    return { createdAt, id, mimeType, path, sizeBytes: data.byteLength, tabId }
  }

  automationStatus(owner: WebContents, tabId: string): PreviewAutomationStatus {
    const tab = this.#requireTab(owner, tabId)
    const guest = this.#guest(tab, false)
    if (!guest) {
      const status = tab.state.navStatus
      return {
        available: false,
        loading: status.kind === 'Loading',
        tabId,
        title: status.kind === 'Idle' ? null : status.title,
        url: status.kind === 'Idle' ? null : status.url,
        visible: true,
      }
    }
    return {
      available: true,
      loading: guest.isLoading(),
      tabId,
      title: guest.getTitle() || null,
      url: guest.getURL() || null,
      visible: true,
    }
  }

  async automationSnapshot(
    owner: WebContents,
    tabId: string
  ): Promise<PreviewAutomationSnapshot> {
    const guest = this.#requireGuest(owner, tabId)
    return await this.#withDebugger(guest, async (send) => {
      const page = (await this.#evaluate(
        send,
        `(() => {
        const selectorFor = (element) => {
          if (element.id) return '#' + CSS.escape(element.id)
          const testId = element.getAttribute('data-testid')
          if (testId) return element.tagName.toLowerCase() + '[data-testid=' + JSON.stringify(testId) + ']'
          return element.tagName.toLowerCase()
        }
        const visible = (element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
        }
        return {
          url: location.href,
          title: document.title,
          loading: document.readyState !== 'complete',
          visibleText: (document.body?.innerText || '').slice(0, ${MAX_VISIBLE_TEXT_LENGTH}),
          interactiveElements: Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role],[tabindex]')).filter(visible).slice(0, ${MAX_INTERACTIVE_ELEMENTS}).map((element) => {
            const rect = element.getBoundingClientRect()
            return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), name: element.getAttribute('aria-label') || element.innerText || element.getAttribute('name') || '', selector: selectorFor(element), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          })
        }
      })()`
      )) as Omit<
        PreviewAutomationSnapshot,
        | 'accessibilityTree'
        | 'actionTimeline'
        | 'consoleEntries'
        | 'networkEntries'
        | 'screenshot'
      >
      const [accessibilityTree, sourceImage] = await Promise.all([
        send('Accessibility.getFullAXTree'),
        guest.capturePage(),
      ])
      const sourceSize = sourceImage.getSize()
      const image =
        sourceSize.width > MAX_SCREENSHOT_WIDTH
          ? sourceImage.resize({ width: MAX_SCREENSHOT_WIDTH })
          : sourceImage
      const size = image.getSize()
      return {
        ...page,
        accessibilityTree,
        actionTimeline: [],
        consoleEntries: [],
        networkEntries: [],
        screenshot: {
          data: image.toPNG().toString('base64'),
          height: size.height,
          mimeType: 'image/png',
          width: size.width,
        },
      }
    })
  }

  async automationClick(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationClickInput
  ): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    await this.#withDebugger(guest, async (send) => {
      const point =
        typeof input.x === 'number' && typeof input.y === 'number'
          ? { x: input.x, y: input.y }
          : ((await this.#evaluate(
              send,
              `(() => { const element = ${this.#elementExpression(input)}; if (!element) return null; element.scrollIntoView({block:'center',inline:'center'}); const rect=element.getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2} })()`
            )) as { x: number; y: number } | null)
      if (!(point && Number.isFinite(point.x) && Number.isFinite(point.y))) {
        throw new Error('Preview automation target was not found')
      }
      this.#emitPointer(tabId, 'move', point.x, point.y)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      this.#emitPointer(tabId, 'click', point.x, point.y)
      await send('Input.dispatchMouseEvent', {
        button: 'left',
        clickCount: 1,
        type: 'mousePressed',
        ...point,
      })
      await send('Input.dispatchMouseEvent', {
        button: 'left',
        clickCount: 1,
        type: 'mouseReleased',
        ...point,
      })
    })
  }

  async automationType(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationTypeInput
  ): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    await this.#withDebugger(guest, async (send) => {
      const result = await this.#evaluate(
        send,
        `(() => { const element=${this.#elementExpression(input, true)}; if (!element) return 'not-found'; const editable=element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element.isContentEditable; if (!editable||element.disabled||element.readOnly) return 'not-editable'; element.focus(); const text=${JSON.stringify(input.text)}; if (${input.clear === true}) { if ('value' in element) element.value=''; else element.textContent=''; } if ('value' in element) element.value += text; else element.textContent=(element.textContent||'')+text; element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text})); element.dispatchEvent(new Event('change',{bubbles:true})); return 'ok' })()`
      )
      if (result !== 'ok') {
        throw new Error(`Preview automation target is ${String(result)}`)
      }
    })
  }

  automationPress(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationPressInput
  ): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    const modifiers: NonNullable<Electron.KeyboardInputEvent['modifiers']> =
      input.modifiers?.map((modifier) => KEY_MODIFIERS[modifier]) ?? []
    guest.sendInputEvent({
      keyCode: input.key,
      modifiers,
      type: 'keyDown',
    })
    guest.sendInputEvent({
      keyCode: input.key,
      modifiers,
      type: 'keyUp',
    })
    return Promise.resolve()
  }

  async automationScroll(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationScrollInput
  ): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    await this.#withDebugger(guest, async (send) => {
      const result = await this.#evaluate(
        send,
        `(() => { const target=${this.#elementExpression(input, true, 'window')}; if (!target) return false; target.scrollBy({left:${input.deltaX ?? 0},top:${input.deltaY ?? 0},behavior:'instant'}); return true })()`
      )
      if (result !== true) {
        throw new Error('Preview automation scroll target was not found')
      }
    })
  }

  async automationEvaluate(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationEvaluateInput
  ): Promise<unknown> {
    const guest = this.#requireGuest(owner, tabId)
    if (
      input.expression.length === 0 ||
      input.expression.length > MAX_EVALUATION_BYTES
    ) {
      throw new Error('Invalid preview evaluation expression')
    }
    return await this.#withDebugger(guest, async (send) => {
      const value = await this.#evaluate(
        send,
        input.expression,
        input.awaitPromise ?? true,
        input.returnByValue ?? true
      )
      if (
        Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') >
        MAX_EVALUATION_BYTES
      ) {
        throw new Error('Preview evaluation result is too large')
      }
      return value
    })
  }

  async automationWaitFor(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationWaitForInput
  ): Promise<void> {
    const guest = this.#requireGuest(owner, tabId)
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 15_000, 1), 60_000)
    await this.#withDebugger(guest, async (send) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() <= deadline) {
        const matched = await this.#evaluate(
          send,
          `(() => Boolean(${this.#elementExpression(input, true, 'true')}) && ${input.text ? `(document.body?.innerText||'').includes(${JSON.stringify(input.text)})` : 'true'} && ${input.urlIncludes ? `location.href.includes(${JSON.stringify(input.urlIncludes)})` : 'true'})()`
        )
        if (matched === true) {
          return
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
      throw new Error(`Preview condition did not match within ${timeoutMs}ms`)
    })
  }

  disposeWindow(owner: WebContents): void {
    for (const [tabId, tab] of [...this.#tabs.entries()]) {
      if (tab.owner !== owner) {
        continue
      }
      this.#pickSessions.get(tabId)?.cancel()
      this.#stopFrameCapture(tabId, 'recording')
      this.#stopFrameCapture(tabId, 'picture-in-picture')
      this.#pictureInPictureWindows.get(tabId)?.close()
      tab.cleanup?.()
      this.#tabs.delete(tabId)
    }
  }

  dispose(): void {
    for (const tab of this.#tabs.values()) {
      this.disposeWindow(tab.owner)
    }
  }

  #assertOwner(tab: ManagedTab, owner: WebContents): void {
    if (tab.owner !== owner || owner.isDestroyed()) {
      throw new Error('Preview tab does not belong to this renderer')
    }
  }

  #requireTab(owner: WebContents, tabId: string): ManagedTab {
    assertTabId(tabId)
    const tab = this.#tabs.get(tabId)
    if (!tab) {
      throw new Error(`Preview tab not found: ${tabId}`)
    }
    this.#assertOwner(tab, owner)
    return tab
  }

  #guest(tab: ManagedTab, required: boolean): WebContents | null {
    const id = tab.state.webContentsId
    const guest = id === null ? null : webContents.fromId(id)
    if (
      !guest ||
      guest.isDestroyed() ||
      guest.getType() !== 'webview' ||
      guest.hostWebContents !== tab.owner
    ) {
      if (required) {
        throw new Error(
          `Preview tab ${tab.state.tabId} has no webview registered`
        )
      }
      return null
    }
    return guest
  }

  #requireGuest(owner: WebContents, tabId: string): WebContents {
    return this.#guest(this.#requireTab(owner, tabId), true) as WebContents
  }

  #emit(tab: ManagedTab): void {
    this.#emitState(tab.owner, tab.state.tabId, tab.state)
  }

  #emitState(
    owner: WebContents,
    tabId: string,
    state: DesktopPreviewTabState
  ): void {
    if (!owner.isDestroyed()) {
      owner.send(PREVIEW_STATE_CHANGE_CHANNEL, tabId, state)
    }
  }

  #update(tab: ManagedTab, patch: Partial<DesktopPreviewTabState>): void {
    tab.state = { ...tab.state, ...patch, updatedAt: new Date().toISOString() }
    this.#emit(tab)
  }

  #readNavStatus(guest: WebContents): DesktopPreviewTabState['navStatus'] {
    const url = guest.getURL()
    if (!url || url === 'about:blank') {
      return { kind: 'Idle' }
    }
    return guest.isLoading()
      ? { kind: 'Loading', title: guest.getTitle(), url }
      : { kind: 'Success', title: guest.getTitle(), url }
  }

  #syncGuest(tab: ManagedTab, guest: WebContents): void {
    if (this.#guest(tab, false) !== guest) {
      return
    }
    this.#update(tab, {
      audible: guest.isCurrentlyAudible(),
      canGoBack: guest.navigationHistory.canGoBack(),
      canGoForward: guest.navigationHistory.canGoForward(),
      navStatus: this.#readNavStatus(guest),
    })
  }

  #attachGuest(tab: ManagedTab, guest: WebContents): () => void {
    const sync = () => this.#syncGuest(tab, guest)
    const failed = (
      _event: unknown,
      code: number,
      description: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => {
      if (code === -3 || !isMainFrame || this.#guest(tab, false) !== guest) {
        return
      }
      this.#update(tab, {
        navStatus: {
          code,
          description,
          kind: 'LoadFailed',
          title: guest.getTitle(),
          url: validatedUrl || guest.getURL(),
        },
      })
    }
    const favicon = (_event: unknown, candidates: string[]) => {
      this.#captureFavicon(tab, guest, candidates).catch(() => undefined)
    }
    const audio = (_event: unknown, details: { audible: boolean }) => {
      if (
        this.#guest(tab, false) === guest &&
        tab.state.audible !== details.audible
      ) {
        this.#update(tab, { audible: details.audible })
      }
    }
    const destroyed = () => {
      if (tab.state.webContentsId === guest.id) {
        tab.cleanup?.()
        tab.cleanup = null
        const { favicon: _favicon, ...stateWithoutFavicon } = tab.state
        tab.state = {
          ...stateWithoutFavicon,
          audible: false,
          updatedAt: new Date().toISOString(),
          webContentsId: null,
        }
        this.#emit(tab)
      }
    }
    const humanInput = () => {
      this.#update(tab, { controller: 'human' })
      setTimeout(() => {
        if (
          this.#tabs.get(tab.state.tabId) === tab &&
          tab.state.controller === 'human'
        ) {
          this.#update(tab, { controller: 'none' })
        }
      }, 750)
    }
    const mouseNavigate = (_event: unknown, payload: unknown) => {
      if (!isRecord(payload)) {
        return
      }
      if (payload.direction === 'back' && guest.navigationHistory.canGoBack()) {
        guest.navigationHistory.goBack()
      } else if (
        payload.direction === 'forward' &&
        guest.navigationHistory.canGoForward()
      ) {
        guest.navigationHistory.goForward()
      }
    }
    const beforeInput = (event: Electron.Event, input: Electron.Input) => {
      if (
        input.type === 'keyDown' &&
        input.key.toLowerCase() === 'r' &&
        (input.meta || input.control) &&
        !input.shift &&
        !input.alt
      ) {
        event.preventDefault()
        guest.reload()
      }
    }
    const willNavigate = (event: Electron.Event, url: string) => {
      if (!isSafePreviewNavigation(url)) {
        event.preventDefault()
      }
    }

    guest.on('did-navigate', sync)
    guest.on('did-navigate-in-page', sync)
    guest.on('page-title-updated', sync)
    guest.on('did-start-loading', sync)
    guest.on('did-stop-loading', sync)
    guest.on('did-fail-load', failed)
    guest.on('page-favicon-updated', favicon)
    ;(
      guest as unknown as {
        on: (event: string, listener: (...args: never[]) => void) => void
      }
    ).on('audio-state-changed', audio as never)
    guest.once('destroyed', destroyed)
    guest.on('before-input-event', beforeInput)
    guest.on('will-navigate', willNavigate)
    guest.ipc.on(HUMAN_INPUT_CHANNEL, humanInput)
    guest.ipc.on(MOUSE_NAVIGATE_CHANNEL, mouseNavigate)
    guest.setWindowOpenHandler(({ url }) => {
      if (isSafePreviewNavigation(url)) {
        guest.loadURL(url).catch(() => undefined)
      }
      return { action: 'deny' }
    })

    return () => {
      guest.removeListener('did-navigate', sync)
      guest.removeListener('did-navigate-in-page', sync)
      guest.removeListener('page-title-updated', sync)
      guest.removeListener('did-start-loading', sync)
      guest.removeListener('did-stop-loading', sync)
      guest.removeListener('did-fail-load', failed)
      guest.removeListener('page-favicon-updated', favicon)
      ;(
        guest as unknown as {
          removeListener: (
            event: string,
            listener: (...args: never[]) => void
          ) => void
        }
      ).removeListener('audio-state-changed', audio as never)
      guest.removeListener('destroyed', destroyed)
      guest.removeListener('before-input-event', beforeInput)
      guest.removeListener('will-navigate', willNavigate)
      guest.ipc.removeListener(HUMAN_INPUT_CHANNEL, humanInput)
      guest.ipc.removeListener(MOUSE_NAVIGATE_CHANNEL, mouseNavigate)
    }
  }

  async #captureFavicon(
    tab: ManagedTab,
    guest: WebContents,
    candidates: readonly string[]
  ): Promise<void> {
    const pageUrl = guest.getURL()
    let pageOrigin: string
    try {
      pageOrigin = new URL(pageUrl).origin
    } catch {
      return
    }
    for (const rawCandidate of candidates.slice(0, 8)) {
      try {
        const candidate = new URL(rawCandidate, pageUrl)
        if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') {
          continue
        }
        const response = await guest.session.fetch(candidate.href, {
          credentials: candidate.origin === pageOrigin ? 'include' : 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) {
          continue
        }
        const data = Buffer.from(await response.arrayBuffer())
        if (data.byteLength === 0 || data.byteLength > 100_000) {
          continue
        }
        const source = nativeImage.createFromBuffer(data)
        if (source.isEmpty()) {
          continue
        }
        const image = source.resize({ height: 32, width: 32 })
        if (
          this.#guest(tab, false) !== guest ||
          new URL(guest.getURL()).origin !== pageOrigin
        ) {
          return
        }
        this.#update(tab, {
          favicon: {
            capturedAt: Date.now(),
            dataUrl: image.toDataURL(),
            pageUrl: pageOrigin,
          },
        })
        return
      } catch {
        // Try the next bounded candidate.
      }
    }
  }

  #setZoom(
    owner: WebContents,
    tabId: string,
    transform: (current: number) => number
  ): void {
    const tab = this.#requireTab(owner, tabId)
    const zoomFactor = transform(tab.state.zoomFactor)
    this.#guest(tab, false)?.setZoomFactor(zoomFactor)
    this.#update(tab, { zoomFactor })
  }

  async #applyColorScheme(
    guest: WebContents,
    colorScheme: DesktopPreviewColorScheme
  ): Promise<void> {
    await this.#withDebugger(guest, (send) =>
      send('Emulation.setEmulatedMedia', {
        features: [
          {
            name: 'prefers-color-scheme',
            value: colorScheme === 'system' ? '' : colorScheme,
          },
        ],
      })
    )
  }

  #resolveArtifact(path: string): string {
    const resolvedPath = resolve(path)
    const relativePath = relative(this.#artifactDirectory, resolvedPath)
    if (
      relativePath.length === 0 ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error('Preview artifact path is outside the artifact directory')
    }
    return resolvedPath
  }

  #startFrameCapture(
    tabId: string,
    consumer: 'picture-in-picture' | 'recording'
  ): void {
    const existing = this.#frameSessions.get(tabId)
    if (existing) {
      existing.consumers.add(consumer)
      return
    }
    const consumers = new Set<typeof consumer>([consumer])
    const capture = () => this.#captureFrame(tabId).catch(() => undefined)
    const timer = setInterval(capture, FRAME_INTERVAL_MS)
    timer.unref()
    this.#frameSessions.set(tabId, { consumers, timer })
    capture()
  }

  #stopFrameCapture(
    tabId: string,
    consumer: 'picture-in-picture' | 'recording'
  ): void {
    const session = this.#frameSessions.get(tabId)
    if (!session) {
      return
    }
    session.consumers.delete(consumer)
    if (session.consumers.size === 0) {
      clearInterval(session.timer)
      this.#frameSessions.delete(tabId)
    }
  }

  async #captureFrame(tabId: string): Promise<void> {
    const session = this.#frameSessions.get(tabId)
    const tab = this.#tabs.get(tabId)
    const guest = tab ? this.#guest(tab, false) : null
    if (!(session && tab && guest)) {
      return
    }
    try {
      const image = await guest.capturePage()
      if (
        this.#frameSessions.get(tabId) !== session ||
        this.#guest(tab, false) !== guest
      ) {
        return
      }
      const size = image.getSize()
      if (size.width <= 0 || size.height <= 0) {
        return
      }
      const frame: DesktopPreviewRecordingFrame = {
        data: image.toJPEG(FRAME_JPEG_QUALITY).toString('base64'),
        height: size.height,
        receivedAt: new Date().toISOString(),
        tabId,
        width: size.width,
      }
      if (session.consumers.has('recording') && !tab.owner.isDestroyed()) {
        tab.owner.send(PREVIEW_RECORDING_FRAME_CHANNEL, frame)
      }
      if (session.consumers.has('picture-in-picture')) {
        const window = this.#pictureInPictureWindows.get(tabId)
        if (window && !window.isDestroyed()) {
          const aspectRatio = frame.width / frame.height
          const previousAspectRatio =
            this.#pictureInPictureAspectRatios.get(tabId)
          if (
            previousAspectRatio === undefined ||
            Math.abs(previousAspectRatio - aspectRatio) >
              PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON
          ) {
            const [width, height] = fitPictureInPictureContentSize(
              window.getContentSize(),
              aspectRatio
            )
            window.setAspectRatio(0)
            window.setContentSize(width, height, false)
            window.setAspectRatio(aspectRatio)
            this.#pictureInPictureAspectRatios.set(tabId, aspectRatio)
          }
          window.webContents.send(
            PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL,
            frame
          )
        }
      }
    } catch {
      // Chromium may not have a compositor frame yet; the next tick retries.
    }
  }

  #emitPointer(
    tabId: string,
    phase: 'click' | 'move',
    x: number,
    y: number
  ): void {
    const tab = this.#tabs.get(tabId)
    if (!tab || tab.owner.isDestroyed()) {
      return
    }
    const event: DesktopPreviewPointerEvent = {
      createdAt: new Date().toISOString(),
      phase,
      sequence: this.#pointerSequence++,
      tabId,
      x,
      y,
    }
    tab.owner.send(PREVIEW_POINTER_EVENT_CHANNEL, event)
  }

  async #withDebugger<A>(
    guest: WebContents,
    use: (
      send: (
        method: string,
        params?: Record<string, unknown>
      ) => Promise<unknown>
    ) => Promise<A>
  ): Promise<A> {
    if (guest.isDevToolsOpened()) {
      throw new Error('Close preview DevTools before using browser automation')
    }
    if (guest.debugger.isAttached()) {
      throw new Error('Another debugger owns this preview webview')
    }
    guest.debugger.attach('1.3')
    const send = (method: string, params?: Record<string, unknown>) =>
      guest.debugger.sendCommand(method, params)
    try {
      await Promise.all([send('Runtime.enable'), send('Accessibility.enable')])
      return await use(send)
    } finally {
      if (guest.debugger.isAttached()) {
        guest.debugger.detach()
      }
    }
  }

  async #evaluate(
    send: (
      method: string,
      params?: Record<string, unknown>
    ) => Promise<unknown>,
    expression: string,
    awaitPromise = true,
    returnByValue = true
  ): Promise<unknown> {
    const response = (await send('Runtime.evaluate', {
      awaitPromise,
      expression,
      returnByValue,
      userGesture: true,
    })) as {
      exceptionDetails?: { exception?: { description?: string }; text?: string }
      result?: { value?: unknown }
    }
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          'Preview evaluation failed'
      )
    }
    return response.result?.value
  }

  #elementExpression(
    input: { locator?: string; selector?: string },
    optional = false,
    fallback = 'null'
  ): string {
    const raw = input.locator ?? input.selector
    if (!raw) {
      return optional ? fallback : 'null'
    }
    const locator = raw.trim()
    if (locator.startsWith('css=')) {
      return `document.querySelector(${JSON.stringify(locator.slice(4))})`
    }
    const role = ROLE_LOCATOR_PATTERN.exec(locator)
    if (role) {
      const roleName = role[1]
      const accessibleName = role[2] ?? role[3]
      let nativeSelector = '*'
      if (roleName === 'button') {
        nativeSelector = 'button'
      } else if (roleName === 'textbox') {
        nativeSelector = 'input,textarea'
      }
      return `Array.from(document.querySelectorAll('[role=${JSON.stringify(roleName)}],${nativeSelector}')).find((element)=>${accessibleName === undefined ? 'true' : `(element.getAttribute('aria-label')||element.textContent||'').trim()===${JSON.stringify(accessibleName)}`})||null`
    }
    if (locator.startsWith('text=')) {
      return `Array.from(document.querySelectorAll('*')).find((element)=>element.textContent?.includes(${JSON.stringify(locator.slice(5))}))||null`
    }
    return `document.querySelector(${JSON.stringify(locator)})`
  }
}
