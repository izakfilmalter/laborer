// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module naming.
import type { DesktopPreviewTabState } from '@laborer/shared/desktop-bridge'
import {
  PreviewHumanInputEventSchema,
  PreviewMouseNavigateEventSchema,
} from '@laborer/shared/desktop-bridge'
import { Option, Schema } from 'effect'
import { nativeImage, type WebContents } from 'electron'
import { HUMAN_INPUT_CHANNEL, MOUSE_NAVIGATE_CHANNEL } from './channels.js'

export interface ManagedPreviewTab {
  cleanup: (() => void) | null
  owner: WebContents
  state: DesktopPreviewTabState
}

/**
 * Closes a DevTools WebContents whose inspected `<webview>` guest is already
 * gone.
 *
 * Electron frees an attached guest's `content::WebContents` when the embedder
 * removes the `<webview>` element, but the guest's `api::WebContents` (and the
 * `InspectableWebContents` that owns a detached DevTools window) lives until
 * V8 garbage-collects the wrapper. In that window DevTools still routes input
 * to the freed guest, and a single keystroke segfaults the main process
 * (`InspectableWebContents::HandleKeyboardEvent`, electron/electron#43297).
 * Closing the DevTools WebContents takes Electron's `CloseContents` path,
 * which for guests only tears down the DevTools widget.
 */
export function closeOrphanedDevTools(devTools: WebContents | null): void {
  if (!devTools || devTools.isDestroyed()) {
    return
  }
  try {
    devTools.close()
  } catch {
    // The DevTools WebContents was torn down between the check and the call.
  }
}

export class PreviewGuestLifecycle {
  readonly #emit: (tab: ManagedPreviewTab) => void
  readonly #getGuest: (tab: ManagedPreviewTab) => WebContents | null
  readonly #isCurrentTab: (tab: ManagedPreviewTab) => boolean
  readonly #isSafeNavigation: (url: string) => boolean
  readonly #update: (
    tab: ManagedPreviewTab,
    patch: Partial<DesktopPreviewTabState>
  ) => void

  constructor(options: {
    emit: (tab: ManagedPreviewTab) => void
    getGuest: (tab: ManagedPreviewTab) => WebContents | null
    isCurrentTab: (tab: ManagedPreviewTab) => boolean
    isSafeNavigation: (url: string) => boolean
    update: (
      tab: ManagedPreviewTab,
      patch: Partial<DesktopPreviewTabState>
    ) => void
  }) {
    this.#emit = options.emit
    this.#getGuest = options.getGuest
    this.#isCurrentTab = options.isCurrentTab
    this.#isSafeNavigation = options.isSafeNavigation
    this.#update = options.update
  }

  readNavStatus(guest: WebContents): DesktopPreviewTabState['navStatus'] {
    const url = guest.getURL()
    if (!url || url === 'about:blank') {
      return { kind: 'Idle' }
    }
    return guest.isLoading()
      ? { kind: 'Loading', title: guest.getTitle(), url }
      : { kind: 'Success', title: guest.getTitle(), url }
  }

  attach(tab: ManagedPreviewTab, guest: WebContents): () => void {
    const sync = () => this.#sync(tab, guest)
    const failed = (
      _event: unknown,
      code: number,
      description: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => {
      if (code === -3 || !isMainFrame || this.#getGuest(tab) !== guest) {
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
    const audio = (
      event: Electron.Event<Electron.WebContentsAudioStateChangedEventParams>
    ) => {
      if (
        this.#getGuest(tab) === guest &&
        tab.state.audible !== event.audible
      ) {
        this.#update(tab, { audible: event.audible })
      }
    }
    // Captured while the guest is alive: after `destroyed` fires, every
    // property access on `guest` throws "Object has been destroyed".
    let devTools: WebContents | null = guest.isDevToolsOpened()
      ? (guest.devToolsWebContents ?? null)
      : null
    const devToolsOpened = () => {
      devTools = guest.devToolsWebContents ?? null
    }
    const devToolsClosed = () => {
      devTools = null
    }
    const destroyed = () => {
      const orphanedDevTools = devTools
      devTools = null
      // Defer: `destroyed` is emitted from inside the guest's
      // content::WebContents destructor, and destroying another WebContents
      // re-entrantly from that observer callback is not a path Electron takes.
      setImmediate(() => closeOrphanedDevTools(orphanedDevTools))
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
    const humanInput = (_event: unknown, payload: unknown) => {
      if (
        Option.isNone(
          Schema.decodeUnknownOption(PreviewHumanInputEventSchema)(payload)
        )
      ) {
        return
      }
      this.#update(tab, { controller: 'human' })
      setTimeout(() => {
        if (this.#isCurrentTab(tab) && tab.state.controller === 'human') {
          this.#update(tab, { controller: 'none' })
        }
      }, 750)
    }
    const mouseNavigate = (_event: unknown, payload: unknown) => {
      const decoded = Option.getOrUndefined(
        Schema.decodeUnknownOption(PreviewMouseNavigateEventSchema)(payload)
      )
      if (!decoded) {
        return
      }
      if (decoded.direction === 'back' && guest.navigationHistory.canGoBack()) {
        guest.navigationHistory.goBack()
      } else if (
        decoded.direction === 'forward' &&
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
      if (!this.#isSafeNavigation(url)) {
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
    guest.on('audio-state-changed', audio)
    guest.on('devtools-opened', devToolsOpened)
    guest.on('devtools-closed', devToolsClosed)
    guest.once('destroyed', destroyed)
    guest.on('before-input-event', beforeInput)
    guest.on('will-navigate', willNavigate)
    guest.ipc.on(HUMAN_INPUT_CHANNEL, humanInput)
    guest.ipc.on(MOUSE_NAVIGATE_CHANNEL, mouseNavigate)
    guest.setWindowOpenHandler(({ url }) => {
      if (this.#isSafeNavigation(url)) {
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
      guest.removeListener('audio-state-changed', audio)
      guest.removeListener('devtools-opened', devToolsOpened)
      guest.removeListener('devtools-closed', devToolsClosed)
      guest.removeListener('destroyed', destroyed)
      guest.removeListener('before-input-event', beforeInput)
      guest.removeListener('will-navigate', willNavigate)
      guest.ipc.removeListener(HUMAN_INPUT_CHANNEL, humanInput)
      guest.ipc.removeListener(MOUSE_NAVIGATE_CHANNEL, mouseNavigate)
    }
  }

  #sync(tab: ManagedPreviewTab, guest: WebContents): void {
    if (this.#getGuest(tab) !== guest) {
      return
    }
    this.#update(tab, {
      audible: guest.isCurrentlyAudible(),
      canGoBack: guest.navigationHistory.canGoBack(),
      canGoForward: guest.navigationHistory.canGoForward(),
      navStatus: this.readNavStatus(guest),
    })
  }

  async #captureFavicon(
    tab: ManagedPreviewTab,
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
          this.#getGuest(tab) !== guest ||
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
}
