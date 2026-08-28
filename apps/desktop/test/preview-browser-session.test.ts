import { beforeEach, describe, expect, it, vi } from 'vitest'

interface MockBrowserSession {
  clearCache: ReturnType<typeof vi.fn>
  clearStorageData: ReturnType<typeof vi.fn>
  getUserAgent: ReturnType<typeof vi.fn>
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setUserAgent: ReturnType<typeof vi.fn>
}

const sessions = vi.hoisted(() => new Map<string, MockBrowserSession>())
const fromPartition = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ session: { fromPartition } }))

import { BrowserSession } from '../src/preview/BrowserSession.js'

describe('BrowserSession', () => {
  beforeEach(() => {
    sessions.clear()
    fromPartition.mockReset()
    fromPartition.mockImplementation((partition: string) => {
      const browserSession = {
        clearCache: vi.fn(async () => undefined),
        clearStorageData: vi.fn(async () => undefined),
        getUserAgent: vi.fn(() => 'Mozilla/5.0 Electron/40.6.0 Laborer/0.0.0'),
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        setUserAgent: vi.fn(),
      }
      sessions.set(partition, browserSession)
      return browserSession
    })
  })

  it('derives deterministic persistent partitions and memoizes sessions', () => {
    const host = new BrowserSession()
    expect(host.getPartition('scope-a')).toBe(
      'persist:laborer-preview-f051bb2c68cb7b2fe969'
    )
    expect(host.isPartition(host.getPartition('scope-a'))).toBe(true)
    expect(host.isPartition('persist:untrusted')).toBe(false)
    expect(host.getSession('scope-a')).toBe(host.getSession('scope-a'))
    expect(fromPartition).toHaveBeenCalledTimes(1)
  })

  it('allows t3 clipboard and browser permissions while denying unrelated access', () => {
    const host = new BrowserSession()
    const partition = host.getPartition('scope-a')
    host.getSession('scope-a')
    const browserSession = sessions.get(partition)
    expect(browserSession).toBeDefined()
    if (!browserSession) {
      throw new Error('Expected preview browser session')
    }
    const request =
      browserSession.setPermissionRequestHandler.mock.calls[0]?.[0]
    const check = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0]

    for (const permission of [
      'clipboard-read',
      'clipboard-sanitized-write',
      'notifications',
      'geolocation',
    ]) {
      let granted = false
      request(null, permission, (value: boolean) => {
        granted = value
      })
      expect(granted).toBe(true)
      expect(check(null, permission)).toBe(true)
    }

    for (const permission of ['clipboard-write', 'local-fonts', 'midi']) {
      let granted = true
      request(null, permission, (value: boolean) => {
        granted = value
      })
      expect(granted).toBe(false)
      expect(check(null, permission)).toBe(false)
    }
  })

  it('clears browser storage and cache in every materialized partition', async () => {
    const host = new BrowserSession()
    host.getSession('scope-a')
    host.getSession('scope-b')

    await host.clearCookies()
    await host.clearCache()

    for (const browserSession of sessions.values()) {
      expect(browserSession.clearStorageData).toHaveBeenCalledWith({
        storages: [
          'cookies',
          'localstorage',
          'indexdb',
          'websql',
          'serviceworkers',
        ],
      })
      expect(browserSession.clearCache).toHaveBeenCalledOnce()
    }
  })
})
