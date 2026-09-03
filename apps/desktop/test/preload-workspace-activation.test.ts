import type {
  DesktopBridge,
  WorkspaceActivationIntent,
} from '@laborer/shared/desktop-bridge'
import { describe, expect, it, vi } from 'vitest'

const exposed = vi.hoisted(() => new Map<string, unknown>())
const on = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.set(key, value)
    },
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on,
    removeListener: vi.fn(),
    send: vi.fn(),
  },
}))

await import('../src/preload.js')

const bridge = exposed.get('desktopBridge') as Required<DesktopBridge>

describe('preload workspace activation', () => {
  it('forwards a validated pane-append intent to the renderer', () => {
    const listener = vi.fn<(intent: WorkspaceActivationIntent) => void>()
    bridge.onActivateWorkspace(listener)
    const wrappedListener = on.mock.calls.find(
      ([channel]) => channel === 'desktop:activate-workspace'
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined

    wrappedListener?.(
      {},
      {
        action: 'add-pane',
        direction: 'horizontal',
        panelType: 'agent',
        workspaceId: 'workspace-remote',
      }
    )

    expect(listener).toHaveBeenCalledWith({
      action: 'add-pane',
      direction: 'horizontal',
      panelType: 'agent',
      workspaceId: 'workspace-remote',
    })
  })
})
