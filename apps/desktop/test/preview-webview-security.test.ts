import type { WebPreferences } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { enforcePreviewWebviewSecurity } from '../src/preview/WebviewSecurity.js'

const approvedPreload = 'file:///Applications/Laborer/preview-pick-preload.cjs'
const policy = {
  isApprovedPartition: (partition: string) =>
    partition === 'persist:laborer-preview-workspace-1',
  preloadUrl: approvedPreload,
}

describe('preview webview attachment security', () => {
  it('rejects custom preload injection and unapproved partitions', () => {
    for (const params of [
      {
        partition: 'persist:laborer-preview-workspace-1',
        preload: 'file:///tmp/attacker.cjs',
      },
      { partition: 'persist:attacker', preload: approvedPreload },
      { partition: 'persist:laborer-preview-workspace-1' },
    ]) {
      const event = { preventDefault: vi.fn() }
      expect(enforcePreviewWebviewSecurity(event, {}, params, policy)).toBe(
        false
      )
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
  })

  it('overrides every security-sensitive preference and pins the preload path', () => {
    const event = { preventDefault: vi.fn() }
    const preferences: WebPreferences = {
      allowRunningInsecureContent: true,
      contextIsolation: false,
      enableBlinkFeatures: 'WebUSB',
      experimentalFeatures: true,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      preload: '/tmp/attacker.cjs',
      sandbox: false,
      webSecurity: false,
      webviewTag: true,
    }

    expect(
      enforcePreviewWebviewSecurity(
        event,
        preferences,
        {
          partition: 'persist:laborer-preview-workspace-1',
          preload: approvedPreload,
        },
        policy
      )
    ).toBe(true)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(preferences).toEqual({
      allowRunningInsecureContent: false,
      contextIsolation: true,
      enableBlinkFeatures: '',
      experimentalFeatures: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      preload: '/Applications/Laborer/preview-pick-preload.cjs',
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    })
  })
})
