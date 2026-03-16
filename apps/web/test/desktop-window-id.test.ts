import { afterEach, describe, expect, it } from 'vitest'

import { getCurrentWindowId } from '@/lib/desktop'

type WindowWithDesktopBridge = Window & {
  desktopBridge?:
    | {
        getWindowId: () => string
      }
    | undefined
}

describe('getCurrentWindowId', () => {
  afterEach(() => {
    ;(window as WindowWithDesktopBridge).desktopBridge = undefined
  })

  it('reads the current electron window id during renderer bootstrap', () => {
    ;(window as WindowWithDesktopBridge).desktopBridge = {
      getWindowId: () => 'window-under-test',
    }

    expect(getCurrentWindowId()).toBe('window-under-test')
  })

  it('returns null outside electron', () => {
    expect(getCurrentWindowId()).toBeNull()
  })
})
