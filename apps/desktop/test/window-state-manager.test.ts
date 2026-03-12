import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
  },
  screen: {
    getAllDisplays: () => [
      {
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ],
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
  },
}))

import { WindowStateManager } from '../src/window-state.js'

const tempDirs: string[] = []

class MockTrackedWindow {
  readonly handlers = new Map<string, Set<() => void>>()
  private readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  private readonly maximized: boolean

  constructor(
    bounds: {
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    },
    maximized = false
  ) {
    this.bounds = bounds
    this.maximized = maximized
  }

  getNormalBounds() {
    return this.bounds
  }

  isMaximized() {
    return this.maximized
  }

  isDestroyed() {
    return false
  }

  on(event: string, handler: () => void) {
    const handlers = this.handlers.get(event) ?? new Set()
    handlers.add(handler)
    this.handlers.set(event, handlers)
  }

  emit(event: string) {
    const handlers = this.handlers.get(event)

    if (!handlers) {
      return
    }

    for (const handler of handlers) {
      handler()
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('WindowStateManager', () => {
  it('saves and reloads multiple window records from disk', () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'laborer-window-state-'))
    tempDirs.push(userDataDir)

    const manager = new WindowStateManager(userDataDir)

    manager.saveWindowRecords([
      {
        windowId: 'window-alpha',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
      {
        windowId: 'window-beta',
        bounds: { x: 100, y: 200, width: 1200, height: 900 },
        isMaximized: true,
      },
    ])

    expect(manager.loadWindowRecords()).toEqual([
      {
        windowId: 'window-alpha',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
      {
        windowId: 'window-beta',
        bounds: { x: 100, y: 200, width: 1200, height: 900 },
        isMaximized: true,
      },
    ])
  })

  it('preserves a closed window session for later restore', () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'laborer-window-state-'))
    tempDirs.push(userDataDir)

    const manager = new WindowStateManager(userDataDir)

    manager.saveWindowRecords([
      {
        windowId: 'window-alpha',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
      {
        windowId: 'window-beta',
        bounds: { x: 100, y: 200, width: 1200, height: 900 },
        isMaximized: true,
      },
    ])

    const closingWindow = new MockTrackedWindow(
      { x: 10, y: 20, width: 800, height: 600 },
      false
    )

    manager.track(closingWindow as unknown as BrowserWindow, 'window-alpha')
    closingWindow.emit('close')

    expect(manager.loadWindowRecords()).toEqual([
      {
        windowId: 'window-beta',
        bounds: { x: 100, y: 200, width: 1200, height: 900 },
        isMaximized: true,
      },
      {
        windowId: 'window-alpha',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
      },
    ])
  })
})
