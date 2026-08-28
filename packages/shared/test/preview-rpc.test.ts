import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import {
  PreviewEvent,
  PreviewOpenInput,
  PreviewViewportSetting,
} from '../src/rpc.js'

describe('preview RPC schemas', () => {
  it('accepts ordered workspace-scoped events', () => {
    const event = Schema.decodeUnknownSync(PreviewEvent)({
      createdAt: '2026-08-28T00:00:00.000Z',
      revision: 1,
      serverEpoch: 'epoch',
      snapshot: {
        canGoBack: false,
        canGoForward: false,
        navStatus: { _tag: 'Idle' },
        tabId: 'tab_1',
        updatedAt: '2026-08-28T00:00:00.000Z',
        viewport: { _tag: 'fill' },
        workspaceId: 'workspace-a',
      },
      tabId: 'tab_1',
      type: 'opened',
      workspaceId: 'workspace-a',
    })
    expect(event.type).toBe('opened')
  })

  it('rejects oversized custom viewports', () => {
    expect(() =>
      Schema.decodeUnknownSync(PreviewViewportSetting)({
        _tag: 'freeform',
        width: 3840,
        height: 3840,
      })
    ).toThrow()
  })

  it('rejects empty and untrimmed workspace identities', () => {
    expect(() =>
      Schema.decodeUnknownSync(PreviewOpenInput)({ workspaceId: '' })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(PreviewOpenInput)({ workspaceId: ' workspace ' })
    ).toThrow()
  })
})
