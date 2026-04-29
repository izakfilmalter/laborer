import { afterEach, describe, expect, it } from 'vitest'
import { getBackendRpcWsUrl, getBackendSyncWsUrl } from '../src/lib/desktop'

type WindowWithBackendBridge = Window & {
  desktopBridge?:
    | {
        getBackendWsUrl: () => string | null
      }
    | undefined
}

afterEach(() => {
  ;(window as unknown as WindowWithBackendBridge).desktopBridge = undefined
})

describe('desktop backend URL helpers', () => {
  it('builds the RPC URL with the query token preserved', () => {
    ;(window as unknown as WindowWithBackendBridge).desktopBridge = {
      getBackendWsUrl: () => 'ws://127.0.0.1:53792/?token=secret-token',
    }

    expect(getBackendRpcWsUrl()).toBe(
      'ws://127.0.0.1:53792/rpc?token=secret-token'
    )
  })

  it('builds the sync URL with token in the path so LiveStore can append query params', () => {
    ;(window as unknown as WindowWithBackendBridge).desktopBridge = {
      getBackendWsUrl: () => 'ws://127.0.0.1:53792/?token=secret-token',
    }

    expect(getBackendSyncWsUrl()).toBe('ws://127.0.0.1:53792/sync/secret-token')
  })
})
