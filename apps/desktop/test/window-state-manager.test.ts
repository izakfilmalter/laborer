import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
})
