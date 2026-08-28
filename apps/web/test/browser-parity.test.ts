import { describe, expect, it, vi } from 'vitest'
import { openFileInBrowser } from '@/components/files/open-file-in-browser'
import { mergePreviewServers } from '@/components/preview/preview-empty-state-logic'

describe('Files to Browser', () => {
  it('mints an asset URL before opening and selecting a distinct preview tab', async () => {
    const createAssetUrl = vi.fn(async () => ({
      relativeUrl: '/api/workspace-assets/token/index.html',
    }))
    const openPreview = vi.fn(async () => ({ tabId: 'tab-2' }))

    await expect(
      openFileInBrowser({
        baseUrl: 'http://127.0.0.1:2100/app',
        createAssetUrl,
        openPreview,
        relativePath: 'docs/index.html',
        workspaceId: 'workspace-1',
      })
    ).resolves.toEqual({
      preview: { tabId: 'tab-2' },
      url: 'http://127.0.0.1:2100/api/workspace-assets/token/index.html',
    })
    expect(createAssetUrl).toHaveBeenCalledWith({
      relativePath: 'docs/index.html',
      workspaceId: 'workspace-1',
    })
    expect(openPreview).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:2100/api/workspace-assets/token/index.html',
      workspaceId: 'workspace-1',
    })
  })
})

describe('Browser empty state', () => {
  it('deduplicates loopback aliases and orders configured live servers first', () => {
    const servers = mergePreviewServers(
      [
        {
          host: 'localhost',
          pid: 2,
          port: 3000,
          processName: 'next',
          terminal: null,
          url: 'http://localhost:3000',
        },
        {
          host: 'localhost',
          pid: 1,
          port: 5173,
          processName: 'vite',
          terminal: null,
          url: 'http://localhost:5173',
        },
        {
          host: 'localhost',
          pid: 3,
          port: 8080,
          processName: 'other',
          terminal: null,
          url: 'http://localhost:8080',
        },
      ],
      [
        'http://127.0.0.1:5173/docs',
        'http://localhost:5173/duplicate',
        'http://localhost:3000/admin',
      ]
    )

    expect(
      servers.map(({ port, requestedUrl, source }) => ({
        port,
        requestedUrl,
        source,
      }))
    ).toEqual([
      {
        port: 3000,
        requestedUrl: 'http://localhost:3000/admin',
        source: 'configured',
      },
      {
        port: 5173,
        requestedUrl: 'http://127.0.0.1:5173/docs',
        source: 'configured',
      },
      { port: 8080, requestedUrl: 'http://localhost:8080', source: 'scanner' },
    ])
  })
})
