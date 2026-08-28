// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module naming.
import type { DesktopPreviewRecordingFrame } from '@laborer/shared/desktop-bridge'
import { BrowserWindow, type WebContents } from 'electron'
import {
  PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL,
  PREVIEW_RECORDING_FRAME_CHANNEL,
} from './channels.js'
import {
  fitPictureInPictureContentSize,
  PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON,
} from './picture-in-picture-layout.js'

const FRAME_INTERVAL_MS = Math.ceil(1000 / 12)
const FRAME_JPEG_QUALITY = 80

interface FrameSession {
  readonly consumers: Set<'picture-in-picture' | 'recording'>
  readonly timer: ReturnType<typeof setInterval>
}

interface CaptureRuntime {
  readonly guest: WebContents
  readonly owner: WebContents
}

function buildPictureInPictureDataUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body,img{width:100%;height:100%;margin:0}body{background:#111;overflow:hidden}img{object-fit:contain}</style></head><body><img id="frame" alt="Live browser preview"><script>window.previewPictureInPicture.onFrame((next)=>{document.getElementById('frame').src='data:image/jpeg;base64,'+next.data})</script></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export class PreviewCapture {
  readonly #aspectRatios = new Map<string, number>()
  readonly #frameSessions = new Map<string, FrameSession>()
  readonly #getRuntime: (tabId: string) => CaptureRuntime | null
  readonly #pictureInPicturePreloadPath: string
  readonly #setPictureInPicture: (tabId: string, open: boolean) => void
  readonly #windows = new Map<string, BrowserWindow>()

  constructor(options: {
    getRuntime: (tabId: string) => CaptureRuntime | null
    pictureInPicturePreloadPath: string
    setPictureInPicture: (tabId: string, open: boolean) => void
  }) {
    this.#getRuntime = options.getRuntime
    this.#pictureInPicturePreloadPath = options.pictureInPicturePreloadPath
    this.#setPictureInPicture = options.setPictureInPicture
  }

  async openPictureInPicture(
    tabId: string,
    guest: WebContents,
    markOpen: () => void
  ): Promise<void> {
    const existing = this.#windows.get(tabId)
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
    this.#windows.set(tabId, window)
    window.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
    window.once('closed', () => {
      if (this.#windows.get(tabId) === window) {
        this.#windows.delete(tabId)
        this.#aspectRatios.delete(tabId)
        this.#stopFrameCapture(tabId, 'picture-in-picture')
        this.#setPictureInPicture(tabId, false)
      }
    })
    await window.loadURL(buildPictureInPictureDataUrl())
    this.#startFrameCapture(tabId, 'picture-in-picture')
    markOpen()
    window.showInactive()
  }

  closePictureInPicture(tabId: string): void {
    this.#stopFrameCapture(tabId, 'picture-in-picture')
    const window = this.#windows.get(tabId)
    this.#windows.delete(tabId)
    this.#aspectRatios.delete(tabId)
    if (window && !window.isDestroyed()) {
      window.close()
    }
    this.#setPictureInPicture(tabId, false)
  }

  startRecording(tabId: string): void {
    this.#startFrameCapture(tabId, 'recording')
  }

  stopRecording(tabId: string): void {
    this.#stopFrameCapture(tabId, 'recording')
  }

  disposeTab(tabId: string): void {
    this.#stopFrameCapture(tabId, 'recording')
    this.#stopFrameCapture(tabId, 'picture-in-picture')
    const window = this.#windows.get(tabId)
    this.#windows.delete(tabId)
    this.#aspectRatios.delete(tabId)
    if (window && !window.isDestroyed()) {
      window.close()
    }
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
    const runtime = this.#getRuntime(tabId)
    if (!(session && runtime)) {
      return
    }
    const { guest, owner } = runtime
    try {
      const image = await guest.capturePage()
      if (
        this.#frameSessions.get(tabId) !== session ||
        this.#getRuntime(tabId)?.guest !== guest
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
      if (session.consumers.has('recording') && !owner.isDestroyed()) {
        owner.send(PREVIEW_RECORDING_FRAME_CHANNEL, frame)
      }
      if (session.consumers.has('picture-in-picture')) {
        this.#sendPictureInPictureFrame(tabId, frame)
      }
    } catch {
      // Chromium may not have a compositor frame yet; the next tick retries.
    }
  }

  #sendPictureInPictureFrame(
    tabId: string,
    frame: DesktopPreviewRecordingFrame
  ): void {
    const window = this.#windows.get(tabId)
    if (!window || window.isDestroyed()) {
      return
    }
    const aspectRatio = frame.width / frame.height
    const previousAspectRatio = this.#aspectRatios.get(tabId)
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
      this.#aspectRatios.set(tabId, aspectRatio)
    }
    window.webContents.send(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, frame)
  }
}
