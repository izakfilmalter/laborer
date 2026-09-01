import type { DesktopBridge } from '@laborer/shared/desktop-bridge'
import { PreviewCreateTabRequestSchema } from '@laborer/shared/desktop-bridge'
import { Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() =>
  vi.fn((_channel: string, _payload?: unknown) => Promise.resolve(undefined))
)
const exposed = vi.hoisted(() => new Map<string, unknown>())

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.set(key, value)
    },
  },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
}))

await import('../src/preload.js')

const bridge = exposed.get('desktopBridge') as Required<DesktopBridge>

describe('preload preview.createTab payload', () => {
  // Structured clone preserves keys whose value is undefined, so a preload that
  // spells out absent defaults must still satisfy the main-process schema.
  it('decodes when the renderer supplies no tab defaults', async () => {
    invoke.mockClear()
    await bridge.preview.createTab('workspace:epoch:tab_1')

    expect(
      Schema.decodeUnknownSync(PreviewCreateTabRequestSchema)(
        invoke.mock.calls[0]?.[1]
      )
    ).toMatchObject({ tabId: 'workspace:epoch:tab_1' })
  })

  it('decodes the defaults the renderer supplies', async () => {
    invoke.mockClear()
    await bridge.preview.createTab('workspace:epoch:tab_1', {
      colorScheme: 'dark',
      zoomFactor: 1.25,
    })

    expect(
      Schema.decodeUnknownSync(PreviewCreateTabRequestSchema)(
        invoke.mock.calls[0]?.[1]
      )
    ).toEqual({
      colorScheme: 'dark',
      tabId: 'workspace:epoch:tab_1',
      zoomFactor: 1.25,
    })
  })
})
