import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isAuthorizedSyncWebSocketUrl,
  isAuthorizedWebSocketUrl,
  readBootstrapConfig,
} from '../src/server-runtime.js'

const openFds: number[] = []
const tempFiles: string[] = []

afterEach(() => {
  while (openFds.length > 0) {
    const fd = openFds.pop()
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
  while (tempFiles.length > 0) {
    const path = tempFiles.pop()
    if (path !== undefined) {
      unlinkSync(path)
    }
  }
})

describe('server runtime bootstrap', () => {
  it('prefers one-time bootstrap fd config over inherited environment', () => {
    const path = join(process.cwd(), `server-bootstrap-${Date.now()}.json`)
    writeFileSync(
      path,
      JSON.stringify({
        authToken: 'bootstrap-token',
        host: '127.0.0.1',
        port: 17_321,
      })
    )
    tempFiles.push(path)
    const fd = openSync(path, 'r')
    openFds.push(fd)

    expect(
      readBootstrapConfig(['node', 'main.mjs', '--bootstrap-fd', String(fd)], {
        LABORER_SERVER_AUTH_TOKEN: 'env-token',
        LABORER_SERVER_PORT: '2100',
      })
    ).toEqual({ authToken: 'bootstrap-token', host: '127.0.0.1', port: 17_321 })
  })

  it('authorizes websocket URLs only when the token matches', () => {
    expect(
      isAuthorizedWebSocketUrl(new URL('ws://127.0.0.1:2100/rpc'), undefined)
    ).toBe(true)
    expect(
      isAuthorizedWebSocketUrl(
        new URL('ws://127.0.0.1:2100/rpc?token=secret-token'),
        'secret-token'
      )
    ).toBe(true)
    expect(
      isAuthorizedWebSocketUrl(
        new URL('ws://127.0.0.1:2100/rpc?token=wrong-token'),
        'secret-token'
      )
    ).toBe(false)
  })

  it('authorizes sync websocket URLs with token in the path', () => {
    expect(
      isAuthorizedSyncWebSocketUrl(
        new URL('ws://127.0.0.1:2100/sync/secret-token?storeId=laborer'),
        'secret-token'
      )
    ).toBe(true)
    expect(
      isAuthorizedSyncWebSocketUrl(
        new URL('ws://127.0.0.1:2100/sync/wrong-token?storeId=laborer'),
        'secret-token'
      )
    ).toBe(false)
  })
})
