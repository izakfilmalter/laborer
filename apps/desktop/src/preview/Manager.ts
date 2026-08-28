// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module name.
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabDefaults,
  DesktopPreviewTabState,
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
import type { WebContents } from 'electron'
import { webContents } from 'electron'
import { PreviewArtifacts } from './Artifacts.js'
import { PreviewAutomation } from './Automation.js'
import { BrowserSession } from './BrowserSession.js'
import { PreviewCapture } from './Capture.js'
import {
  ANNOTATION_THEME_CHANNEL,
  PREVIEW_STATE_CHANGE_CHANNEL,
} from './channels.js'
import {
  type ManagedPreviewTab,
  PreviewGuestLifecycle,
} from './GuestLifecycle.js'
import { PREVIEW_WEBVIEW_PREFERENCES } from './WebviewPreferences.js'

const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
  5,
] as const
const DEFAULT_ZOOM_FACTOR = 1
const MAX_TAB_ID_LENGTH = 4096
const MAX_URL_LENGTH = 2048
const LOOPBACK_PREFIX_PATTERN =
  /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i

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

export class PreviewManager {
  readonly #tabs = new Map<string, ManagedPreviewTab>()
  readonly #browserSessions = new BrowserSession()
  readonly #automation = new PreviewAutomation({
    getPointerOwner: (tabId) => {
      const tab = this.#tabs.get(tabId)
      return tab && !tab.owner.isDestroyed() ? tab.owner : null
    },
    requireGuest: (owner, tabId) => this.#requireGuest(owner, tabId),
  })
  readonly #artifacts: PreviewArtifacts
  readonly #capture: PreviewCapture
  readonly #guests: PreviewGuestLifecycle
  readonly #pickPreloadUrl: string | null

  constructor(options: {
    artifactDirectory: string
    pickPreloadUrl: string | null
    pictureInPicturePreloadPath: string
  }) {
    this.#artifacts = new PreviewArtifacts({
      artifactDirectory: options.artifactDirectory,
      forEachGuest: (use) => {
        for (const tab of this.#tabs.values()) {
          const guest = this.#guest(tab, false)
          if (guest) {
            use(guest)
          }
        }
      },
    })
    this.#capture = new PreviewCapture({
      getRuntime: (tabId) => {
        const tab = this.#tabs.get(tabId)
        const guest = tab ? this.#guest(tab, false) : null
        return tab && guest ? { guest, owner: tab.owner } : null
      },
      pictureInPicturePreloadPath: options.pictureInPicturePreloadPath,
      setPictureInPicture: (tabId, pictureInPicture) => {
        const tab = this.#tabs.get(tabId)
        if (tab) {
          this.#update(tab, { pictureInPicture })
        }
      },
    })
    this.#guests = new PreviewGuestLifecycle({
      emit: (tab) => this.#emit(tab),
      getGuest: (tab) => this.#guest(tab, false),
      isCurrentTab: (tab) => this.#tabs.get(tab.state.tabId) === tab,
      isSafeNavigation: isSafePreviewNavigation,
      update: (tab, patch) => this.#update(tab, patch),
    })
    this.#pickPreloadUrl = options.pickPreloadUrl
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
    const managed: ManagedPreviewTab = {
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
    this.#capture.stopRecording(tabId)
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
      guest.send(ANNOTATION_THEME_CHANNEL, this.#artifacts.annotationTheme)
      return
    }

    tab.cleanup?.()
    tab.cleanup = this.#guests.attach(tab, guest)
    guest.setZoomFactor(tab.state.zoomFactor)
    guest.setAudioMuted(tab.state.audioMuted)
    const { favicon: _favicon, ...stateWithoutFavicon } = tab.state
    tab.state = {
      ...stateWithoutFavicon,
      audible: guest.isCurrentlyAudible(),
      canGoBack: guest.navigationHistory.canGoBack(),
      canGoForward: guest.navigationHistory.canGoForward(),
      navStatus: this.#guests.readNavStatus(guest),
      updatedAt: new Date().toISOString(),
      webContentsId,
    }
    this.#emit(tab)
    guest.send(ANNOTATION_THEME_CHANNEL, this.#artifacts.annotationTheme)
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
    this.#automation.openDevTools(owner, tabId)
  }

  clearCookies(): Promise<void> {
    return this.#browserSessions.clearCookies()
  }

  clearCache(): Promise<void> {
    return this.#browserSessions.clearCache()
  }

  setAnnotationTheme(theme: DesktopPreviewAnnotationTheme): void {
    this.#artifacts.setAnnotationTheme(theme)
  }

  pickElement(
    owner: WebContents,
    tabId: string
  ): Promise<PreviewAnnotationSubmissionResult | null> {
    return this.#artifacts.pickElement(tabId, this.#requireGuest(owner, tabId))
  }

  cancelPickElement(owner: WebContents, tabId: string): void {
    this.#requireTab(owner, tabId)
    this.#artifacts.cancelPickElement(tabId)
  }

  async captureScreenshot(
    owner: WebContents,
    tabId: string
  ): Promise<DesktopPreviewScreenshotArtifact> {
    return await this.#artifacts.captureScreenshot(
      tabId,
      this.#requireGuest(owner, tabId)
    )
  }

  revealArtifact(path: string): void {
    this.#artifacts.revealArtifact(path)
  }

  async copyArtifactToClipboard(path: string): Promise<void> {
    await this.#artifacts.copyArtifactToClipboard(path)
  }

  async openPictureInPicture(owner: WebContents, tabId: string): Promise<void> {
    const tab = this.#requireTab(owner, tabId)
    const guest = this.#guest(tab, true) as WebContents
    await this.#capture.openPictureInPicture(tabId, guest, () => {
      this.#assertOwner(tab, owner)
      if (this.#tabs.get(tabId) !== tab || this.#guest(tab, false) !== guest) {
        throw new Error(`Preview tab changed while opening PiP: ${tabId}`)
      }
      this.#update(tab, { pictureInPicture: true })
    })
  }

  closePictureInPicture(owner: WebContents, tabId: string): Promise<void> {
    this.#requireTab(owner, tabId)
    this.#capture.closePictureInPicture(tabId)
    return Promise.resolve()
  }

  startRecording(owner: WebContents, tabId: string): void {
    this.#requireGuest(owner, tabId)
    this.#capture.startRecording(tabId)
  }

  stopRecording(owner: WebContents, tabId: string): void {
    this.#requireTab(owner, tabId)
    this.#capture.stopRecording(tabId)
  }

  async saveRecording(
    owner: WebContents,
    tabId: string,
    mimeType: string,
    data: Uint8Array
  ): Promise<DesktopPreviewRecordingArtifact> {
    this.#requireTab(owner, tabId)
    return await this.#artifacts.saveRecording(tabId, mimeType, data)
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
    return await this.#automation.snapshot(owner, tabId)
  }

  async automationClick(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationClickInput
  ): Promise<void> {
    await this.#automation.click(owner, tabId, input)
  }

  async automationType(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationTypeInput
  ): Promise<void> {
    await this.#automation.type(owner, tabId, input)
  }

  automationPress(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationPressInput
  ): Promise<void> {
    return this.#automation.press(owner, tabId, input)
  }

  async automationScroll(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationScrollInput
  ): Promise<void> {
    await this.#automation.scroll(owner, tabId, input)
  }

  async automationEvaluate(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationEvaluateInput
  ): Promise<unknown> {
    return await this.#automation.evaluate(owner, tabId, input)
  }

  async automationWaitFor(
    owner: WebContents,
    tabId: string,
    input: PreviewAutomationWaitForInput
  ): Promise<void> {
    await this.#automation.waitFor(owner, tabId, input)
  }

  disposeWindow(owner: WebContents): void {
    for (const [tabId, tab] of [...this.#tabs.entries()]) {
      if (tab.owner !== owner) {
        continue
      }
      this.#artifacts.cancelPickElement(tabId)
      this.#capture.disposeTab(tabId)
      tab.cleanup?.()
      this.#tabs.delete(tabId)
    }
  }

  dispose(): void {
    for (const tab of this.#tabs.values()) {
      this.disposeWindow(tab.owner)
    }
  }

  #assertOwner(tab: ManagedPreviewTab, owner: WebContents): void {
    if (tab.owner !== owner || owner.isDestroyed()) {
      throw new Error('Preview tab does not belong to this renderer')
    }
  }

  #requireTab(owner: WebContents, tabId: string): ManagedPreviewTab {
    assertTabId(tabId)
    const tab = this.#tabs.get(tabId)
    if (!tab) {
      throw new Error(`Preview tab not found: ${tabId}`)
    }
    this.#assertOwner(tab, owner)
    return tab
  }

  #guest(tab: ManagedPreviewTab, required: boolean): WebContents | null {
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

  #emit(tab: ManagedPreviewTab): void {
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

  #update(
    tab: ManagedPreviewTab,
    patch: Partial<DesktopPreviewTabState>
  ): void {
    tab.state = { ...tab.state, ...patch, updatedAt: new Date().toISOString() }
    this.#emit(tab)
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
    await this.#automation.applyColorScheme(guest, colorScheme)
  }
}
