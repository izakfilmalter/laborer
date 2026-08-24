import { describe, expect, it } from 'vitest'
import {
  DaemonWindowReloadTracker,
  reloadTargetUrl,
  shouldReloadWindow,
} from '../src/daemon-window-reload.js'

const ORIGIN = 'http://127.0.0.1:2100'
const OTHER_ORIGIN = 'http://127.0.0.1:2101'

describe('shouldReloadWindow', () => {
  it('does not reload when the window loaded the current daemon version', () => {
    expect(
      shouldReloadWindow({
        currentOrigin: ORIGIN,
        currentVersion: '1.2.3',
        loadedOrigin: ORIGIN,
        loadedVersion: '1.2.3',
      })
    ).toBe(false)
  })

  it('reloads when the daemon version differs from the loaded version', () => {
    expect(
      shouldReloadWindow({
        currentOrigin: ORIGIN,
        currentVersion: '1.3.0',
        loadedOrigin: ORIGIN,
        loadedVersion: '1.2.3',
      })
    ).toBe(true)
  })

  it('reloads when the daemon now serves from a different origin', () => {
    expect(
      shouldReloadWindow({
        currentOrigin: OTHER_ORIGIN,
        currentVersion: '1.2.3',
        loadedOrigin: ORIGIN,
        loadedVersion: '1.2.3',
      })
    ).toBe(true)
  })

  it('never reloads when the loaded state is unknown', () => {
    expect(
      shouldReloadWindow({
        currentOrigin: ORIGIN,
        currentVersion: '1.2.3',
        loadedOrigin: null,
        loadedVersion: null,
      })
    ).toBe(false)
  })
})

describe('DaemonWindowReloadTracker', () => {
  const window = 'window-a'

  it('reloads a window loaded from an older daemon version once', () => {
    const tracker = new DaemonWindowReloadTracker<string>()
    tracker.recordLoad(window, '1.2.3')

    const input = {
      currentOrigin: ORIGIN,
      currentVersion: '1.3.0',
      loadedOrigin: ORIGIN,
    }
    expect(tracker.shouldReload(window, input)).toBe(true)
    // The window has not navigated yet, but a repeated ensure completion
    // against the same daemon must not command a second reload.
    expect(tracker.shouldReload(window, input)).toBe(false)
  })

  it('stays quiet when the loaded version matches the current daemon', () => {
    const tracker = new DaemonWindowReloadTracker<string>()
    tracker.recordLoad(window, '1.3.0')
    expect(
      tracker.shouldReload(window, {
        currentOrigin: ORIGIN,
        currentVersion: '1.3.0',
        loadedOrigin: ORIGIN,
      })
    ).toBe(false)
  })

  it('stays quiet for windows with no recorded load', () => {
    const tracker = new DaemonWindowReloadTracker<string>()
    expect(
      tracker.shouldReload(window, {
        currentOrigin: ORIGIN,
        currentVersion: '1.3.0',
        loadedOrigin: null,
      })
    ).toBe(false)
  })

  it('reloads again for the next daemon transition after navigating', () => {
    const tracker = new DaemonWindowReloadTracker<string>()
    tracker.recordLoad(window, '1.2.3')
    expect(
      tracker.shouldReload(window, {
        currentOrigin: ORIGIN,
        currentVersion: '1.3.0',
        loadedOrigin: ORIGIN,
      })
    ).toBe(true)
    // Navigation completed — the document now comes from 1.3.0.
    tracker.recordLoad(window, '1.3.0')
    expect(
      tracker.shouldReload(window, {
        currentOrigin: ORIGIN,
        currentVersion: '1.3.0',
        loadedOrigin: ORIGIN,
      })
    ).toBe(false)
    // A second daemon transition must reload once more.
    expect(
      tracker.shouldReload(window, {
        currentOrigin: ORIGIN,
        currentVersion: '1.4.0',
        loadedOrigin: ORIGIN,
      })
    ).toBe(true)
  })

  it('reloads when the daemon origin moved even with an equal version', () => {
    const tracker = new DaemonWindowReloadTracker<string>()
    tracker.recordLoad(window, '1.3.0')
    const input = {
      currentOrigin: OTHER_ORIGIN,
      currentVersion: '1.3.0',
      loadedOrigin: ORIGIN,
    }
    expect(tracker.shouldReload(window, input)).toBe(true)
    expect(tracker.shouldReload(window, input)).toBe(false)
  })

  it('forgets closed windows entirely', () => {
    const tracker = new DaemonWindowReloadTracker<string>()
    tracker.recordLoad(window, '1.2.3')
    tracker.forget(window)
    expect(
      tracker.shouldReload(window, {
        currentOrigin: ORIGIN,
        currentVersion: '1.3.0',
        loadedOrigin: null,
      })
    ).toBe(false)
  })

  it('tracks windows independently', () => {
    const tracker = new DaemonWindowReloadTracker<string>()
    tracker.recordLoad('window-a', '1.2.3')
    tracker.recordLoad('window-b', '1.3.0')
    const input = {
      currentOrigin: ORIGIN,
      currentVersion: '1.3.0',
      loadedOrigin: ORIGIN,
    }
    expect(tracker.shouldReload('window-a', input)).toBe(true)
    expect(tracker.shouldReload('window-b', input)).toBe(false)
  })
})

describe('reloadTargetUrl', () => {
  it('preserves the in-app route against the new daemon origin', () => {
    expect(
      reloadTargetUrl(`${ORIGIN}/workspaces/abc?tab=logs#pane-2`, OTHER_ORIGIN)
    ).toBe(`${OTHER_ORIGIN}/workspaces/abc?tab=logs#pane-2`)
  })

  it('falls back to the origin for non-http documents', () => {
    expect(reloadTargetUrl('about:blank', ORIGIN)).toBe(ORIGIN)
  })

  it('falls back to the origin for unparseable URLs', () => {
    expect(reloadTargetUrl('', ORIGIN)).toBe(ORIGIN)
  })
})
