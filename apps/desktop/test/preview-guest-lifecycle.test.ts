import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: vi.fn() } }))

import {
  closeOrphanedDevTools,
  type ManagedPreviewTab,
  PreviewGuestLifecycle,
} from '../src/preview/GuestLifecycle.js'

function fakeDevTools() {
  let destroyed = false
  return {
    close: vi.fn(() => {
      destroyed = true
    }),
    isDestroyed: () => destroyed,
  }
}

type FakeDevTools = ReturnType<typeof fakeDevTools>

class FakeGuest extends EventEmitter {
  readonly id = 7
  readonly ipc = new EventEmitter()
  readonly setWindowOpenHandler = vi.fn()
  #alive = true
  #devTools: FakeDevTools | null

  constructor(devTools: FakeDevTools | null) {
    super()
    this.#devTools = devTools
  }

  // Electron nulls the wrapper before emitting `destroyed`; every property
  // access afterwards throws.
  get devToolsWebContents(): FakeDevTools | null {
    if (!this.#alive) {
      throw new Error('Object has been destroyed')
    }
    return this.#devTools
  }

  isDevToolsOpened(): boolean {
    return this.#devTools !== null
  }

  openDevTools(): FakeDevTools {
    this.#devTools = fakeDevTools()
    this.emit('devtools-opened')
    return this.#devTools
  }

  closeDevTools(): void {
    this.#devTools = null
    this.emit('devtools-closed')
  }

  destroy(): void {
    this.#alive = false
    this.emit('destroyed')
  }
}

function fakeGuest(devTools: FakeDevTools | null): FakeGuest {
  return new FakeGuest(devTools)
}

function attach(guest: unknown) {
  const lifecycle = new PreviewGuestLifecycle({
    emit: () => undefined,
    getGuest: () => guest as never,
    isCurrentTab: () => true,
    isSafeNavigation: () => true,
    update: () => undefined,
  })
  const tab: ManagedPreviewTab = {
    cleanup: null,
    owner: { isDestroyed: () => false } as never,
    state: {
      audible: false,
      audioMuted: false,
      canGoBack: false,
      canGoForward: false,
      colorScheme: 'system',
      controller: 'none',
      navStatus: { kind: 'Idle' },
      pictureInPicture: false,
      tabId: 'tab-1',
      updatedAt: '',
      webContentsId: 7,
      zoomFactor: 1,
    } as never,
  }
  tab.cleanup = lifecycle.attach(tab, guest as never)
  return tab
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('PreviewGuestLifecycle DevTools teardown', () => {
  it('closes DevTools that were open when the guest was registered', async () => {
    const devTools = fakeDevTools()
    const guest = fakeGuest(devTools)
    attach(guest)

    guest.destroy()
    expect(devTools.close).not.toHaveBeenCalled()
    await flush()
    expect(devTools.close).toHaveBeenCalledTimes(1)
  })

  it('closes DevTools opened after registration', async () => {
    const guest = fakeGuest(null)
    attach(guest)
    const devTools = guest.openDevTools()

    guest.destroy()
    await flush()
    expect(devTools.close).toHaveBeenCalledTimes(1)
  })

  it('does nothing when DevTools were closed before the guest died', async () => {
    const guest = fakeGuest(null)
    attach(guest)
    const devTools = guest.openDevTools()
    guest.closeDevTools()

    guest.destroy()
    await flush()
    expect(devTools.close).not.toHaveBeenCalled()
  })

  it('ignores DevTools already destroyed by Electron', () => {
    const devTools = fakeDevTools()
    devTools.close()
    devTools.close.mockClear()
    closeOrphanedDevTools(devTools as never)
    expect(devTools.close).not.toHaveBeenCalled()
    closeOrphanedDevTools(null)
  })
})
